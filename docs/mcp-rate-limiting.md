# MCP rate limiting — planned

**Status: not built.** This is the design for a follow-up PR. The MCP endpoint
(docs/mcp-server.md) currently has **no rate limiting at all**, which is both a spec
violation and the most likely way this feature breaks something that matters.

## Why this is the first thing to fix

Two facts multiply badly.

**1. The spec requires it.** The 2026-07-28 tools specification lists, under Security
Considerations, that servers **MUST** "rate limit tool invocations". We do not.

**2. Every tool call reads the whole corpus.** `loadSnapshot` (worker/mcp/graph-access.ts)
issues two queries and reads every live `nodes` and `link` row the tenant has — about
1,700 rows today. That is O(corpus) per call, and nothing bounds how many calls an agent
makes.

At 1,700 rows a call, D1's 5M-rows-per-day free-tier budget is gone in roughly **3,000
tool calls**. That is not an abusive figure; it is one agent in an unlucky loop for an
afternoon.

This project has already been burned by exactly this shape. From
docs/scaling-thresholds.md: one diagnostics query that scaled with the corpus, running on
an ambient browser event, consumed 6.25M rows in a day — 97% of the account's entire read
volume, from one person taking notes. The lesson recorded there was that the danger is
never a busy app; it is one query whose cost scales with the corpus, called more often
than anyone modelled. An MCP endpoint is that, with the call frequency handed to a model.

## What to build

### 1. Reduce the per-call cost first

Rate limiting caps the damage; not reading the whole corpus removes most of it. Do this
first, because it changes what the limits need to be.

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
