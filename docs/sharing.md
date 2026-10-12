# Sharing

Share a subgraph of your notes with another Ruminate user. From a note's or a
block's menu, type the email address they sign in to GitHub with; they see
that root and everything beneath it — including blocks you add later — under
a **Shared** heading in their sidebar, and can edit there only if you said
so. **A share is a view shared with someone** (docs/metadata.md,
"Views"): the share row holds the grant — who, which view, which verbs — and
the view holds what is shared and how it opens. Save a filter or a sort on
the note you shared and the person you shared it with opens it that way.

|                |                                                                                                                  |
| -------------- | ---------------------------------------------------------------------------------------------------------------- |
| The unit       | A **scoped grant** on a view: owner, `view_id`, grantee address, verbs                                           |
| What is shared | The reachability closure beneath the view's root, computed per request                                           |
| How it opens   | The view's filter and sort — presentation; the slice is the whole subtree                                        |
| Who            | An email address, matched to the primary verified GitHub email                                                   |
| Verbs          | `read` (always), `write` — which carries `delete` with it                                                        |
| Endpoints      | `/api/shares`, `/api/shares/:id`, `/api/shares/:id/notes`                                                        |
| Storage        | Control plane: `shares` (0012, 0017, 0020), `users.email` (0010, 0011); the view is a corpus row (`views`, 0015) |
| Where it lives | `worker/shares/`, `worker/handlers/shares.ts`, `src/data/shared-mode.ts`                                         |

---

## 1. The model: a view, not a move

docs/multi-tenant-design.md §8 set out two possible primitives for
collaboration: a **space** (a second corpus people are members of — the data
moves) and a **scoped grant** (a control-plane row that opens a _view_ onto a
slice of the owner's corpus — the data stays where it is). This feature is the
grant, and that choice decides everything else:

- **The data never moves.** A shared note is still the owner's rows, in the
  owner's partition, replicated to the owner's devices as before. The grantee
  reads and writes those rows through a second door.
- **The share names a view, and the view names the root.** `shares.view_id`
  is the id of the owner's row in `views` (migrations/0017): the root is what
  is shared, the filter and sort are how the grantee opens it. The create
  endpoint makes the owner an empty view where they have none — unfiltered,
  unsorted, under the root's own id, which is the id the client mints
  (src/data/views.ts), so a filter the owner saves later lands on that very
  row and changes the share without a write to it. A view is only ever
  tombstoned, never removed, and a tombstone still names its root; so the
  reference cannot dangle, and a cleared view serves the whole subtree in
  document order until the owner saves one again. The filter is
  **presentation, not permission**: the slice is the whole subtree either
  way, and the grantee may clear the filter or save a view of their own,
  which wins over the share's on their side.
- **The slice is computed, never stored.** What is visible beneath the root
  is derived from the owner's rows on every request:

  > A node is in the slice when it is the granted root and a live node, or
  > when it is reachable from it through live child links.

  So the share is _live by construction_ — a block added under a shared note
  is in the share the moment it is linked; a block unlinked from it leaves —
  and _least-privilege by construction_ — ids outside the closure are never
  serialized, so the grantee cannot even name them. This is what "permissions
  cascade downstream" means: the roots carry their verbs to everything
  reachable from them, now and as the subtree grows.

- **The walk is one recursive CTE** (`worker/shares/slice.ts`), the same shape
  the MCP server's note scope uses: `UNION` so a loop terminates, joining
  `nodes` at both ends of every link so the walk over rows crosses exactly the
  edges `buildGraphSnapshot` would. Every statement names `:tenant` — the
  **owner's** — and satisfies the query guard like every other corpus
  statement. The closure is the OUTER side of every join (`CROSS JOIN`, which
  SQLite reads as a join-order hint): left to its own estimates the planner
  scanned the owner's whole `link` table once per node reached, which cost
  329k rows a pull on a 285-block share (docs/scaling-thresholds.md, "Rows
  returned is not rows read"). `worker/query-plans.test.ts` pins the plan.

### What is deliberately not in the slice

- **The Unassigned basket.** The MCP scope includes blocks _written in_ a
  granted note (`notes_id`) so an agent sees what the person sees. A share
  does not: "downstream of the roots" is reachability, and a block the owner
  removed from the outline is, from the grantee's side, gone. What the
  grantee removes _themselves_ is kept on their device alone, in memory, as
  the shared note's basket until the page reloads (§4, "parked"); the owner's
  basket is never served. A block born in a shared root stays _writable_
  from the grantee's side while out of reach (§3, "parked"), so an undo can
  link it back.
- **`notes_id` values outside the closure.** A block the owner mirrored into
  a shared note from a private one was _born_ in the private note, and its
  `notes_id` would name that note's id. The slice blanks it. Nothing the
  grantee receives names an id they cannot reach.
- **Parents.** A link from the owner's private note into a shared block is
  the private note's row; the slice carries only links with both ends inside.

## 2. Who: an address, resolved server-side

The owner types an email address. That is the whole of how a grantee is
named, and it is designed so the app never becomes a directory:

- **No lookup, no confirmation.** Creating a share stores the address
  (lowercased) and answers with what was stored. Whether it belongs to a
  Ruminate user is not revealed — the response is identical for an address
  nobody has signed in with.
- **The address is written only by the server.** `users.email` is the
  **primary verified** address GitHub reports for the account. Signing in is
  signing up: the OAuth callback — the one moment the address is fetched —
  runs the same tenancy resolver the API does and provisions (or refreshes)
  the `users` row with it, so an admitted account has its address before its
  first API request. The column is mandatory (migrations/0011): the callback
  is the only place a row is provisioned, and the API path — which verifies
  `/user` alone and carries no address — refuses an id with no row rather
  than inventing one without an address. A client can never supply the
  address it is resolved by — that would let anyone claim anyone's shares —
  and Settings shows the address as the server has it recorded, which is the
  address others can share with. Both columns carry a `CHECK` on the shape
  (lowercased, one `@` with something either side and a dot after it, no
  whitespace), so a row the equality join could never match cannot be
  written, by hand or by a bug.
- **Resolution is a join, at read time.** "The shares addressed to me" is
  verified id → recorded address → `shares.grantee_email`. A share to an
  address nobody has signed in with is simply a share nobody can see yet; when
  they do sign in, it is there.
- **The grantee learns no address but their own.** They see the owner's
  login and display name (from `users`), and never the address the share was
  made to; `GET /api/shares` returns the caller's own recorded address so
  Settings can say what it is.
- **Sharing with yourself** is refused.

## 3. Verbs

`read` is always granted; `write` is opted into, per share. A share is
read-only or editable.

| Verb     | Lets the grantee                                                                |
| -------- | ------------------------------------------------------------------------------- |
| `read`   | See the slice: the notes, their blocks, search across them, hover cards         |
| `write`  | Edit text and types, add blocks, reorder, unlink a block, **tombstone** a block |
| `delete` | Nothing of its own: stored beside `write` and implied by it (`grant.ts`)        |

`write` and `delete` were once separate verbs, drawn along the app's own line
(docs/graph-storage.md, "Remove = unlink, delete is explicit"): removing a
row from the outline is an unlink, and the block survives in the owner's
Unassigned basket; retiring the row itself is a delete. But the line
protected nothing. `write` already let a grantee empty every block's text
and remove every row into a basket the owner seldom opens, so withholding
`delete` only ever stopped them taking out a _blank_ row — which is what
Backspace on an emptied line does, so the one place it bit was mid-edit, as
a refusal of a keystroke. And since every write is an event
(docs/event-sourcing.md), the owner puts back a deleted block exactly as they
put back an emptied one. So `write` carries `delete`: the grant is widened at
its one mint (`shareFromRow`), a `read,write` row from before reads the same
as one written now, and the dialog offers **Edit** alone. The one thing an
editor may never tombstone is the **root** — the note or block that was
shared is the owner's; the grantee leaves the share instead (§4).

Width is a prop on the note node — the owner's node — so a shared note has
none. A view is not: it is the grantee's own row about the owner's node
(docs/metadata.md), so a shared note or block can be filtered and sorted from
the grantee's side, a shared block made a view of the grantee's own, and none
of it reaches the owner.

### The write boundary

`PUT /api/shares/:id/notes` takes the same row-diff body a replica push does
and is planned by a pure function (`planSliceWrite`), refused as a whole if
any row would leave the slice:

- A node row must name a node in the closure, a **parked** id, or a **new**
  id — one the owner's partition has never held — that is **anchored**:
  written in a shared note (`notes_id` names a live root) or linked beneath a
  slice node in the same push. An unanchored new row would be an orphan
  dropped into someone else's corpus, visible to nobody; one of the owner's
  rows revived or edited from outside would be a write to a row the grantee
  cannot see.
- A **parked** id is a block _born in one of the share's roots_ (its
  `notes_id`) that the closure no longer reaches: unlinked, so it sits in the
  owner's basket, or tombstoned. It is the shared note's own block still, and
  a grantee writes it as they write a slice node. This is what lets undo and
  redo work from their side: a removed row's undo re-links a block the slice
  no longer serves, a deleted block's redo re-creates a tombstoned id, and
  the basket they keep in memory (§4) edits rows the server has stopped
  sending. Without it every removal was final for the grantee — the server
  refused the re-link as a write outside the slice, and the row came back on
  screen for a moment and vanished. A block born anywhere else is refused by
  id, live or dead; nothing outside the closure is ever _served_.
- A link row must have both ends in the closure or among those ids.
- A row keeps its home note (`notes_id` lands only on a new row) and the
  owner's own props — `font`, `width` (docs/metadata.md) — which a push may
  carry unchanged but never change; a new row never carries them. A type is
  an edit like any other: `write` may make any block any type, a note or a
  board included, exactly as the owner's own editor may. No type is
  special-cased at the boundary.
- Time is the server's: a pushed `updated_at` or `deleted_at` is clamped to
  the request's clock, so a grantee cannot claim a row into the future and
  win every edit the owner makes after it.
- The owner's `replica_cursor` is theirs: a cursor in the payload is ignored.
  The legacy purge channel is refused.

What lands runs through `writeRows` (docs/event-sourcing.md) — the same door a replica push
runs, per-row last-writer-wins on `updated_at`, `seq` assigned by the
database — into the **owner's** partition. The owner's devices pick it up on
their next since-pull like any edit; two people editing one block converge
exactly as two devices do.

### Tenancy

This is the one handler that holds a `TenantDb` which is not the caller's own.
It is minted with `forTenant` from the share row's `owner_id` — a value the
server wrote under the owner's verified session — and from nothing the caller
sent, reached only through a share the ledger says is addressed to the caller,
and only the slice-scoped statements in `slice.ts` run on it. The query guard
and `check:queries` apply unchanged. `shares.test.ts` is the adversarial suite:
a stranger, the owner, a revoked share and a blocked owner all get the same
404 from the slice endpoints; no write reaches past the closure.

## 4. The client: slices beside the corpus

The local SQL store is a cache of the user's **own** partition — owner-bound,
wiped on identity change, replicated back to that partition. A slice of
someone else's rows does not belong in it. So shared notes live in memory
(`src/data/shared-mode.ts`), one `GraphSnapshot` per share:

- **Boot**: list the shares addressed to me, pull each slice whole, publish.
  Whole-slice pulls are deliberate: a since-cursor cannot describe a slice,
  because a block leaves it by being _unlinked_ — a change to a link row the
  block's own row never sees — and a slice is a handful of notes.
- **Edits**: `useApplyOps` (the write seam, `src/data/store.ts`) routes a
  batch by the origin of the nodes it names. A batch on one share's nodes
  applies to that share's snapshot at once and coalesces into a row diff
  pushed to the share's endpoint — write-behind, retried with backoff on a
  network failure, **reverted** (the slice re-pulled) on a refusal the server
  would repeat. A batch that spans a shared note and one of your own is
  refused with a toast: a block cannot live in two people's corpora at once.
  A share's verbs are checked client-side first, so a read-only note says so
  on the first keystroke rather than after a round trip.
- **Parked**: a row the reader removes from the outline is an unlink, and the
  block drops out of the next pull — into the owner's basket, which the
  reader never sees. The slice keeps it, with everything beneath it, as
  _parked_: still in the graph, so the shared note shows an **Unassigned**
  basket beneath the outline holding what this device removed, and an undo
  has something to link back. A parked block the server serves again is a
  slice row once more; one it no longer holds at all is gone. Nothing is
  stored — a reload starts from what the server serves, and the basket is
  empty again. (The owner's basket, and what other devices removed, stay
  out of the slice: §1.)
- **Sync**: the ambient triggers the replica pull uses (visibility, focus,
  online) re-pull every slice, coalesced to one per 30 s; a slice with a push
  in flight, or edits waiting behind one, keeps its local copy until they
  land — a pull put on screen over them showed the text as it stood a push
  ago, flickering back for a second until the next push caught up.
- **How the UI sees it**: `graphSnapshotAtom` merges the own graph with the
  union of every slice, so the editor, search, hover cards and the Views page
  read a shared note exactly as they read an own one. `sharedOriginAtom`
  (node id → share id) is what tells them apart: the sidebar lists own notes
  under **Views** and the notes shared with them under **Shared** (who shared
  each is the row's tooltip, and the page header's first crumb), and the note
  page shows a notice with the owner and the verbs, renders read-only without
  `write`, and hides Rename and the basket without it. Delete on the note is
  hidden on every share: the root is the owner's, and the grantee leaves the
  share instead (Add to Views on a block stays: the view is the grantee's
  own, docs/metadata.md).
- **A shared block is a note here.** A root may be a block, and a block has
  no page of its own to open; so on the way into the snapshot a root that is
  not a note is given the note type. It lists in the sidebar, opens at
  `/views/<id>` with its text as the title and its children as the outline,
  and searches like any note. A push puts the row's own type back while it
  still carries the note type it is shown with, so the owner's block never
  becomes a note by being shared; a type the grantee gave it lands as given.
- **Reading a share without write**: the same block editor as the reader's
  own notes, with editing off (`BlockEditor.browse`): the highlight moves, a
  click highlights, folds open and close and are kept per device, the
  default depth applies, `f` focuses. Nothing writes.
- **The note page is one page.** A shared note is the same components as
  the reader's own — `NoteTitle` and `BlockNoteEditor`, told they are
  read-only — never a second rendering of the title or the outline. What
  differs for a share is data: the rows come from the slice, and writes are
  refused at the store.
- **Where to share from**: a note's **⋯** menu (**Share**) shares the note;
  a block's right-click menu (**Share**) shares that block, as the root.
  One dialog, asking for the address and the verbs. Settings → Sharing is the
  overview: what this account has shared and with whom (with **Revoke**), and
  what has been shared with it (with **Leave**). Either side may end a share,
  and it is the same row retired either way: `revoked_by` says which, so the
  owner's list reads "(revoked)" or "(they left)", and a share that is to
  come back is a new share. Leaving re-lists the shared runtime at once, so
  the note is out of the sidebar before the page is left. Each row leads
  with the note or block — a block as `Note › text`, by the note it was
  written in — and the address, or the person who shared it, is its subtext,
  with how the share opens ("Todo, sorted by Text") when its view says so.
- **How a shared note opens**: the slice comes with the owner's view, and
  the note page reads it behind the reader's own (`sharedViewByRootAtom`,
  `useSavedView`): a filter the reader saves on the shared note is theirs
  and wins; with none, the owner's applies, and the header's dot and
  **Reset to default** measure against it.

## 5. Decisions, and what was not built

- **Grant, not space.** A view keeps the owner's corpus the single source of
  truth, needs no migration of rows and no second replica loop, and revoking
  is one row. The cost is that live collaboration is per-row LWW rather than a
  sequenced log — the same trade the app already makes across devices.
- **Roots are notes or blocks.** The closure walk is root-agnostic; the
  client presents a block root as a note so the grantee has somewhere to
  open it. One root per share, because a share is one view and a view has
  one root; sharing two things is two shares.
- **The filter is not a boundary.** Enforcing the owner's filter in the slice
  walk would make a row leave the grantee's view the moment their own edit
  stopped it matching, and would need the query language in the worker on
  every pull. A share is the subtree; the view is how it opens.
- **Email, resolved by the server from GitHub.** The alternative — sharing by
  GitHub login — would need a lookup box that confirms who exists. An address
  the owner already knows, matched against what GitHub reports, reveals
  nothing to anyone.
- **Whole-slice pulls, in memory.** Correct for the reasons above; cheap at
  the sizes shares have. If a share ever grows to a corpus, the fix is a
  per-share cache with a closure-aware cursor, not a change to the model.
- **Not built**: a since-cursor for slices; showing the owner "this share includes N blocks also used elsewhere"
  (the multi-parent case is handled — such a block is in the slice — but not
  surfaced at share time); expiry on a share (revoking, or leaving, is the mechanism);
  per-row attribution of who wrote what.
