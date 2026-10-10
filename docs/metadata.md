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

A **view** is a way into the graph: a node to start at, what of its subgraph to keep (a filter), how to lay that out (a sort), and where it sits in the list. Views are rows in a table of their own (`views`, docs/graph-storage.md), one per node, keyed by the user rather than by the node's owner: the view is _your_ row about a node, which is what lets a block in a note someone shared with you be a view from your side, and what lets a view outlive a block's every move — a moved block keeps its id, so it keeps its view; a duplicated one has a new id, so the copy has none. Deleting a node deletes its view with it.

**The Views list is the view rows.** A node is in the list exactly when its row says so (`pinned`), and that holds for a note, a board and a block alike: a note is not special, a row is what makes a node an entry point into the graph, and the node's type only says how it draws — a note as its outline, a board as its wall, a block as a focused view of that block and what is beneath it. Every note and every board is created with such a row, written in the same stroke as the node, and the ones from before `migrations/0021` were given theirs; a block gets one when you make it a view (**Add to Views** in its right-click menu). The row holds how the node opens and where it sits beside the listing itself, so a listed note's row says at least "listed", and more once a view is saved on it or it is dragged.

**Remove from Views** takes a node off the list and nothing else. On a note it clears the listing alone: the saved filter and sort stay, since the note still opens — from search, **Recent**, a link, its address, the calendar — and should open the way it was left, and its place in the order stays, so **Add to Views** puts it back where it was. On a block the row goes whole, filter and sort included, because away from the list a block is just a block in its note. (A note that saved nothing and was never dragged has nothing in its row but the listing, and that row goes the same way; on the wire the two are one tombstone.) Only your own notes have the pair: a note shared with you is listed under **Shared**, by the share, and has no place in your list to give up.

There is no pinning in the old sense. It used to be that a pinned note or block earned a place in a short list above the notes; now the Views list is the whole list, in an order that is yours to set (below), so "keep this to hand" is "drag it to the top". The `pinned` column keeps its name on the wire, and now means what it says, for every kind of node: listed.

A share is a view shared with someone ([sharing.md](./sharing.md)): the share row names the owner's view, so what is shared is the view's root, and the filter and sort saved on it are how the other person opens it.

**Views** is the sidebar's one list of your own — every note and every block view, under one heading, above what other people shared (**Shared**) — and it is the Views page (`/`) beneath **Recent**, and the ⌘K palette's Views group with nothing typed. A block view's row leads with the block's key — the very glyph the block editor sets in its key slot (`BlockKey`, `src/components/block-editor/block-key.tsx`): a bullet's dot, a to-do's box, a heading's `#`, a paragraph's `¶` — in the slot a note's favicon takes, so the row says what kind of block it opens on, the way the row in the note does, and the sidebar and the Views page never draw a type two ways. A figure has no key, so its row falls back to the markdown that stands for it. Everywhere the block editor draws the row — the Views page, the palette, a search result — a block view is a row like any other block's, with the marker that says what it is; nothing about the row itself says it is a view, because the list is where that shows.

**The sidebar lights the row you are actually on.** A note's row is current only at the note's ROOT: focus is a place of its own (`?block=`, block-editor-architecture.md), so focused into a block you are reading that block, not the note whole, and the note's row goes quiet. That is what keeps a block view's row the only thing lit rather than the block and its note at once.

A block view's row opens its note focused on that block, and the row's **⋯** menu is the block's menu away from its note — Copy, Copy link to block, Share…, and **Remove from Views** — the same list a right-click on the block's row on the Views page opens, with Move up and Move down ahead of it in the manual sort. A note's row has the note's menu, with **Remove from Views** among it, and the same menu on the Views page and in the open note's header offers **Add to Views** once the note is off the list. A block held in several notes opens in the note it was written in while that note still reaches it, otherwise in the first note that does. A view whose root the graph no longer holds — deleted on another device, a share taken back — is left out of the list rather than drawn as a row that opens nothing. Making a view is not an edit to the note, so it is not an undo step.

**The list is yours to order.** The sort menu over the heading — **Name**, **Recently updated**, **Manual** — orders notes and block views together, by the name on the row or by when it was last edited. In **Manual**, drag a row, or use **Move up** and **Move down** in its menu, and it stays where you put it: the order is the views' `sort_key`, the same fractional index a block's child link carries, so a move rewrites one row — every row in the list has one, since the row is what lists it. Nothing is keyed until the first drag — until then the list is the notes in their order (docs/graph-storage.md, "Ordering notes"), then the block views in index order — and a view added later joins the end of what has been ordered rather than jumping the queue. Notes and blocks are one list and one order: a block can sit between two notes.

## Saved views

Any note, and any block, can save a **filter** and a **sort** — the narrowing a note's header applies (see [query-language.md](./query-language.md), "Filtering a note in place"). With them the thing is not just a place but a view in the fuller sense: "the open to-dos under this heading" rather than "this heading". Saving one does not put a note in the Views list or take it out — the listing is the row's own field — and a block that saves one has a row, and joins the list by it. The fields are one row: the filter, the sort, the listing and the place of a node are fields of the same view.

What saves the view is whatever the view is ROOTED at: the focused block when the page is focused on one, else the note itself. Both are nodes, and a view is rooted at a node, so both remember a view the same way, and the header offers the same buttons on each.

**Where the view comes from.** The URL wins where it speaks — that is what makes a narrowed view a link — and the saved view fills the silence. So a `?filter=` in the address is the view; with no such param, the node's own is applied, which is how a note opens the way it was left. The two are told apart by presence, not by emptiness: an ABSENT param means "nothing said", and an EMPTY one (`?filter=`) means "explicitly none", which is how a filter is cleared on a note whose saved one is not empty. Without that distinction, clearing would drop the param, the saved view would come straight back, and the whole note would be unreachable.

**The save is always deliberate.** Changing the filter or sort puts a dot on the header button that moved, and that button's menu grows a footer offering **Update to default** (write what is on screen onto the node, and drop the params, since the node now says it) and **Reset to default** (drop the params and go back to what the node holds) — so a filter tried out in passing never overwrites the saved one.

The dot says which half moved; the buttons act on the **whole view**. A node holds one view, so settling it from the Sort menu keeps whatever the filter is set to, and the other way round. A row with nothing in it — not listed, no filter, no sort, no place in the order — is not kept, so removing a block from Views leaves no empty row behind; a listed note's row is never empty, since the listing is in it, so updating with the view cleared leaves the note's row holding its listing and its place. A note shared with you saves a view like any other, since the view is yours.

## No frontmatter

Properties are never read from or written to markdown. A leading `---` YAML block in pasted text is dropped rather than turned into blocks, and a note copied out as markdown carries its blocks only.
