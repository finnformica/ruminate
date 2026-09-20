# Metadata

A note's metadata is a small JSON object of properties on its page node — the `props` column of the graph (docs/graph-schema-v2.md). It is data, not text: nothing in the note body carries it, and it never renders as part of the note.

## Properties the app sets

| Key          | Set by                                   |
| :----------- | :--------------------------------------- |
| `title`      | Renaming the note (the page node's text) |
| `pinned`     | Pin / unpin (a note, or a block: below)  |
| `filter`     | A saved view's filter (below)            |
| `sort`       | A saved view's sort (below)              |
| `font`       | The note's font choice                   |
| `width`      | The note's width choice                  |
| `updated_at` | Every save                               |

Date-valued properties put the note on the calendar for that date. Any property can be searched with `has:`, `no:`, `key:value` and `sort:` (see [query-language.md](./query-language.md)).

## Pinned blocks

`pinned` is also set on blocks, and both kinds land in the same place. **Pinned** heads the sidebar and the notes page — above the notes, the pinned notes first and then the pinned blocks (**Pin** in a block's right-click menu) — and the ⌘K palette's Pinned group lists the two in that order as well. A pinned _note_ stays in the notes list below too, in whatever place the sort gives it: the pin is a second way to reach it, not a note taken out of the order, which is what leaves the order entirely to the sort (docs/graph-storage.md, "Ordering notes"). **Where the pin is drawn depends on what is drawing the row.** In the sidebar's lists it is the row's icon, on the left, in place of the note's own favicon: a nav row is a name and one glyph, the glyph is the only thing there to carry the state, and a favicon saying which kind of note this is earns its slot rather less than the pin does. Everywhere the block editor draws the row — the notes page, the palette, a search result, a note's own outline — the pin **trails the content**, in the slot that mirrors the marker at the row's head, and the row keeps the marker that says what it is. Those rows are blocks, drawn to one rhythm with a shared text column, and a pin in the head slot would displace a marker that means something (a to-do's checkbox, a bullet's dot, a heading's `#`) or be covered by the fold chevron the moment the row had anything in it.

**The sidebar lights the row you are actually on.** A note's row is current only at the note's ROOT: focus is a place of its own (`?block=`, block-editor-architecture.md), so focused into a block you are reading that block, not the note whole, and the note's row goes quiet. That is what keeps a pinned block's row the only thing lit rather than the block and its note at once. A pinned note IS lit twice, under **Pinned** and in **Notes** — the two rows are genuine duplicates of one destination, and each saying so is information rather than noise, as an open file is current in both of an editor's file lists.

A pinned block's row opens its note focused on that block — a focused view of the block and what is beneath it — and the row's **⋯** menu unpins it or copies a link to it. A block held in several notes opens in the note it was written in while that note still reaches it, otherwise in the first note that does. The pin is a prop on the block, so it is the owner's: a block in a note someone shared with you is never listed, and cannot be pinned from your side.

## Saved views

Any note, and any block, can carry a `filter` and a `sort` — the narrowing a note's header applies (see [query-language.md](./query-language.md), "Filtering a note in place"). With them the thing is not just a place but a **view**: "the open to-dos under this heading" rather than "this heading". Nothing has to be pinned for this; a pin merely puts the row in the sidebar, and what that row opens is decided here.

What saves the view is whatever the view is ROOTED at: the focused block when the page is focused on one, else the note itself. Both are nodes with props, so both remember a view the same way, and the header offers the same buttons on each.

**Where the view comes from.** The URL wins where it speaks — that is what makes a narrowed view a link — and the saved view fills the silence. So a `?filter=` in the address is the view; with no such param, the node's own is applied, which is how a note opens the way it was left. The two are told apart by presence, not by emptiness: an ABSENT param means "nothing said", and an EMPTY one (`?filter=`) means "explicitly none", which is how a filter is cleared on a note whose saved one is not empty. Without that distinction, clearing would drop the param, the saved view would come straight back, and the whole note would be unreachable.

**The save is always deliberate.** Changing the filter or sort puts a dot on the header button that moved, and that button's menu grows a footer offering **Update to default** (write what is on screen onto the node, and drop the params, since the node now says it) and **Reset to default** (drop the params and go back to what the node holds) — so a filter tried out in passing never overwrites the saved one.

The dot says which half moved; the buttons act on the **whole view**. A node holds one view, so settling it from the Sort menu keeps whatever the filter is set to, and the other way round. Both keys are absent when nothing is saved, and removed again by updating with the view cleared. A note shared with you saves nothing: its props are its owner's.

## No frontmatter

Properties are never read from or written to markdown. A leading `---` YAML block in pasted text is dropped rather than turned into blocks, and a note copied out as markdown carries its blocks only.
