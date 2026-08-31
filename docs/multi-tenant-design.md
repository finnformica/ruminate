# Multi-tenant design

Status: **design only** — nothing here is built. This document designs the
path from today's single-owner instance (one D1, one permitted GitHub id,
fail-closed) to a product where each signed-up user has their own private
corpus. It extends [graph-storage.md](./graph-storage.md) and
[graph-schema-v2.md](./graph-schema-v2.md), and coordinates with
[event-sourcing-design.md](https://github.com/finnformica/ruminate/blob/claude/event-sourcing-design/docs/event-sourcing-design.md)
(branch `claude/event-sourcing-design`) without building any of it.

**Recommendation, up front: one SQLite-backed Durable Object per user for the
corpus, plus a small control-plane D1 for identity.** The DO is addressed by
the _verified_ GitHub id, so tenant isolation is placement, not filtering —
there is no query that could return another user's rows. The corpus schema
(`migrations/0002_nodes.sql`) and the replica wire format
(`worker/handlers/replica-payload.ts`) move unchanged; the client changes not
at all. The shared-D1-with-a-tenant-column option loses on isolation and on
throughput; the D1-per-tenant option loses on provisioning (dynamic bindings
don't exist). D1/SQLite has no RLS to reach for — SQLite omits `GRANT`/
`REVOKE` entirely because it has no concept of database users
([sqlite.org/omitted.html](https://www.sqlite.org/omitted.html)) — so "RLS or
a tenant column" is really "app-enforced filtering or structural isolation",
and structural wins.

## 1. Where tenancy lives today

Single-tenancy is currently enforced in exactly one place, and it is airtight
for n=1:

- `requireSession` (`worker/handlers/replica.ts:50-77`) checks the
  `gh_refresh` HttpOnly cookie, verifies the Bearer token against
  `GET https://api.github.com/user`, and then requires the verified numeric id
  to equal `ALLOWED_GITHUB_ID` (`wrangler.jsonc:43`), failing **closed** when
  unconfigured (`replica.ts:70`). Any other valid GitHub account gets 403.
- The one D1 database (`Env.DB`, `worker/types.ts:12-19`; binding in
  `wrangler.jsonc:24-31`) therefore only ever holds the owner's rows. The
  schema has no tenant column because the deployment _is_ the tenant.
- The client already derives identity correctly: the OAuth callback captures
  the numeric id (`worker/handlers/github-auth.ts:49-57`), and the local OPFS
  cache is owner-bound — a different account signing in on the same browser
  wipes the cache before anything renders (`src/data/database-mode.ts:52-57`
  and `:250-265`, driven by `src/data/use-database-mode.ts:31-43`, which
  prefers the stable id over the mutable login).

Multi-tenancy means replacing "the deployment is the tenant" with "the
_verified identity_ names the tenant" — everything else should survive.

## 2. Option analysis

### Verified platform limits (checked 2026-08 against current Cloudflare docs)

| Fact                              | Value                                                                                               | Source                                                                                                   |
| --------------------------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| SQLite storage per Durable Object | 10 GB (Paid); 5 GB account-wide on Free                                                             | [DO limits](https://developers.cloudflare.com/durable-objects/platform/limits/)                          |
| Durable Objects per namespace     | Unlimited                                                                                           | [DO limits](https://developers.cloudflare.com/durable-objects/platform/limits/)                          |
| DO pricing (Paid)                 | 1M requests incl. then $0.15/M; 400k GB-s duration incl. then $12.50/M GB-s                         | [DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)                        |
| DO SQLite storage billing         | 25B rows read incl. then $0.001/M; 50M rows written incl. then $1/M; 5 GB-mo incl. then $0.20/GB-mo | [DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)                        |
| SQLite DOs on the Free plan       | Yes — 100k requests/day, 13k GB-s/day                                                               | [DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)                        |
| DO idle behavior                  | Hibernation after ~10 s when eligible; eviction after 70–140 s idle otherwise; constructor reruns   | [DO lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/)     |
| DO cold-start latency             | No number published; storage is in-thread ("zero-latency") once resident                            | [Cloudflare blog](https://blog.cloudflare.com/sqlite-in-durable-objects/)                                |
| Wrangler DO migrations            | Class-level only (`new_sqlite_classes` etc.); no SQL schema runner; backend immutable per class     | [DO migrations](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/) |
| DO SQL API                        | Synchronous `sql.exec`, `databaseSize`, 30-day point-in-time recovery via bookmarks                 | [SqlStorage API](https://developers.cloudflare.com/durable-objects/api/sql-storage/)                     |
| D1 max database size              | 10 GB (Paid) / 500 MB (Free)                                                                        | [D1 limits](https://developers.cloudflare.com/d1/platform/limits/)                                       |
| D1 databases per account          | 50,000 (Paid) / 10 (Free); ~5,000 bindings per Worker (1 MB script-metadata cap)                    | [D1 limits](https://developers.cloudflare.com/d1/platform/limits/)                                       |
| D1 concurrency                    | Single-threaded per database; per-tenant scale-out is the documented design intent                  | [D1 limits](https://developers.cloudflare.com/d1/platform/limits/)                                       |
| Dynamic (non-binding) D1 access   | Not supported at runtime — only Workers-API redeploys with updated bindings, or the slow REST API   | [workerd #3564](https://github.com/cloudflare/workerd/discussions/3564)                                  |
| D1 storage billing                | $0.75/GB-mo past 5 GB (rows priced as DO SQLite)                                                    | [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)                                     |
| Workers Paid base                 | $5/month                                                                                            | [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)                           |

Cloudflare's own SaaS guidance lists both per-tenant databases and shared-DB
row-level isolation without prescribing one
([data isolation use case](https://developers.cloudflare.com/use-cases/saas/data-isolation));
the choice below is ours to argue.

### (a) Shared D1 + tenant column

Add `tenant_id INTEGER` to `nodes` and `link`, widen every primary key and
index to lead with it, and scope every query.

- **Isolation: filtered, not structural.** Every statement in
  `replica-payload.ts`'s planner and every read in `replica.ts` must carry
  `WHERE tenant_id = ?`. One omission leaks — and this app has a
  wide-surface read: the since-pull returns the **full key list of both
  tables** for deletion-by-absence (`replica.ts:147-158`). Forget the filter
  there and every user's node ids ship to every other user; worse, the
  client _deletes local rows absent from the list_ (`d1-note-source.ts:
planPullApplication`), so a filtering bug can silently destroy data, not
  just disclose it.
- **Schema damage.** `nodes.id` is a global TEXT PK of client-minted `blk_`
  ids (`migrations/0002_nodes.sql:12-19`). Two users can legitimately mint
  the same id, so the PK must become `(tenant_id, id)`, the link table's
  composite PK and both its indexes must widen, and the wire format grows a
  dimension the client never needed. The one-dialect/two-engines discipline
  breaks: the local store is single-tenant and doesn't want the column.
- **Throughput and blast radius.** One D1 database is single-threaded
  ([D1 limits](https://developers.cloudflare.com/d1/platform/limits/)):
  every user's pushes and full-corpus pulls serialize on one queue, and the
  10 GB cap is shared. One corrupted migration or one bad `db.batch` is
  everyone's outage. The since-pull's key-list scans become
  O(total-corpus-of-all-users) per request.
- **Cost:** cheapest at every scale (rows only, no duration) — until the
  single database hits its throughput or size wall and needs sharding, which
  is this whole design again but under load.

### (b) D1 database per tenant

Structurally isolated, schema unchanged — but you cannot get at the
databases. Worker bindings are static: creating a tenant means calling the
Cloudflare REST API to create a database and then **redeploying the Worker**
with an updated binding list
([workerd #3564](https://github.com/cloudflare/workerd/discussions/3564)),
capped at roughly 5,000 bindings by the 1 MB script-metadata limit
([D1 limits](https://developers.cloudflare.com/d1/platform/limits/)). Signup
becomes a deploy pipeline; migrations become `apply` × N databases of ops
scripting; local dev with wrangler can't simulate the fleet. The per-tenant
isolation is real and the account allows 50,000 databases, but until
Cloudflare ships runtime binding this is an ops program, not a feature.

### (c) Durable Object per user + control-plane D1 — **recommended**

One `CorpusDO` class; each user's corpus lives in the private SQLite database
of the object addressed by `idFromName(String(verifiedGithubId))`.

- **Isolation: structural.** The handler never holds a connection that can
  see two tenants. Objects are created lazily on first access — signup
  provisions nothing.
- **Schema unchanged.** The DO runs the exact `migrations/*.sql` files the
  local store already imports as raw strings and applies itself
  (`src/data/sql-note-store.ts:1-2,67-86`) — that pattern is proven on a
  second engine today; the DO is merely a third. Wrangler has no SQL
  migration runner for DOs (class-level `new_sqlite_classes` only), so the
  constructor applies the ladder inside `blockConcurrencyWhile`, keyed on
  `meta.schema_version` — per-tenant, automatic, and versioned with the code
  that reads it.
- **Fit with the replica protocol.** `parseReplicaPayload` / `planReplicaPut`
  are pure and emit parameterized statements; today a thin shell binds them
  to `db.batch` (`replica.ts:179-183`). The DO shell binds them to
  `sql.exec` instead — synchronous, implicitly transactional per request via
  the DO's input/output gates. The per-tenant cursor needs no design at all:
  `meta.replica_cursor` is a table row, and the whole meta table travels
  with the corpus.
- **Fit with the op-log future.** The one thing
  event-sourcing-design.md's log needs from the server is single-threaded
  sequence assignment. A DO _is_ a single-threaded sequencer, scoped to
  exactly the right unit (one user's corpus) — and later, a push channel
  (WebSockets with hibernation) attaches to the same object. This is left as
  the seam it is; the log itself stays reserved.
- **Per-tenant ops for free:** `databaseSize` and row counters make
  per-tenant metering trivial, and 30-day point-in-time recovery is built
  into every object
  ([SqlStorage API](https://developers.cloudflare.com/durable-objects/api/sql-storage/)) —
  a per-user restore story neither D1 option gives at tenant granularity.
- **Honest costs.** (1) DOs bill _duration_ while resident: a
  request/response object stays in memory ~70–140 s after its last request,
  so an hour-long editing session with steady autosaves keeps one object
  resident ≈ 1 h ≈ 460 GB-s (128 MB × 3600 s). (2) Cold starts: Cloudflare
  publishes no latency number; the first request after idle pays object
  wake + constructor, so the constructor must stay cheap (schema-version
  check, DDL only on mismatch). (3) A second storage engine to trust —
  though the sqlite-wasm store already broke the "D1 is the only other
  engine" symmetry.

### Scorecard

| Criterion              | (a) shared D1 + column                       | (b) D1 per tenant              | (c) DO per user + control D1       |
| ---------------------- | -------------------------------------------- | ------------------------------ | ---------------------------------- |
| Isolation strength     | Filtered — leak/destroy by omission          | Structural                     | **Structural**                     |
| Blast radius of a bug  | All tenants                                  | One tenant                     | **One tenant**                     |
| Provisioning a tenant  | Row insert                                   | API call + Worker redeploy     | **Nothing (lazy on first access)** |
| Schema migration story | One `apply`, but schema must gain tenant dim | `apply` × N databases          | Constructor ladder, per object     |
| Replica protocol fit   | Wire format grows tenant dimension           | Unchanged                      | **Unchanged**                      |
| Op-log future          | Global serialization, wrong scope            | Per-DB, but binding wall first | **Per-user sequencer, natural**    |
| Cost @ 1 user          | ~$0 (+$5 Paid)                               | ~$0 (+$5 Paid)                 | ~$0 (+$5 Paid; runs on Free too)   |
| Cost @ 100 users       | ~$0                                          | ~$0, heavy ops                 | ~$5–10/mo duration                 |
| Cost @ 10k users       | Not viable (10 GB cap, one write queue)      | Binding cap ~5k; ops program   | ~$100s/mo (≈ $0.1/active user)     |

At 10k users, (a) has already failed structurally and (b) has hit the binding
cap; (c)'s duration bill (~pennies per active user-month) is the only cost
that scales _with_ the product instead of against it.

## 3. Identity and the control plane

**Tenant key: the verified GitHub numeric id.** It is a stable integer
(logins are user-renameable; the code already prefers the id —
`use-database-mode.ts:31-39`), it is already captured at OAuth
(`github-auth.ts:49-57`), and it is already what `ALLOWED_GITHUB_ID` matches
against.

**Control-plane D1** — the existing `ruminate` database, kept, holding
identity and flags instead of the corpus:

```sql
CREATE TABLE users (
  github_id  INTEGER PRIMARY KEY,  -- the tenant key
  login      TEXT NOT NULL,        -- display/debug only, never an address
  name       TEXT,
  status     TEXT NOT NULL DEFAULT 'active',  -- 'active' | 'blocked'
  created_at INTEGER NOT NULL,     -- ms epoch — attribution lives HERE (§7)
  created_by TEXT NOT NULL DEFAULT 'signup',  -- 'signup' | 'allowlist' | 'admin'
  last_seen_at INTEGER
);

CREATE TABLE allowlist (
  github_id INTEGER PRIMARY KEY,   -- pre-approved ids while signups are gated
  note TEXT
);
```

**Signup flow.** A `SIGNUP_MODE` var (`'allowlist'` initially, `'open'`
later, absent = fail closed, preserving `replica.ts:70`'s spirit) decides
what happens when a verified id has no `users` row: allowlist mode consults
the `allowlist` table (seeded with `42536816` — `ALLOWED_GITHUB_ID` retires
into it); open mode inserts the row on first authenticated request. A
`status = 'blocked'` row always 403s. There is no separate signup screen —
signing in _is_ signing up, exactly like today.

**`requireSession` generalizes; it does not change shape.** Today: verify
cookie + token, then compare the verified id to a constant. Tomorrow: verify
cookie + token, then resolve the verified id against the control plane and
**derive the tenant address from that verified id** — never from a header,
path, query param, or body. The client cannot name a tenant; it can only be
one. The GitHub `GET /user` round-trip per request, tolerable at n=1, should
now be cached in `caches.default` keyed by a token hash with a short TTL
(graph-storage.md already reserves exactly this).

## 4. Data plane

```
Browser ──(gh_refresh cookie + Authorization: Bearer)──▶ Worker /api/replica/*
  Worker: requireSession
    1. cookie present?                      (else 401)
    2. GET api.github.com/user with token   (cached; else 401)
    3. users row for verified id? status?   (control D1; else 403/signup)
  Worker: env.CORPUS.idFromName(String(verifiedId)) ──▶ CorpusDO stub
    stub.pull(since) / stub.put(payload) / stub.status()
  CorpusDO: constructor ran migrations 0001+0002 (blockConcurrencyWhile,
    keyed on meta.schema_version); methods run planReplicaPut /
    the pull queries via this.ctx.storage.sql.exec
```

- **Routes are unchanged** (`worker/index.ts:24` keeps
  `/api/replica/*` → `replica`); `replica.ts` shrinks to auth + dispatch,
  and the SQL halves of `replicaPull`/`replicaPut`/`replicaStatus` move into
  `CorpusDO` methods (RPC, not stub-fetch — typed, and no URL re-parsing).
  `parseReplicaPayload`, `planReplicaPut`, and every wire type in
  `replica-payload.ts` stay shared with the client exactly as now.
- **wrangler.jsonc** gains the class:
  `"durable_objects": { "bindings": [{ "name": "CORPUS", "class_name": "CorpusDO" }] }`
  plus `"migrations": [{ "tag": "v1", "new_sqlite_classes": ["CorpusDO"] }]`
  (class-level; the SQL ladder is the constructor's job — see the verified
  limits table).
- **Per-tenant corpus schema/migrations:** the DO imports
  `migrations/0001_init.sql?raw` + `0002_nodes.sql?raw` — the same import
  the local store performs (`sql-note-store.ts:1-2`) — and applies the same
  empty/versioned/reset ladder (`openSqlNoteStore`,
  `sql-note-store.ts:70-86`). One dialect, three engines, one set of files.
- **Per-tenant cursor:** `meta.replica_cursor` inside each DO; the client's
  `d1_pull_cursor` stays local per device. No protocol change.

**The invariant that makes cross-tenant access structurally impossible:**
_the only data capability request-handling code ever holds is a stub whose
address was derived from the verified identity._ There is no shared
connection, no tenant column to forget, no query whose result set could span
tenants — the wrong-tenant query is not risky, it is **unrepresentable**.
(For contrast, option (a)'s substitute is a discipline: a tenant-scoped
repository object constructed once per request from the verified id, the raw
`D1Database` handle never exported past it, plus standing adversarial tests
that drive every endpoint with tenant A's session against seeded tenant-B
rows and assert zero visibility — including the key-list deletion channel,
where a leak _deletes_ B's data on A's devices. That machinery is the price
of (a); (c) makes it unnecessary.)

## 5. Client impact

Nothing changes — not even the URL. The push side posts to
`/api/replica/notes` and `/api/replica/status` (`replica-sync.ts:297,311`),
the pull side gets the same paths (`d1-note-source.ts:88,94`), and both
already send exactly the credentials the new `requireSession` needs
(`d1-note-source.ts:65-84`). The tenant is inferred server-side from those
credentials, so no client code learns about tenancy.

- **Local cache owner-binding: already done.** `database-mode.ts:250-265`
  wipes the OPFS store when the signed-in identity differs from
  `store_owner` — precisely the client half of multi-tenancy, shipped.
- **Multi-account on one device** works today with the wipe-and-repull
  semantics (switching accounts costs a full pull). If that ever grates, the
  upgrade is per-owner OPFS database filenames instead of a wipe — a local
  nicety, invisible to the protocol.
- Copy for the single-user 403 ("owner_not_configured") becomes
  signup-gate copy ("Ruminate is invite-only right now"). That is the whole
  UI diff.

## 6. Migration path (today's D1 → tenant #1)

Every step deploys alone and reverses alone; the client is untouched
throughout, so the in-flight features — write-through autosave, mirroring /
paste-as-link, cross-note block resolution — never notice (they live in the
local store and the wire format, both frozen here; and mirrored `blk_` ids
only ever resolve within one corpus, so tenancy cannot dangle a mirror).

1. **Control plane (additive).** D1 migration `0003_users.sql` adds
   `users` + `allowlist` (corpus tables untouched); `requireSession` still
   matches `ALLOWED_GITHUB_ID`. _Revert: drop the tables._
2. **Ship `CorpusDO`, dark.** Class + wrangler migration deployed, no route
   uses it. _Revert: remove the class._
3. **Backfill tenant #1.** An owner-authed admin route (or script) reads the
   full corpus from D1 (`replicaPull` full mode) and PUTs it into the
   owner's DO via the same shared payload planner; verify with
   `status` counts on both sides plus the existing rollup-equivalence check
   (`scripts/rollup-equivalence.ts`). _Revert: the DO is a copy; ignore it._
4. **Flip the data plane.** `replica.ts` routes to the DO derived from the
   verified id. D1's corpus tables stop being written but keep their data.
   _Revert: route back to D1 and re-push from any client (the "Push full
   copy" repair action already exists) — one flag, minutes._
5. **Open the gate.** `SIGNUP_MODE=allowlist`, `ALLOWED_GITHUB_ID` retired
   into the allowlist row; later `open`. _Revert: flip the var back._
6. **Tidy (much later).** Drop corpus tables from the control-plane D1 once
   step 4 has soaked.

## 7. Attribution: created_by / updated_by

The user's question — "or just have a created_by and updated_by column in
each table" — conflates two things this design keeps apart:

- **Tenancy** is _who may touch this row at all_. A `created_by` column
  answers that only if every query filters on it, which is option (a) and
  its leak-by-omission risk. Attribution columns are data; tenancy must be a
  capability.
- **Attribution** is _who did this_, and it matters only when more than one
  identity can write the same corpus. Today that is never true: inside a
  single-tenant DO, `created_by` would be a constant column equal to the
  tenant key. So attribution lands in the **control plane now**
  (`users.created_at` / `created_by` above — who joined, how, when), and
  per-row `created_by`/`updated_by` waits for collaboration. When it comes,
  the better substrate already exists on paper: the op log's
  `device_id`/`session_id` per event (event-sourcing-design.md §3) — a
  per-row column pair is the impoverished version of that and would be
  superseded by it.

## 8. Explicitly out of scope

**Collaboration/sharing.** Not designed here. The architecture leaves room:
a share is a _grant in the control plane_ (who may reach which corpus, at
what rights) plus a second address the data plane may derive — cross-DO
reads via RPC, or a shared-corpus DO whose members' verified ids all map to
it. Because addressing is already "verified id → DO id", generalizing to
"verified id → set of permitted DO ids" is a lookup, not a rearchitecture.
Per-row attribution (§7) and the op log arrive in the same season.

**Billing.** Not designed here. The `users` row is where a plan/quota flag
goes; per-tenant metering is already measurable (`databaseSize`, rows
read/written per object), so enforcement is a check in `requireSession`'s
resolve step — no schema archaeology later.

## 9. The honest counter-case

At Finn's actual scale — one user, possibly a handful of invited friends —
the strongest argument is for **shared D1 + user_id column, or even for doing
nothing**. `ALLOWED_GITHUB_ID` is a complete, correct, fail-closed tenancy
system for n=1, with zero moving parts. If two or three trusted friends
wanted in tomorrow, a `tenant_id` column and disciplined `WHERE` clauses
would hold their weight for months, cost nothing, keep the familiar
`wrangler d1 migrations apply` loop, and require no new runtime concepts —
and the leak-by-omission risk is a real but _small_ surface here (one
handler file), guarded by tests, among users who trust each other. The
counter-counter is that (a)'s schema damage (tenant-scoped PKs, wire-format
changes) is _rework the DO path never does_ — the cheap option is only cheap
if it is never outgrown.

**The earliest trigger for doing any of this** is the first moment a second
GitHub id must be allowed through `requireSession` — before that, this
document should stay a document. When that moment comes, steps 1–4 of §6 are
roughly a week, and nothing in the current branch has to be undone: the
schema, the wire format, the client, and the owner-bound local cache all
carry forward as-is.

## Sources

- [DO limits](https://developers.cloudflare.com/durable-objects/platform/limits/) ·
  [DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) ·
  [DO lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/) ·
  [DO class migrations](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/) ·
  [SqlStorage API](https://developers.cloudflare.com/durable-objects/api/sql-storage/) ·
  [DO storage best practices](https://developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage/)
- [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) ·
  [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) ·
  [dynamic D1 bindings discussion (workerd #3564)](https://github.com/cloudflare/workerd/discussions/3564)
- [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) ·
  [SaaS data isolation](https://developers.cloudflare.com/use-cases/saas/data-isolation) ·
  [Zero-latency SQLite in Durable Objects](https://blog.cloudflare.com/sqlite-in-durable-objects/)
- [SQLite omitted features (no GRANT/REVOKE → no RLS)](https://www.sqlite.org/omitted.html)
