# MCP rate limiting — planned

**Status: half built.** Step 1 below — reducing the per-call cost so that the limits have
less to protect against — is done, and the measurements are in docs/mcp-server.md §4.
Steps 2 and 3, the limits themselves, are not: the MCP endpoint still has **no rate
limiting at all**, which is a spec violation and the most likely way this feature breaks
something that matters.

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

### 2. Then limit the calls

Per **token**, not per user or per IP: the token is the thing a person minted, revoked,
and can reason about, and it is already read on every request.

- A cheap counter in the control plane, keyed by token id and a time bucket. Candidates:
  a `mcp_token_usage` table (one row per token per hour), or Cloudflare's own rate
  limiting binding, which costs no database round trip.
- Two limits, because the failure modes differ: a **burst** limit (calls per minute,
  catching a runaway loop quickly) and a **daily** limit (catching slow steady drain).
- Weight by cost if it is cheap to do: a `search` is worth more than a `get_block` once
  the point reads are targeted. Do not over-engineer this — a flat count is most of the
  value.

### 3. Answer correctly when refusing

HTTP `429`, with `Retry-After`. In the JSON-RPC body, a tool execution error
(`isError: true`) rather than a protocol error, so the model is told in words it can act
on: it should back off, not retry immediately or rephrase.

The limits should be visible to the person, not just enforced: show calls-in-period next
to each token in Settings → MCP access, beside `last_used_at`. A limit nobody can see is
a limit nobody can debug.

## Open questions

- Where the counter lives — D1 writes on every call are themselves a cost. Cloudflare's
  rate limiting binding avoids that entirely and is probably the right answer.
- Whether an unrestricted token should get a higher limit than a note-scoped one. Probably
  not: scope and volume are different axes.
- Whether to expose remaining quota in a response `_meta` field so a well-behaved agent
  can pace itself rather than discovering the wall.
