# MCP rate limiting

**Status: built (2026-09).** Both halves: the per-call cost is bounded
(docs/mcp-server.md §4) and the calls themselves are limited per token, with a burst limit
on Cloudflare's rate-limiting binding and a daily one on the token's own row. What is
described below as "what to build" is what was built; the differences are noted in place.

## Why this is the first thing to fix

Two facts multiply badly.

**1. The spec requires it.** The 2026-07-28 tools specification lists, under Security
Considerations, that servers **MUST** "rate limit tool invocations". We do not.

**2. Every tool call read the whole corpus** — `loadSnapshot`
(worker/mcp/graph-access.ts) issued two queries and read every live `nodes` and `link` row
the tenant has, about 1,700 rows. At 1,700 rows a call, D1's 5M-rows-per-day free-tier
budget is gone in roughly **3,000 tool calls**: not an abusive figure, just one agent in
an unlucky loop for an afternoon.

That half is now fixed (see step 1), and a traversal call costs single or double digits
of rows. It changes the arithmetic — the same 5M budget is now millions of calls, not
three thousand — but it does not remove the need for a limit. An unbounded call rate is
still an unbounded bill, `search` is still corpus-wide by nature, and the spec still says
MUST.

This project has already been burned by exactly this shape. From
docs/scaling-thresholds.md: one diagnostics query that scaled with the corpus, running on
an ambient browser event, consumed 6.25M rows in a day — 97% of the account's entire read
volume, from one person taking notes. The lesson recorded there was that the danger is
never a busy app; it is one query whose cost scales with the corpus, called more often
than anyone modelled. An MCP endpoint is that, with the call frequency handed to a model.

## What to build

### 1. Reduce the per-call cost first — **done (2026-09)**

Rate limiting caps the damage; not reading the whole corpus removes most of it. Do this
first, because it changes what the limits need to be.

Built as described below, with two departures worth recording. `read_note` turned out to
be O(**note**) rather than O(depth) — `blockCount` and a note's tags are whole-note facts,
so `depth` bounds what comes back rather than what is read — and `list_parents` is
O(the notes holding the block), because it names those notes and an untitled note's name
is derived from its outline. `list_notes`, which this table did not cover, reads the note
rows and then only the notes on the page. The measured before/after table is in
docs/mcp-server.md §4, and the equivalence argument and its tests are in §4's
"Why this is safe".

`loadSnapshot` is the seam. The tools split cleanly:

| Tool                                         | Needs                                       | Targeted query                  |
| -------------------------------------------- | ------------------------------------------- | ------------------------------- |
| `get_block`, `list_children`, `list_parents` | one node, its child links, its parent links | 3 indexed reads                 |
| `read_note`                                  | the note's subtree to `depth`               | recursive CTE bounded by depth  |
| `search`, `list_tags`                        | all text / all notes                        | genuinely O(corpus)             |
| scope computation (note-scoped grants)       | reachability from granted notes             | CTE seeded at the granted notes |

So the point reads — the ones an agent traversing a graph makes most — become a handful of
indexed rows instead of seventeen hundred. Only `search` and `list_tags` stay corpus-wide,
which is inherent to what they do.

The cost of doing this is the reason it was not done first: the snapshot approach reuses
the app's own pure functions (`noteFromPage`, `reachableFrom`, `basketRootIds`), so an
agent sees exactly what a person sees. Targeted SQL risks becoming a second, drifting
definition of "what the user can see". Mitigate by keeping the snapshot path as the
reference implementation and testing the targeted paths against it — same corpus, same
question, same answer.

### 2. Then limit the calls — **done (2026-09)**

Per **token**, not per user or per IP: the token is the thing a person minted, revoked,
and can reason about, and it is already read on every request. `worker/mcp/rate-limit.ts`.

Two limits, because the failure modes differ, enforced by different machinery for the same
reason they exist separately:

| Limit     | Value              | Where                                                            |
| --------- | ------------------ | ---------------------------------------------------------------- |
| **Burst** | 120 calls / minute | Cloudflare's rate-limiting binding (`MCP_BURST`, wrangler.jsonc) |
| **Daily** | 5,000 calls / day  | `mcp_tokens.calls_day` + `calls_today` (migration 0009)          |

The burst limit is the one a runaway loop hits over and over, so it must be cheaper to
refuse than to answer: the binding costs no database round trip at all. It is checked
**first**, so a loop that trips it never reaches a write.

The daily limit catches what a per-minute limit is blind to — an agent politely making one
call a second all day is inside any burst limit worth having and still makes 86,400 calls.
It is a counter on the token's own row, which the request has already located by hash, so
there is no second table to insert into. Two properties make that affordable:

- **The reset is free.** `calls_day` is the UTC day number stored beside the count, so a
  new day is a different number rather than a swept row. No cron, no expiry.
- **The counter cannot outrun its own limit.** One statement increments and enforces:
  `WHERE … AND (calls_day IS NULL OR calls_day <> ?day OR calls_today < ?limit)`, with
  `RETURNING`. A token that has spent its day matches no row, so nothing is written and
  the empty result IS the refusal. The write cost of the counter is bounded by the limit
  the counter enforces.

`last_used_at` rides along on that same statement, which is why the hourly `touchToken` it
used to need is gone: the write happens anyway, so the stamp may as well be exact.

Calls are counted **before** the work and whatever the outcome. A limiter that only counts
successes is one an agent escapes by failing.

Not built: weighting by cost. A `search` is dearer than a `get_block` now that the point
reads are targeted, but a flat count is most of the value and a weighted one is a second
thing to explain in a refusal message.

### 3. Answer correctly when refusing — **done**

HTTP `429`, with `Retry-After` (the burst window, or the seconds to the next UTC
midnight). In the JSON-RPC body, a **tool execution error** (`isError: true`) rather than
a protocol error — the call was perfectly well formed, so telling a model it was malformed
invites it to rephrase and try again, when the only thing that helps is waiting. The
message says which limit, for how long, and to stop retrying. For `tools/list` and
`server/discover` there is no tool to fail, so those get the JSON-RPC error instead.

The limits are visible to the person, not merely enforced: Settings → MCP access shows
"N of 5,000 calls today" beside each token's `last_used_at`. A limit nobody can see is a
limit nobody can debug.

## Open questions

- Whether an unrestricted token should get a higher limit than a note-scoped one. Probably
  not: scope and volume are different axes.
- Whether to expose remaining quota in a response `_meta` field so a well-behaved agent
  can pace itself rather than discovering the wall.
- Whether the burst limit should be per token **and** per user. Today a user with twenty
  tokens has twenty burst allowances. That is the right behaviour for twenty real agents
  and the wrong one for a script minting tokens in a loop — which the mint endpoint's own
  cap of 50 live tokens already bounds, but not tightly.
