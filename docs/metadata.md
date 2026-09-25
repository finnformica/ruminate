# Metadata

A note's metadata is a small JSON object of properties on its page node — the `props` column of the graph (docs/graph-schema-v2.md). It is data, not text: nothing in the note body carries it, and it never renders as part of the note.

## Properties the app sets

| Key          | Set by                                   |
| :----------- | :--------------------------------------- |
| `title`      | Renaming the note (the page node's text) |
| `font`       | The note's font choice                   |
| `width`      | The note's width choice                  |
| `updated_at` | Every save                               |

Date-valued properties put the note on the calendar for that date. Any property can be searched with `has:`, `no:`, `key:value` and `sort:` (see [query-language.md](./query-language.md)).

The filter and sort a note opens with, and its place in the Views list, are **not** properties: they are its view (below), a row of its own beside the graph. Until migrations/0015–0016 they were the props `pinned`, `filter` and `sort`; a row still carrying those keys is read like any other prop, which is to say not at all.

## Views

A **view** is a way into the graph: a node to start at, what of its subgraph to keep (a filter), how to lay that out (a sort), and where it sits in the list. **Every note is a view** — the one rooted at its page node — and a block becomes one when you make it one (**Add to Views** in its right-click menu): a focused view of that block and what is beneath it. Views are rows in a table of their own (`views`, docs/graph-storage.md), one per node, keyed by the user rather than by the node's owner: the view is _your_ row about a node, which is what lets a block in a note someone shared with you be a view from your side, and what lets a view outlive a block's every move — a moved block keeps its id, so it keeps its view; a duplicated one has a new id, so the copy has none. Deleting a node deletes its view with it. A note needs no row to be a view — it is listed whether or not anything was ever saved about it — and its row, when it has one, holds only how it opens and where it sits. A block is a view exactly when it has a row: **Remove from Views** clears the row whole, saved filter and sort included, so the block is no view at all.

There is no pinning. It used to be that a pinned note or block earned a place in a short list above the notes; now the Views list is the whole list, in an order that is yours to set (below), so "keep this to hand" is "drag it to the top". The `pinned` column stays on the wire with a narrower meaning: it is what keeps a block's row alive when the block saves no filter and no sort, and it is never written for a note.

A share is a view shared with someone ([sharing.md](./sharing.md)): the share row names the owner's view, so what is shared is the view's root, and the filter and sort saved on it are how the other person opens it.

**Views** is the sidebar's one list of your own — every note and every block view, under one heading, above what other people shared (**Shared**) — and it is the Views page (`/`) beneath **Recent**, and the ⌘K palette's Views group with nothing typed. A block view's row leads with the block's own markdown marker — a bullet's `-`, a to-do's `[ ]`, a heading's `#` — in the slot a note's favicon takes, so the row says what kind of block it opens on, the way the row in the note does. Everywhere the block editor draws the row — the Views page, the palette, a search result — a block view is a row like any other block's, with the marker that says what it is; nothing about the row itself says it is a view, because the list is where that shows.

**The sidebar lights the row you are actually on.** A note's row is current only at the note's ROOT: focus is a place of its own (`?block=`, block-editor-architecture.md), so focused into a block you are reading that block, not the note whole, and the note's row goes quiet. That is what keeps a block view's row the only thing lit rather than the block and its note at once.

A block view's row opens its note focused on that block, and the row's **⋯** menu takes it out of Views or copies a link to it. A block held in several notes opens in the note it was written in while that note still reaches it, otherwise in the first note that does. A view whose root the graph no longer holds — deleted on another device, a share taken back — is left out of the list rather than drawn as a row that opens nothing. Making a view is not an edit to the note, so it is not an undo step.

**The list is yours to order.** The sort menu over the heading — **Name**, **Recently updated**, **Manual** — orders notes and block views together, by the name on the row or by when it was last edited. In **Manual**, drag a row, or use **Move up** and **Move down** in its menu, and it stays where you put it: the order is the views' `sort_key`, the same fractional index a block's child link carries, so a move rewrites one row, and a note that had no row gets one holding nothing but its place. Nothing is keyed until the first drag — until then the list is the notes in their order (docs/graph-storage.md, "Ordering notes"), then the block views in index order — and a view added later joins the end of what has been ordered rather than jumping the queue. Notes and blocks are one list and one order: a block can sit between two notes.

## Saved views

Any note, and any block, can save a **filter** and a **sort** — the narrowing a note's header applies (see [query-language.md](./query-language.md), "Filtering a note in place"). With them the thing is not just a place but a view in the fuller sense: "the open to-dos under this heading" rather than "this heading". A note is in the Views list either way; a block that saves one is thereby a view of its own, and joins the list. The fields are one row: the filter, the sort and the place of a node are fields of the same view.

What saves the view is whatever the view is ROOTED at: the focused block when the page is focused on one, else the note itself. Both are nodes, and a view is rooted at a node, so both remember a view the same way, and the header offers the same buttons on each.

**Where the view comes from.** The URL wins where it speaks — that is what makes a narrowed view a link — and the saved view fills the silence. So a `?filter=` in the address is the view; with no such param, the node's own is applied, which is how a note opens the way it was left. The two are told apart by presence, not by emptiness: an ABSENT param means "nothing said", and an EMPTY one (`?filter=`) means "explicitly none", which is how a filter is cleared on a note whose saved one is not empty. Without that distinction, clearing would drop the param, the saved view would come straight back, and the whole note would be unreachable.

**The save is always deliberate.** Changing the filter or sort puts a dot on the header button that moved, and that button's menu grows a footer offering **Update to default** (write what is on screen onto the node, and drop the params, since the node now says it) and **Reset to default** (drop the params and go back to what the node holds) — so a filter tried out in passing never overwrites the saved one.

The dot says which half moved; the buttons act on the **whole view**. A node holds one view, so settling it from the Sort menu keeps whatever the filter is set to, and the other way round. A row with nothing in it — not kept as a block view, no filter, no sort, no place in the order — is not kept: updating with the view cleared on a note that was never dragged removes the row, and the note is in the list regardless. A note shared with you saves a view like any other, since the view is yours.

## No frontmatter

Properties are never read from or written to markdown. A leading `---` YAML block in pasted text is dropped rather than turned into blocks, and a note copied out as markdown carries its blocks only.
