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

> A node is visible when it is a granted page, when it is reachable from one through live
> child links, or when it was written in one (`notes_id` — the note's Unassigned basket,
> which the person can see, so the agent can too).

Everything follows from that one definition. A scoped token cannot list, search, read,
traverse into, edit or delete anything outside it, and there is no argument it can send
that changes the set, because the set is computed from the grant and the graph.

Two deliberate readings of a broken scope, both in the safe direction:

- A `note_ids` column that does not parse means **no notes**, never every note.
- A scope naming a note that has since been deleted means **no notes**, not every note.

### Creating notes

`create_note` requires an **unrestricted** token. A scoped token names notes that already
exist; a note it created could not have been named, so allowing creation would let a
grant over one note grow into a corpus of its own making. `write` on a scoped token means
"edit these notes", and the tool description says so.

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

| Tool             | Perm   | What it does                                                                                          |
| ---------------- | ------ | ----------------------------------------------------------------------------------------------------- |
| `list_notes`     | read   | Notes the token can reach, newest first. Filter by `query`, `tag`, `type`; page with `cursor`.        |
| `search`         | read   | Blocks whose text contains a substring, each naming the notes it appears in.                          |
| `read_note`      | read   | A note's blocks **as stored rows** — top 2 levels by default (`depth: 0` for all), plus `unassigned`. |
| `get_block`      | read   | One block by id: type, text, props, children, parents, the notes it is in.                            |
| `list_children`  | read   | The blocks beneath one, `depth` levels deep — walking **down**.                                       |
| `list_parents`   | read   | The blocks that hold one, and the notes it appears in — walking **up**.                               |
| `list_tags`      | read   | Tags across the reachable notes, with note counts.                                                    |
| `create_note`    | write¹ | A new note from markdown.                                                                             |
| `append_to_note` | write  | Add to the end of a note, leaving the rest untouched.                                                 |
| `update_note`    | write  | **Replace** a note's whole body. The blunt instrument — see below.                                    |
| `update_block`   | write  | Change one block's text, type or metadata, in place.                                                  |
| `link_block`     | write  | Put an existing block under a parent, at an index.                                                    |
| `unlink_block`   | write  | Take a block out of one place. Kept, not deleted.                                                     |
| `move_block`     | write  | Re-parent or reorder a block in one step.                                                             |
| `delete_block`   | delete | Delete a block everywhere, optionally with its contents.                                              |
| `delete_note`    | delete | Delete a note and the blocks only it holds.                                                           |

¹ `create_note` also requires an **unrestricted** token — see §1.

### Reads are rows, not markdown

`read_note`, `get_block` and the traversal tools hand back **the stored row**: id, `type`
(`ul`, `h1`, `todo`…), marker-free `text`, the `props` object, `childIds`, `updatedAt`.
No markdown, no `id::` lines — the id is a field.

Markdown is an **input** format in this API and never an output one. `create_note` and
`append_to_note` parse it; nothing returns it. That is what makes the write side safe:
an agent changes a block by naming it and setting a field, rather than round-tripping a
document and hoping the diff lands where it meant.

It also makes partial reads safe, which matters more than it sounds — because **a row is
heavier than the markdown line it replaced**, roughly 60 characters against 36. Measured
over the wire against a real 281-block note:

| `read_note`             | Blocks returned                      | Payload        |
| ----------------------- | ------------------------------------ | -------------- |
| `depth: 0` (everything) | 281                                  | ~13,000 tokens |
| default (`depth: 2`)    | 17, with 11 marked `hasMoreChildren` | ~1,100 tokens  |
| `depth: 1`              | 5, with 4 marked                     | ~390 tokens    |

So `read_note` returns the top two levels **by default**. Reading such a note whole now
costs more than the markdown form did, and an agent given the choice takes the dump every
time — the default is what makes this change a saving rather than a cost.

Nothing is hidden by it: `blockCount` is always the note's true size, `truncated` says
whether you got all of it, and every block whose children were cut carries
`hasMoreChildren`, so an agent knows precisely what it has not seen and where to ask.
`depth: 0` still reads everything. And there is no partial _document_ it could hand back
to a whole-note write and silently gut the note with, because there is no document.

Empty fields are omitted for the same reason — `"props":null,"childIds":[]` on 281 blocks
is pure context spent saying nothing.

### Editing: name the block, not the note

`update_note` replaces a note's **whole body**. Every block it does not recreate stops
being part of the note and moves to Unassigned. Nothing is lost, but the note is emptied
of it, so it is for rewriting a note wholesale and nothing else.

For everything else there is a verb that touches one block and leaves the rest alone:
`update_block` to change it, `move_block` to relocate it, `link_block`/`unlink_block` to
add or remove one of its appearances, `append_to_note` to add to the end. Changing one
bullet with `update_block` costs a couple of hundred tokens; doing it through
`read_note` + `update_note` on that same 281-block note costs about twelve thousand.

### A block can be in several notes at once

Linking a block under a second parent does not copy it — the same block now appears in
both places, and editing it either place changes both. That is the app's own behaviour,
and it has a consequence for scoped tokens:

> A **note-scoped** token may only write a block every one of whose notes it names.

Otherwise editing a shared block would put a write where the grant does not reach, and
neither the agent nor anyone reading the grant would see it happen. The refusal says a
note the token cannot see holds the block, and deliberately **not which one** — the check
must not become a way to enumerate the notes the grant excludes. Unrestricted tokens are
never limited this way. `notesReachingUnscoped` is the one read in `graph-access.ts` that
deliberately ignores the scope, and it exists only for this.

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
- **Tool execution error** (`isError: true`) — no such note, out of scope, empty
  markdown, bad argument. Handed back as text so the model can self-correct.

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

Each tool call loads the tenant's live rows once — two indexed queries — and then answers
from an in-memory `GraphSnapshot` using the app's own pure functions (`rollup`,
`noteFromPage`, `reachableFrom`). That fidelity is the point: an agent traversing the
graph sees what the person would see, because it is the same code, rather than a second
SQL definition of "what the user can see" that drifts.

The cost is the same read a replica full pull makes — measured at ~540 rows
(`worker/d1-sql-driver.ts`), an order of magnitude under the audit threshold there — and
it is bounded by the corpus, not by how hard an agent pushes. If a corpus outgrows it,
the fix is a note-scoped load; the seam is `loadSnapshot`, and nothing above it changes.
See docs/scaling-thresholds.md.

---

## 5. Connecting a client

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

## 6. Why not OAuth

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

## 7. Files

|                                         |                                                   |
| --------------------------------------- | ------------------------------------------------- |
| `worker/handlers/mcp.ts`                | The endpoint: transport rules, auth, dispatch     |
| `worker/handlers/mcp-tokens.ts`         | Mint / list / revoke, session-authed              |
| `worker/mcp/protocol.ts`                | The 2026-07-28 wire format — pure                 |
| `worker/mcp/grant.ts`                   | What a token may do — pure, and fail-closed       |
| `worker/mcp/tokens.ts`                  | Token storage, hashing, lookup                    |
| `worker/mcp/graph-access.ts`            | The scoped view of the corpus, and the write path |
| `worker/mcp/tools.ts`                   | The sixteen tools, and the refusals before them   |
| `src/data/ops-rows.ts`                  | Ops → rows, shared with the browser store's rule  |
| `src/components/mcp-tokens-section.tsx` | The Settings panel                                |
| `migrations/0007_mcp_tokens.sql`        | The grants table                                  |
