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

Whether a note is pinned, and the filter and sort it opens with, are **not** properties: they are its view (below), a row of its own beside the graph. Until migrations/0015–0016 they were the props `pinned`, `filter` and `sort`; a row still carrying those keys is read like any other prop, which is to say not at all.

## Views

A **view** is a way into the graph: a node to start at, what of its subgraph to keep (a filter), how to lay that out (a sort), and whether it is **pinned** — kept to hand in the sidebar. A note is the view rooted at its page node; a focused block is the view rooted at that block. Views are rows in a table of their own (`views`, docs/graph-storage.md), one per node, keyed by the user rather than by the node's owner: the view is _your_ row about a node, which is what lets a note someone shared with you be pinned from your side, and what lets a pin outlive a block's every move — a moved block keeps its id, so it keeps its view; a duplicated one has a new id, so the copy has none. Deleting a node deletes its view with it.

A share is a view shared with someone ([sharing.md](./sharing.md)): the share row names the owner's view, so what is shared is the view's root, and the filter and sort saved on it are how the other person opens it.

**Views** heads the sidebar and the notes page — above the notes, the pinned notes first and then the pinned blocks (**Pin** in a note's **⋯** menu or a block's right-click menu) — and the ⌘K palette's Views group lists the two in that order as well. A pinned _note_ stays in the notes list below too, in whatever place the sort gives it: the pin is a second way to reach it, not a note taken out of the order, which is what leaves the order entirely to the sort (docs/graph-storage.md, "Ordering notes"). **Where the pin is drawn depends on what is drawing the row.** In the sidebar's lists it is the row's icon, on the left, in place of the note's own favicon: a nav row is a name and one glyph, the glyph is the only thing there to carry the state, and a favicon saying which kind of note this is earns its slot rather less than the pin does. Everywhere the block editor draws the row — the notes page, the palette, a search result, a note's own outline — the pin **trails the content**, in the slot that mirrors the marker at the row's head, and the row keeps the marker that says what it is. Those rows are blocks, drawn to one rhythm with a shared text column, and a pin in the head slot would displace a marker that means something (a to-do's checkbox, a bullet's dot, a heading's `#`) or be covered by the fold chevron the moment the row had anything in it.

**The sidebar lights the row you are actually on.** A note's row is current only at the note's ROOT: focus is a place of its own (`?block=`, block-editor-architecture.md), so focused into a block you are reading that block, not the note whole, and the note's row goes quiet. That is what keeps a pinned block's row the only thing lit rather than the block and its note at once. A pinned note IS lit twice, under **Views** and in **Notes** — the two rows are genuine duplicates of one destination, and each saying so is information rather than noise, as an open file is current in both of an editor's file lists.

A pinned block's row opens its note focused on that block — a focused view of the block and what is beneath it — and the row's **⋯** menu unpins it or copies a link to it. A block held in several notes opens in the note it was written in while that note still reaches it, otherwise in the first note that does. A view whose root the graph no longer holds — deleted on another device, a share taken back — is left out of the list rather than drawn as a row that opens nothing. Pinning is not an edit to the note, so it is not an undo step.

The list's order is the notes' sort, then the blocks in index order; the `sort_key` column that will let it be dragged into an order of its own is in the table and unread for now.

## Saved views

Any note, and any block, can save a **filter** and a **sort** — the narrowing a note's header applies (see [query-language.md](./query-language.md), "Filtering a note in place"). With them the thing is not just a place but a view in the fuller sense: "the open to-dos under this heading" rather than "this heading". Nothing has to be pinned for this; a pin merely puts the row in the sidebar, and what that row opens is decided here. The three are one row: the pin, the filter and the sort of a node are fields of the same view.

What saves the view is whatever the view is ROOTED at: the focused block when the page is focused on one, else the note itself. Both are nodes, and a view is rooted at a node, so both remember a view the same way, and the header offers the same buttons on each.

**Where the view comes from.** The URL wins where it speaks — that is what makes a narrowed view a link — and the saved view fills the silence. So a `?filter=` in the address is the view; with no such param, the node's own is applied, which is how a note opens the way it was left. The two are told apart by presence, not by emptiness: an ABSENT param means "nothing said", and an EMPTY one (`?filter=`) means "explicitly none", which is how a filter is cleared on a note whose saved one is not empty. Without that distinction, clearing would drop the param, the saved view would come straight back, and the whole note would be unreachable.

**The save is always deliberate.** Changing the filter or sort puts a dot on the header button that moved, and that button's menu grows a footer offering **Update to default** (write what is on screen onto the node, and drop the params, since the node now says it) and **Reset to default** (drop the params and go back to what the node holds) — so a filter tried out in passing never overwrites the saved one.

The dot says which half moved; the buttons act on the **whole view**. A node holds one view, so settling it from the Sort menu keeps whatever the filter is set to, and the other way round. A view with nothing in it — unpinned, no filter, no sort — is not kept: updating with the view cleared on an unpinned note removes the row. A note shared with you saves a view like any other, since the view is yours.

## No frontmatter

Properties are never read from or written to markdown. A leading `---` YAML block in pasted text is dropped rather than turned into blocks, and a note copied out as markdown carries its blocks only.
