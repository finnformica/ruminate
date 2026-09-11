# Multi-tenant design

Status: **what runs is §0** — shared D1 with a tenant column. This document
originally recommended a Durable Object per user; that design was built
(PR #15) and reversed. Its option analysis, data plane, migration path and
counter-case have been removed from this copy (they are in git history), so
section numbers have gaps. What still stands is §0's decision and runbook,
§1's starting point, §3's control plane, §5's "the client learns nothing",
§7's attribution argument, §8's scope, and §10's portability requirement.

This document designed the path from the single-owner instance (one D1, one
permitted GitHub id, fail-closed) to a product where each signed-up user has
their own private corpus. It extends [graph-storage.md](./graph-storage.md)
and [graph-schema-v2.md](./graph-schema-v2.md).

## 0. Decision reversal (2026-W36): D1 with tenant columns

**Decision: the corpus moves back into D1, scoped by a `user_id` column —
option (a) — and the Durable Objects are retired.** Migration
`0004_tenant_columns.sql` rebuilds `nodes`, `link`, and `meta` with `user_id`
leading every primary key and index; `worker/tenancy-db.ts` is the only module
that touches the binding.

**The reason is data visibility, and it is a good one.** The D1 dashboard has
a console: the owner can open his corpus, run a query, and see what is
actually stored — which is how you diagnose a sync bug, confirm a migration
did what it claimed, or answer "where did that block go?". A Durable Object's
SQLite database has no such browser. Nothing in §2 measured that, because §2
was reasoning about isolation, throughput and cost, and this is a property of
the _operator's_ experience rather than the system's. For a single-developer
product where the developer is also the on-call engineer and the first user,
being able to look at the data is not a nice-to-have; it is the difference
between debugging and guessing. The DO design made the data correct and
unobservable. That trade was wrong for this product at this size.

**What is being given up, stated plainly.** §2(a) is right that column-scoped
tenancy is _filtered_, not structural: the wrong-tenant query stops being
unrepresentable and becomes merely forbidden. §2 also names the specific
danger, and it is not disclosure — it is destruction. At the time of writing
the since-pull returned the full key list of both tables and the client
deleted local rows absent from it (`planPullApplication`), so a missing
`WHERE` on that one read would have told every user's client to delete every
note it holds. **That channel is now gone** (§0, "Dropping the since-pull key
lists"): deletions travel as tombstoned rows, and a pull that says nothing
about a row means it is unchanged. The remaining risk is disclosure rather
than destruction — smaller, but the mitigations below are what keep it small,
and this section stays so nobody mistakes their absence for an oversight.

**The price paid for the trade — four structural mitigations, all shipped.**
§4's parenthetical listed exactly what option (a) would owe; this is that
bill, paid:

1. **A tenant-scoped repository, minted once from the verified id.**
   `forTenant(driver, identity)` in `worker/tenancy-db.ts` is the only mint on
   the request path, and it takes `VerifiedIdentity` — the type only
   `requireSession` produces. Handlers and planners receive a `TenantDb`; the
   raw `D1Database` handle is never exported past that module.
2. **The tenant id is bound, not passed.** Statements name their tenant with
   the token `:tenant`, which `TenantDb` rewrites to a positional placeholder
   and fills with the verified id. There is no parameter a caller could put a
   user id into, so "forgot to pass the right tenant" is not a mistake the API
   can express.
3. **A runtime guard that refuses unscoped statements.** Any statement
   touching `nodes`/`link`/`meta` without `user_id` + `:tenant` throws before
   it reaches the database; so does a read of `nodes`/`link` that says nothing
   about tombstones, and any `DELETE` from them. The opt-outs are narrow and
   greppable: `includingDeleted()` for replication/trash/audit reads,
   `-- tenant-exempt: <reason>` for the rare statement with no tenant to name,
   and `controlPlaneDriver` for `users`/`allowlist`, which are deliberately
   not tenant data (the tenancy resolver has to look up an id that is not yet
   a tenant).
4. **A CI gate with the same rules.** `npm run check:queries`
   (`scripts/check-queries.ts`) scans every SQL string literal in `worker/**`
   and `src/data/**` and fails the build on a violation, and bans `env.DB`
   outside the tenancy module. Runtime and CI share one implementation
   (`src/data/sql-tenancy-guard.ts`) so they cannot drift, and that module has
   its own unit tests fed both violating and compliant samples.

Plus the standing adversarial suite §4 asked for: `replica.test.ts` drives
every endpoint with tenant A's session against seeded tenant-B rows and
asserts zero visibility — the full pull, the since-pull, and the status
counts. The pull assertions are exhaustive (`toEqual` on the whole body), not
merely "no B rows in `nodes`": a since-pull now carries rows and a cursor and
nothing else, so anything of B's appearing anywhere in it is a failure.

**What survives untouched.** The control plane (§3) is unchanged — `users`,
`allowlist`, `SIGNUP_MODE`, the `ALLOWED_GITHUB_ID` fail-closed bootstrap, and
`requireSession`'s verification. The client (§5) still learns nothing: same
URLs, same payloads, tenancy inferred server-side from credentials. §10's
portability requirement holds and is arguably better served — the corpus
queries still run through the `SqlDriver` seam, the planners are still pure,
and there is now no Cloudflare-proprietary runtime primitive in the data path
at all.

**What §2's scorecard would say now.** Its throughput and blast-radius
objections to (a) are unchanged and unanswered: one D1 database is
single-threaded, the 10 GB cap is shared, and the key-list scans are
O(all-tenants) per since-pull. At today's scale (one user, a handful of
friends) none of that binds, which is precisely what §9's honest counter-case
argued. The rework §9 warned of — tenant-scoped primary keys, widened indexes
— is exactly what `0004` does, and it was a day's work, not a rewrite. If the
throughput wall is ever reached, §2(c) is still on the shelf and the
`SqlDriver` seam is still the thing that makes moving cheap.

### Deploy-day runbook (DO → D1)

Live corpora exist inside the DOs, so the class must outlive the import: a
`deleted_classes` wrangler migration deletes an object's _storage_ along with
its class ([DO class migrations](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/)),
which would destroy the data being rescued.

1. `npx wrangler d1 migrations apply ruminate --remote` — `0004` rebuilds the
   corpus tables with `user_id` + `deleted_at` and stamps the owner's existing
   (pre-DO) rows with `ALLOWED_GITHUB_ID`. Reversible only by restore, so take
   the D1 backup first.
2. Deploy **with both bindings** — `DB` and the (now read-only) `CORPUS`.
3. The import runs itself: the first request each signed-in user makes copies
   their DO rows into their D1 partition, in `merge` mode, before anything is
   served (`readyTenant` → `importDoCorpus`). Merging is LWW through the same
   planner a push uses, so it can only replace a row with a not-older one and
   never deletes. Each tenant is marked done in their own `meta`
   (`do_import_at`), so it happens once.
   - The lazy import is what stops the owner's first since-pull answering from
     the stale pre-DO snapshot and telling their client to delete every note
     written during the DO era. It is the reason this step is automatic rather
     than a button.
4. `POST /api/admin/import-do-corpus?merge=1` (owner-only) runs the same
   import across the owner plus every id in `users`, and reports per-user
   results — the deliberate, observable way to sweep up anyone who has not
   signed in since the deploy. Add `?force=1` to re-run a marked tenant.
5. Verify: `GET /api/replica/status` per user, plus a D1 console query —
   `SELECT user_id, COUNT(*) FROM nodes WHERE deleted_at IS NULL GROUP BY 1`.
   This is the step the whole reversal was for.
6. **Done (2026-09-02):** `worker/corpus-do.ts`,
   `worker/handlers/corpus-migration.ts`, the admin import endpoint and the
   `CORPUS` binding are deleted, and
   `{ "tag": "v2", "deleted_classes": ["UserCorpus"] }` is in wrangler.jsonc's
   `migrations` — deploying it tears the class down and reclaims its storage.
   **That deploy is irreversible**: any corpus still held only in a Durable
   Object is destroyed with it, so every signed-up user's rows must exist in
   D1 first.

### Follow-ups this reversal defers

- **Purge / GC of tombstoned rows.** Out of scope by decision: there is not
  enough data for it to matter yet. Tombstones accumulate, and a full pull
  currently ships them to a fresh device. When it does matter, purge is a
  scheduled `DELETE` past a retention window. Note that with the key lists
  gone (below) a purge is no longer something a client can be told about: it
  would need a cache-generation bump, or a retention window long enough that
  no live client can still be holding the row.
- **Dropping the since-pull key lists — DONE (2026-09).** Tombstones made
  deletion-by-absence redundant, and the lists were the widest read in the
  system: O(corpus) rows on every pull, on every focus, visibility change and
  `online` event. They are gone, which closes §2's destructive channel by
  construction — a pull now carries changed rows and a cursor, nothing else.
  Because rows hard-deleted _before_ tombstones existed left nothing behind to
  propagate, the change shipped with a `CACHE_GENERATION` bump: every device
  discards its local copy once and re-pulls clean (docs/graph-storage.md).
- **Restore UI.** The data supports it (every row a single delete retires
  shares one `deleted_at`, so a restore is "revive the rows stamped at T", and
  links to deleted nodes are retained so the revived node comes back where it
  was). Nothing surfaces it yet.
- **Retiring the delete-as-unlink-plus-rescue rule.** Untouched here on
  purpose: soft deletes change what happens to the rows, not what the user
  sees. Whether rescue is still the right behavior once deletes are
  recoverable is a separate decision.

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
  `device_id`/`session_id` per event (an op log, if one is ever built) — a
  per-row column pair is the impoverished version of that and would be
  superseded by it.

## 8. Explicitly out of scope

**Collaboration/sharing.** Not designed here, but the shape is decided
(discussed 2026-08-31): **the shareable unit is a space, not a row.** A
shared space is simply another corpus — another SQLite DO (`space:<uuid>`),
same schema, same replica protocol — with a membership table in the control
plane (`space_id, user_id, role`) consulted between `requireSession` and
routing. The client already syncs a corpus; syncing your own plus your
spaces is the same loop with more URLs, and per-row LWW is writer-agnostic
(two people converge exactly like two devices). "Share this block" =
promote the subtree into a space (the existing link/rescue machinery,
pointed across a boundary); cross-space references are pointer links
resolved at read, allowed to dangle without access — consistent with how
links already behave. This is the granularity shipping products converge on
(Notion shares pages, Figma shares files): live row-level sharing out of
personal silos is the hard version in every architecture — and in the
tenant-column design it is worse, since deletion-by-absence sync would need
per-viewer id lists (§2's destruction risk, made combinatorial). Two things
arrive for free: per-row attribution (§7) belongs in space rows, and a DO
per space is the multiplayer primitive (single-threaded sequencer +
WebSockets) the op log and any future live collaboration want. Because
addressing is already "verified id → DO id", generalizing to "verified id →
set of permitted DO ids" is a lookup, not a rearchitecture.

Sharing needs a **second primitive** beside spaces (discussed 2026-08-31):
the **scoped grant** — a control-plane row `(grantee, owner, root_node_id,
rights, expiry)` where the grantee is a user or a revocable capability
token (the agent case: "a slice of the graph an agent can access without
full access"). A space is a residence change; a grant is a _view_: the data
never moves. The slice is the reachability closure downstream of the
granted root, computed **inside the owner's DO on every request** — so it
is live by construction (new blocks under the section join the slice
automatically), least-privilege by construction (ids outside the closure
are never serialized; the grantee cannot even name them), and the sync
protocol generalizes for free (a slice pull returns the closure's id list
for deletion-by-absence — same wire format, smaller universe). Phase
read-only slices first; writes need a boundary rule (every containment
path of a written node stays inside the closure — the same walk the cycle
guard already does). One semantic to surface in UI: a multi-parent block
reachable under the shared section is in the slice even if it also lives
somewhere private — correct by the model, but the owner should see "this
share includes N blocks also used elsewhere" when granting. This feature
entrenches the DO choice: it needs a consistent reachability walk colocated
with live data; on shared D1 it becomes recursive CTEs with per-grantee
authz and per-viewer deletion-by-absence lists — §2's risk, compounded.

**Billing.** Not designed here. The `users` row is where a plan/quota flag
goes; per-tenant metering is already measurable (`databaseSize`, rows
read/written per object), so enforcement is a check in `requireSession`'s
resolve step — no schema archaeology later.

## 10. Portability: what leaving Cloudflare would cost

Lock-in is real but thin, and it is a design REQUIREMENT of this plan that it
stays thin. The split:

**Cloudflare-proprietary:** the `DurableObject` runtime primitive
(`ctx.storage.sql`, `idFromName` addressing) and the operational features
(placement, hibernation, per-object point-in-time recovery). Hosting
features, not application code.

**Platform-neutral (most of the system):** the corpus schema is plain SQLite
DDL that already runs on three engines (browser sqlite-wasm, `node:sqlite`
in tests, D1); the replica planners (`worker/handlers/replica-payload.ts`)
are pure functions; the wire format is HTTP+JSON; the client knows only
URLs; per-user export is `getAllRows()` behind an endpoint.

**The requirement that keeps exit cheap:** the DO class must be a thin shell
over the existing `SqlDriver` seam — the same interface that lets
`sql-note-store.ts` run unchanged on two engines today. The DO becomes the
third driver (~50–100 lines); every query and planner stays
platform-neutral. Total Cloudflare-specific surface: one adapter class, one
routing line, one wrangler stanza — roughly 150–200 lines. Leaving means
writing driver #4.

**Landing zones if we ever leave:** the one-SQLite-database-per-user,
single-writer-per-user architecture is not a Cloudflare idea. It maps
directly onto Turso/libSQL (database-per-tenant is their core product), any
VPS or Fly.io with per-user SQLite files + Litestream for durability, or a
consolidation into Postgres with real RLS (per-user rows import
mechanically; there the filtered model finally has the database enforcing
it). For fairness: the shared-D1 column design consolidates into a single
Postgres marginally more conventionally — but it buys that hypothetical
convenience by carrying §2's leak-by-omission (here: data-destruction) risk
for the entire time we are on it.

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
