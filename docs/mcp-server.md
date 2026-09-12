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

Reads need `read`; the three writers need `write`; `delete_note` needs `delete`.

| Tool              | What it does                                                                                   |
| ----------------- | ---------------------------------------------------------------------------------------------- |
| `list_notes`      | Notes the token can reach, newest first. Filter by `query`, `tag`, `type`; page with `cursor`. |
| `search`          | Blocks whose text contains a substring, each naming the notes it appears in.                   |
| `read_note`       | A note in full: title, tags, props, tasks, headings, and its markdown.                         |
| `get_node`        | One block or page: type, text, props, child count, parents, the notes it is in.                |
| `list_children`   | The blocks directly beneath one — walking **down**.                                            |
| `list_parents`    | The blocks that hold one, and the notes it appears in — walking **up**.                        |
| `list_tags`       | Tags across the reachable notes, with note counts.                                             |
| `list_unassigned` | A note's **Unassigned** blocks — written in it, but nothing links to them any more.            |
| `create_note`     | A new note from markdown. Unrestricted tokens only.                                            |
| `update_note`     | Replace a note's body; optionally retitle.                                                     |
| `append_to_note`  | Add to the end of a note, leaving the rest untouched.                                          |
| `delete_note`     | Delete a note and the blocks only it holds.                                                    |

### `id::` lines are the round trip

`read_note` returns the canonical rollup, which carries an `id::` line under every block.
An agent that edits that markdown and sends it back through `update_note` **keeps those
lines**, and every block it did not touch stays the same block — same id, same links,
same appearances in other notes.

Drop them and each block becomes a new one; the originals, if they still hold anything,
land in the note's Unassigned basket rather than being deleted (the app's own
never-lose-work rule, `docToOps`). Nothing is lost either way, but the note gains a
basket full of duplicates. `append_to_note` avoids the question entirely and is the right
tool for "add this to my notes".

### The Unassigned basket

A block belongs to a note by being reachable from its page node. Remove the row holding
it and the block is **kept, not deleted** — it still carries the note it was written in
(`notes_id`), and shows in that note's **Unassigned** section beneath the outline, with
everything under it. That is the app's never-lose-work rule, and it means a note has two
parts an agent has to know about:

- `read_note` gives the **outline** — and an `unassignedCount`, so an agent that has
  never heard of the basket still finds out there is something there;
- `list_unassigned` gives the **basket**, as markdown with `id::` lines.

Pasting one back is an ordinary `update_note`: put the basket's markdown (ids and all)
where you want it in the outline, and linking it there is what takes it out of the
basket. There is no separate "restore" verb, because there is no separate operation.

Deliberately read-only: the basket is where the app deletes a block for good, and that is
a decision worth leaving to the person whose notes they are. `delete_note` still removes
a note's basket along with the note, as the app does.

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

|                                         |                                                      |
| --------------------------------------- | ---------------------------------------------------- |
| `worker/handlers/mcp.ts`                | The endpoint: transport rules, auth, dispatch        |
| `worker/handlers/mcp-tokens.ts`         | Mint / list / revoke, session-authed                 |
| `worker/mcp/protocol.ts`                | The 2026-07-28 wire format — pure                    |
| `worker/mcp/grant.ts`                   | What a token may do — pure, and fail-closed          |
| `worker/mcp/tokens.ts`                  | Token storage, hashing, lookup                       |
| `worker/mcp/graph-access.ts`            | The scoped view of the corpus, and the write path    |
| `worker/mcp/tools.ts`                   | The twelve tools, and the three refusals before them |
| `src/data/ops-rows.ts`                  | Ops → rows, shared with the browser store's rule     |
| `src/components/mcp-tokens-section.tsx` | The Settings panel                                   |
| `migrations/0007_mcp_tokens.sql`        | The grants table                                     |
