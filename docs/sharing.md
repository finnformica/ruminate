# Sharing

Share a subgraph of your notes with another Ruminate user. From a note's or a
block's menu, type the email address they sign in to GitHub with; they see
that root and everything beneath it — including blocks you add later — under
a **Shared by …** heading in their sidebar. Shares are read-only; write and
delete are a follow-up (§5).

|                |                                                                          |
| -------------- | ------------------------------------------------------------------------ |
| The unit       | A **scoped grant**: owner, roots (notes or blocks), grantee address      |
| What is shared | The reachability closure beneath the roots, computed per request         |
| Who            | An email address, matched to the primary verified GitHub email           |
| Verbs          | `read` — write and delete are a follow-up                                |
| Endpoints      | `/api/shares`, `/api/shares/:id`, `/api/shares/:id/notes`                |
| Storage        | Control plane: `shares` (migrations/0012), `users.email` (0010, 0011)    |
| Where it lives | `worker/shares/`, `worker/handlers/shares.ts`, `src/data/shared-mode.ts` |

---

## 1. The model: a view, not a move

docs/multi-tenant-design.md §8 set out two possible primitives for
collaboration: a **space** (a second corpus people are members of — the data
moves) and a **scoped grant** (a control-plane row that opens a _view_ onto a
slice of the owner's corpus — the data stays where it is). This feature is the
grant, and that choice decides everything else:

- **The data never moves.** A shared note is still the owner's rows, in the
  owner's partition, replicated to the owner's devices as before. The grantee
  reads those rows through a second door.
- **The slice is computed, never stored.** A share names root notes. What is
  visible beneath them is derived from the owner's rows on every request:

  > A node is in the slice when it is a granted root that is a live note, or
  > when it is reachable from one through live child links.

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
  statement.

### What is deliberately not in the slice

- **The Unassigned basket.** The MCP scope includes blocks _written in_ a
  granted note (`notes_id`) so an agent sees what the person sees. A share
  does not: "downstream of the roots" is reachability, and a block the owner
  removed from the outline is, from the grantee's side, gone. The grantee's
  note page hides the basket for shared notes.
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

## 3. Read-only

A share grants `read`, and nothing else: the slice, as rows, through one
`GET`. There is no write route, so nothing a grantee sends can reach the
owner's rows, and the client refuses an edit to a shared note before it is
made. Pinning and width are props on the note node — the owner's node, and
the owner's pin — so a shared note has neither. The verb set is stored on the
share row all the same (`read`, in the form the MCP grant uses), so that
`write` and `delete` can be granted later without a migration (§5).

### Tenancy

This is the one handler that holds a `TenantDb` which is not the caller's own.
It is minted with `forTenant` from the share row's `owner_id` — a value the
server wrote under the owner's verified session — and from nothing the caller
sent, reached only through a share the ledger says is addressed to the caller,
and only the slice-scoped statements in `slice.ts` run on it. The query guard
and `check:queries` apply unchanged. `shares.test.ts` is the adversarial suite:
a stranger, the owner, a revoked share and a blocked owner all get the same
404 from the slice endpoint.

## 4. The client: slices beside the corpus

The local SQL store is a cache of the user's **own** partition — owner-bound,
wiped on identity change, replicated back to that partition. A slice of
someone else's rows does not belong in it. So shared notes live in memory
(`src/data/shared-mode.ts`), one `GraphSnapshot` per share:

- **Boot**: list the shares addressed to me, pull each slice whole, publish.
  Whole-slice pulls are deliberate: a since-cursor cannot describe a slice,
  because a block leaves it by being _unlinked_ — a change to a link row the
  block's own row never sees — and a slice is a handful of notes.
- **Edits**: `useApplyOps` (the write seam, `src/data/store.ts`) refuses a
  batch that names a shared node, with a toast — a shared note says so on
  the first keystroke. Those rows are someone else's corpus, which the local
  store and the replica never hold.
- **Sync**: the ambient triggers the replica pull uses (visibility, focus,
  online) re-pull every slice, coalesced to one per 30 s.
- **How the UI sees it**: `graphSnapshotAtom` merges the own graph with the
  union of every slice, so the editor, search, hover cards and the notes list
  read a shared note exactly as they read an own one. `sharedOriginAtom`
  (node id → share id) is what tells them apart: the sidebar lists own notes
  under Notes and each share's notes under **Shared by …**, and the note page
  shows a notice naming the owner, renders read-only, and hides Rename, Pin,
  Delete and the basket.
- **A shared block is a note here.** A root may be a block, and a block has
  no page of its own to open; so on the way into the snapshot a root that is
  not a note is given the note type. It lists in the sidebar, opens at
  `/notes/<id>` with its text as the title and its children as the outline,
  and searches like any note. Nothing is pushed, so the owner's row is never
  touched by it.
- **Reading a shared note**: the same block editor as the reader's own
  notes, with editing off (`BlockEditor.browse`): the highlight moves, a
  click highlights, folds open and close and are kept per device, the
  default depth applies, `f` zooms. Nothing writes.
- **Where to share from**: a note's **⋯** menu (**Share…**) shares the note;
  a block's right-click menu (**Share…**) shares that block, as the root.
  One dialog, asking only for the address. Settings → Sharing is the
  overview: what this account has shared and with whom (with Revoke), and
  what has been shared with it.

## 5. Decisions, and what was not built

- **Grant, not space.** A view keeps the owner's corpus the single source of
  truth, needs no migration of rows and no second replica loop, and revoking
  is one row. The cost is that live collaboration is per-row LWW rather than a
  sequenced log — the same trade the app already makes across devices.
- **Roots are notes or blocks.** The closure walk is root-agnostic; the
  client presents a block root as a note so the grantee has somewhere to
  open it.
- **Email, resolved by the server from GitHub.** The alternative — sharing by
  GitHub login — would need a lookup box that confirms who exists. An address
  the owner already knows, matched against what GitHub reports, reveals
  nothing to anyone.
- **Whole-slice pulls, in memory.** Correct for the reasons above; cheap at
  the sizes shares have. If a share ever grows to a corpus, the fix is a
  per-share cache with a closure-aware cursor, not a change to the model.
- **Write and delete: a follow-up.** The grant already stores a verb set
  (`read` today, in the same form the MCP grant uses), so granting `write`
  and `delete` needs no migration. The follow-up adds a write route that
  takes a replica-shaped row diff and refuses it whole if any row would leave
  the slice — a node must be in the closure or a new id anchored to it, a
  link must have both ends inside — needs `delete` for a node tombstone and
  `write` for everything else, ignores the owner's cursor, and lands what
  passes through `planReplicaPut` into the owner's partition; and a client
  push path that applies ops to the slice at once, coalesces a row diff, and
  reverts on a refusal.
- **Not built**: a since-cursor for slices; showing the owner "this share includes N blocks also used elsewhere"
  (the multi-parent case is handled — such a block is in the slice — but not
  surfaced at share time); expiry on a share (revoke is the mechanism);
  per-row attribution of who wrote what.
