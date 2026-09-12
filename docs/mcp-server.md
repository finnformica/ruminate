# MCP server

Ruminate speaks the [Model Context Protocol](https://modelcontextprotocol.io), so an AI
agent can read and write your notes the way you do — pick a note, walk the graph
beneath it, follow a block back up to the notes it appears in, add to it, delete it.

The whole design question is not "how does an agent reach the notes" — that part is
small — but **"what stops it reaching the rest"**. An agent is a program that does what
it is told by text it reads, and some of that text is your notes. So the answer cannot
be a prompt. It has to be a wall, drawn before the agent runs, by a person.

|                   |                                                                |
| ----------------- | -------------------------------------------------------------- |
| Endpoint          | `POST /mcp`                                                    |
| Protocol revision | `2026-07-28` (stateless; no sessions, no `initialize`)         |
| Transport         | Streamable HTTP, JSON responses                                |
| Credential        | `Authorization: Bearer rmn_mcp_…` — a token minted in Settings |
| Methods           | `server/discover`, `tools/list`, `tools/call`                  |

---

## 1. The wall

Three questions are answered when the token is minted, by a signed-in person, and never
afterwards by the agent:

| Question         | Where it lives           | Enforced by                                     |
| ---------------- | ------------------------ | ----------------------------------------------- |
| **Whose notes?** | `mcp_tokens.user_id`     | `forTenant` → `TenantDb` (worker/tenancy-db.ts) |
| **Which verbs?** | `mcp_tokens.permissions` | `allows` (worker/mcp/grant.ts)                  |
| **Which notes?** | `mcp_tokens.note_ids`    | `visibleNodes` (worker/mcp/graph-access.ts)     |

These are three separate walls, not one, and they are enforced in three separate places.
The tenancy wall is the one the replica already has — column-scoped tenancy with a
runtime guard that refuses any statement not naming `:tenant`. The other two are new,
and are what this feature adds.

### Permissions

`read`, `write`, `delete`. Nothing is implied by anything else: a `write` token cannot
delete, and a `delete` token without `read` cannot see what it is deleting.

A tool the token does not permit is **not listed** by `tools/list` — the spec allows the
tool set to vary by the presented credential, and a read-only agent that is never told
`delete_note` exists is in a better position than one that is told and refused.

### Note scope

A token either reaches **every note**, or exactly the notes the user ticked. The scope is
stated in notes because a note is what the user recognizes; what it means for the graph
beneath is derived, never sent:

> A node is visible when it is a granted note, when it is reachable from one through live
> child links, or when it was written in one (`notes_id` — the note's Unassigned section,
> which the person can see, so the agent can too).

Everything follows from that one definition. A scoped token cannot list, search, read,
traverse into, edit or delete anything outside it, and there is no argument it can send
that changes the set, because the set is computed from the grant and the graph.

Two deliberate readings of a broken scope, both in the safe direction:

- A `note_ids` column that does not parse means **no notes**, never every note.
- A scope naming a note that has since been deleted means **no notes**, not every note.

### An agent cannot create notes

There is no `create_note`. `write` means "edit the notes this token was given", and a
token that cannot mint a note cannot grow a corpus of its own — which is what a note scope
would otherwise have to keep chasing.

### An MCP token cannot mint an MCP token

The management API (`/api/mcp/tokens`) takes a **browser session** — the `gh_refresh`
cookie plus a GitHub access token, through the same `requireSession` the replica uses —
and nothing else. Widening an agent's authority always requires a person signed in to
GitHub. An agent that talks its way into any amount of mischief still cannot grant itself
a permission it was not given.

### Revocation is immediate, and so is blocking

Every request re-reads the token row, so revoking one stops the next call. Every request
also re-checks `users.status`, so `UPDATE users SET status = 'blocked'` kills that user's
agents at the same moment it kills their browser — without anyone having to remember that
tokens exist.

---

## 2. The tools

Reads need `read`; the writers need `write`; the two deleting verbs need `delete`.

An agent works in the notes you already have: there is no tool to create one.

| Tool             | Perm   | What it does                                                                                                                                      |
| ---------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_notes`     | read   | Notes the token can reach, newest first. Filter by `tag` or `type`; page with `cursor`.                                                           |
| `search`         | read   | Blocks whose text contains a substring, each naming the notes it appears in. Page with `cursor`.                                                  |
| `read_note`      | read   | A note's blocks **as stored rows** — top 2 levels by default (`depth: 0` for all), plus `unassigned`. Bounded by `limit` too; page with `cursor`. |
| `get_block`      | read   | One block by id: type, text, props, children, parents, the notes it is in. Its id lists are capped.                                               |
| `list_children`  | read   | The blocks beneath one, `depth` levels deep — walking **down**. Page with `cursor`.                                                               |
| `list_parents`   | read   | The blocks that hold one, and the notes it appears in — walking **up**. Page with `cursor`.                                                       |
| `list_tags`      | read   | Tags across the reachable notes, with note counts. Page with `cursor`.                                                                            |
| `create_blocks`  | write  | Add blocks under a parent, nesting with `children`. Purely additive.                                                                              |
| `set_note_title` | write  | Set or clear a note's title.                                                                                                                      |
| `update_block`   | write  | Change one block's text, type or metadata, in place.                                                                                              |
| `link_block`     | write  | Put an existing block under a parent, at an index.                                                                                                |
| `unlink_block`   | write  | Take a block out of one place. Kept, not deleted.                                                                                                 |
| `move_block`     | write  | Re-parent or reorder a block in one step.                                                                                                         |
| `delete_block`   | delete | Delete a block everywhere, optionally with its contents.                                                                                          |
| `delete_note`    | delete | Delete a note and the blocks only it holds.                                                                                                       |

### There is no markdown

`read_note`, `get_block` and the traversal tools hand back **the stored row**: id, `type`
(`ul`, `h1`, `todo`…), marker-free `text`, the `props` object, `childIds`, `updatedAt`.
The writers take the same shape — `create_blocks` takes `{ text, type?, props?, children? }`,
`update_block` takes fields.

Markdown appears nowhere in this API, in either direction. That matches the app, where
the graph is truth and markdown is an import/export format at the edges
(CLAUDE.md, docs/graph-storage.md); an earlier version of this server reintroduced it in
the middle, and that was a mistake. What it bought was the ability to read a note as a
document and write the document back — and what that cost was the ability to do it
_wrongly_: send back markdown missing a block and the diff quietly moves the rest of the
note into Unassigned.

With rows in and rows out, that move does not exist. An agent changes a block by naming
it. Which in turn makes partial reads safe, and partial reads are where the real saving
is — measured over the wire against a real 281-block note:

| `read_note`             | Blocks returned                      | Payload        |
| ----------------------- | ------------------------------------ | -------------- |
| `depth: 0` (everything) | 281                                  | ~13,000 tokens |
| default (`depth: 2`)    | 17, with 11 marked `hasMoreChildren` | ~1,100 tokens  |
| `depth: 1`              | 5, with 4 marked                     | ~390 tokens    |

A row is heavier than the markdown line it replaced — roughly 60 characters against 36 —
so `read_note` returns the top two levels **by default**. Reading such a note whole now
costs more than the markdown form did, and an agent given the choice takes the dump every
time; the default is what makes this a saving rather than a cost. Nothing is hidden by
it: `blockCount` is always the note's true size, `truncated` says whether you got all of
it, and every block whose children were cut carries `hasMoreChildren`. `depth: 0` still
reads everything.

Empty fields are omitted for the same reason — `"props":null,"childIds":[]` on 281 blocks
is pure context spent saying nothing.

### Editing: name the block, not the note

There is no whole-note write. `create_blocks` adds, `update_block` changes one block,
`move_block` relocates one, `link_block`/`unlink_block` add or remove one of its
appearances, `set_note_title` retitles. Changing one bullet costs a couple of hundred
tokens; the old read-note-then-replace-note round trip on that 281-block note cost about
twenty-six thousand.

### The Unassigned section

A block belongs to a note by being reachable from its page node. Remove the row holding
it and the block is **kept, not deleted** — it still carries the note it was written in
(`notes_id`), and shows in that note's Unassigned section beneath the outline, with
everything under it. `read_note` returns it as `unassigned`, alongside the outline, so
it needs no tool of its own. Linking it back with `link_block` takes it out again.

`delete_note` still removes a note's Unassigned blocks along with the note, as the app
does.

### Two kinds of failure

- **Protocol error** (`-32602`) — the tool does not exist for this token. A model cannot
  fix it by retrying, and the message says which permission is missing so the _person_
  reading the transcript can.
- **Tool execution error** (`isError: true`) — no such note, out of scope, an argument
  that does not fit the tool's schema. Handed back as text so the model can
  self-correct; an argument failure names the field's path (`blocks[1].text`), so the
  fix is one field rather than a fresh guess at the whole call.

Each tool's arguments are one [zod](https://zod.dev) schema (`zod/mini`, in
`worker/mcp/tools.ts`), and the `inputSchema` a client reads is generated from it with
`z.toJSONSchema` rather than written beside it — one statement of the contract, so what
an agent is told and what the server enforces cannot drift apart.

---

## 3. How a write reaches the browser

An agent's edit goes out through the **same planner a replica push does**
(`planReplicaPut`): per-row last-writer-wins, one atomic batch, and a fresh server `seq`
on every row. So the browser's next `?since=` pull reads it like any other change. There
is no second sync path, and nothing in the client had to change.

Two things the write path deliberately does not do:

- It does not move `meta.replica_cursor`. That is the _client's_ marker of what it has
  pushed, and an agent writing through a different door must not touch it.
- It does not seed a new tenant's `meta` rows. Nothing on this path reads them, so doing
  it would be two writes per tool call for nothing; `readyTenant` seeds them when a
  browser first syncs.

---

## 4. Cost

Every tool call answers from an in-memory `GraphSnapshot`, using the app's own pure
functions (`noteFromNode`, `basketRootIds`, `reachableFrom`, `noteDoc`). That fidelity is
the point: an agent traversing the graph sees what the person would see, because it is
the same code, rather than a second SQL definition of "what the user can see" that
drifts.

What changed in 2026-09 is only **which rows that snapshot is built from**. It used to be
all of them — two queries, every live `nodes` and `link` row the tenant has, on every
call. That is O(corpus) per call with nothing bounding how many calls an agent makes, and
at ~1,700 rows a call D1's 5M-rows-per-day free tier is gone in about 3,000 calls. This
project has been burned by exactly that shape before (docs/scaling-thresholds.md: one
corpus-scaling query on an ambient browser event, 97% of a day's read volume).

So each tool now says which rows its question needs, and the same pure functions run over
that slice. Measured on a 20-note, 800-block fixture — 1,620 rows, roughly the owner's
corpus (`worker/mcp/graph-load.test.ts`):

| Call                              | Before | After |
| --------------------------------- | -----: | ----: |
| `get_block` (a leaf)              |  1,620 |     4 |
| `list_children` (1 level)         |  1,620 |    17 |
| `list_children` (2 levels)        |  1,620 |    41 |
| `list_parents` (a leaf)           |  1,620 |    46 |
| `read_note` (any depth)           |  1,620 |    81 |
| `list_notes` (default page of 50) |  1,620 |   820 |
| `list_notes` (page of 5)          |  1,620 |   220 |
| `get_block`, note-scoped token    |  1,620 |    45 |
| `search`, `list_tags`             |  1,620 | 1,620 |

The traversal tools are now bounded by the question rather than by the corpus. `search`
and `list_tags` are not, and are not pretended to be: one reads every block's text and
the other every note's tags, which is what they are for.

Four things worth knowing about the table:

- **`read_note` is O(note), not O(depth).** `blockCount` is the note's true size and the
  title, tags, tasks and preview are derived from every block in it, so `depth` bounds
  what comes BACK, never what is read. One note of twenty is still the saving.
- **`list_parents` is O(the notes holding the block)**, because it names those notes and
  an untitled note's display name is derived from its outline. Reading them is the price
  of that name being the one on screen rather than a second guess at it.
- **`list_notes` reads the note rows, then only the notes on the page.** Which notes a
  page names, and in what order, is decided by facts on each note's own row — its
  `updated_at` prop, and its id, which says whether it is a daily or a weekly. Its tags,
  task counts and preview are not, so those are read for the page alone. A `tag` filter
  is a question about every block of every note, so it loads the corpus and says so.
- **A note-scoped grant pays for its scope.** The visible-node set is a walk seeded at the
  granted notes rather than a pass over a loaded corpus — cheaper, and the same set.

### Why this is safe

Targeted SQL is exactly how a second, drifting definition of "what the user can see" gets
built, so none of it answers a question. The loaders (`worker/mcp/graph-load.ts`) only
fetch rows; every answer still comes from the app's pure functions. What each view has to
guarantee is that its slice is **closed** under the questions its tool asks — the upward
closure of a block makes "which notes is this in?" exact, a subtree to depth _d_+1 makes a
_d_-level outline exact, and the basket needs every candidate either visibly reached or
carrying its full ancestry. Those invariants are written out at the top of
`worker/mcp/graph-access.ts`.

And they are tested rather than argued: `loadSnapshot` remains as the reference
implementation, and `graph-load.test.ts` runs every read, for every node of a graph built
out of the awkward shapes (a block in two notes, an Unassigned subtree, an untitled note,
a loop, a tombstone in the middle of an outline), through both paths and demands identical
results — for an unrestricted grant and a note-scoped one. A view that loads too few rows
cannot survive that; a view that loads too many only costs.

Writes still load the whole corpus. Their op planners (`deleteNoteOps`, `opsToRows`) ask
questions of the whole graph — what else holds this block, what would be orphaned — and a
bounded slice has no honest answer to those. A write is also rarer than a read and already
pays for a batch.

---

## 5. Bounds and limits

Three separate things are bounded: how many calls a token may make, what one call
costs, and how much one response may contain.

### How many calls

Per **token**, because the token is the thing a person minted and can revoke. A **burst**
limit of 120 calls a minute (Cloudflare's rate-limiting binding, no database round trip)
catches a runaway loop within a minute; a **daily** limit of 5,000 catches the slow steady
drain a burst limit is blind to. Over either, the answer is `429` with `Retry-After` and —
for a tool call — a tool-execution error saying to wait and for how long, because the call
was well formed and rephrasing it will not help. Settings → MCP access shows what each
token has spent today. The design and its reasoning are in docs/mcp-rate-limiting.md.

### What one response contains

A tool call's cost is bounded on the way IN (§4); the response is bounded on the way out.
Every collection has a `limit`, and every collection an agent could legitimately want the
rest of has a `cursor`:

| Tool            | Bounded by                                                              |
| --------------- | ----------------------------------------------------------------------- |
| `list_notes`    | `limit` + `cursor`                                                      |
| `search`        | `limit` + `cursor`                                                      |
| `list_children` | `depth`, then `limit` + `cursor` over the flattened walk                |
| `list_parents`  | `limit` + `cursor`, over the parents and the notes alike                |
| `list_tags`     | `limit` + `cursor`                                                      |
| `read_note`     | `depth`, then `limit` + `cursor` over the outline and Unassigned as one |
| `get_block`     | its embedded id lists are capped; the counts and the flags say so       |

Three rules behind that table.

**One cursor convention.** A cursor is an opaque digit string naming an offset into an
order that is the same for the same corpus and arguments, and a cursor this server did
not issue is refused rather than guessed at. It is the same on every tool, so an agent
learns paging once.

**Never truncate without recourse.** `list_children` used to answer `truncated: true` with
a `total` and no way to get the rest — the agent was told its answer was incomplete and
given nothing to do about it, which is worse than either paging or not cutting. Where a
cursor genuinely does not fit, the response says what to call instead: `get_block` is a
point read, so its `childIds` / `parentIds` are capped with `childCount`, `parentCount`
and a line naming `list_children` / `list_parents`.

**A structural bound is not a cardinal one.** `depth` bounds how DEEP a read goes, and a
note 500 rows wide at `depth: 1` is still enormous — so `read_note` and `list_children`
carry a `limit` as well, and `blockCount` goes on reporting the note's true size through
both. `depth` itself is capped at 32: a depth-bounded read is a recursive walk, the graph
can hold loops, and the work is O(nodes × depth).

## 6. Connecting a client

1. Open **Settings → MCP access**.
2. **New token.** Name it, tick the permissions, choose every note or pick specific ones,
   choose an expiry.
3. Copy the token. **It is shown once** — only a SHA-256 hash is stored, so it cannot be
   shown again.
4. Point your client at the endpoint shown on that panel (`https://<your-host>/mcp`) with
   the token as a bearer credential.

For a client that takes a JSON config:

```jsonc
{
  "mcpServers": {
    "ruminate": {
      "type": "http",
      "url": "https://<your-host>/mcp",
      "headers": { "Authorization": "Bearer rmn_mcp_…" },
    },
  },
}
```

Start with **read only, every note** — that is the useful half of the value with none of
the risk. Add `write` scoped to a single inbox note when you want an agent to be able to
put things somewhere.

`server/discover` answers without a token, so you can check the URL is right:

```
curl -sX POST https://<your-host>/mcp \
  -H 'MCP-Protocol-Version: 2026-07-28' \
  -H 'Mcp-Method: server/discover' \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"server/discover","params":{}}'
```

---

## 7. Why not OAuth

The spec makes authorization **optional** and says HTTP servers _should_ conform when
they do it. Ruminate does not: it takes an opaque bearer token it minted itself, and
answers an unauthenticated call with an RFC 6750 `WWW-Authenticate` challenge naming the
page that mints one, rather than advertising a protected-resource-metadata document that
leads to an authorization server that does not exist.

The reasons, in order:

1. **Scopes cannot say what this needs to say.** The interesting grant here is "read this
   one note", and expressing that in OAuth means inventing a scope grammar over note ids
   anyway — at which point the OAuth machinery is carrying a custom vocabulary it cannot
   check.
2. **There is no third party.** Dynamic client registration, Client ID Metadata
   Documents, PKCE and consent screens exist so that an _unknown_ client can obtain a
   _user's_ authorization. On a personal instance with an allowlist of a handful of
   accounts, the user and the person configuring the client are the same person, at the
   same keyboard.
3. **It stays reversible.** The resource server is the part that would be kept: token →
   `Grant` → the two walls. Slotting an authorization server in front later means
   replacing `findGrant`, and nothing above it.

If Ruminate ever opens up, that is the moment to add it — and the moment the cost is
worth paying.

---

## 8. Not built yet

Two follow-ups have their designs written down rather than their code (rate limiting was the third, and is built — §5 and docs/mcp-rate-limiting.md):

|                        |                                                                                |
| ---------------------- | ------------------------------------------------------------------------------ |
| docs/mcp-search.md     | One search surface for the person and the agent, lexical then hybrid-semantic. |
| docs/mcp-provenance.md | Marking agent writes, and accepting or discarding them.                        |

## 9. Files

|                                         |                                                    |
| --------------------------------------- | -------------------------------------------------- |
| `worker/handlers/mcp.ts`                | The endpoint: transport rules, auth, dispatch      |
| `worker/handlers/mcp-tokens.ts`         | Mint / list / revoke, session-authed               |
| `worker/mcp/protocol.ts`                | The 2026-07-28 wire format — pure                  |
| `worker/mcp/grant.ts`                   | What a token may do — pure, and fail-closed        |
| `worker/mcp/tokens.ts`                  | Token storage, hashing, lookup                     |
| `worker/mcp/graph-access.ts`            | The scoped view of the corpus, and the write path  |
| `worker/mcp/graph-load.ts`              | Which rows a view reads — loaders only, no answers |
| `worker/mcp/rate-limit.ts`              | How much an agent may ask for, and what it is told |
| `worker/mcp/tools.ts`                   | Every tool, and the refusals before them           |
| `src/data/ops-rows.ts`                  | Ops → rows, shared with the browser store's rule   |
| `src/components/mcp-tokens-section.tsx` | The Settings panel                                 |
| `migrations/0007_mcp_tokens.sql`        | The grants table                                   |
| `migrations/0009_mcp_token_usage.sql`   | What a token has spent today                       |
