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

`pinned` is also set on blocks. Pinning a note puts it at the top of the sidebar's notes; pinning a block (**Pin** in the block's right-click menu) lists the block in the sidebar under **Pinned**, between the notes and the notes shared with you, and in the ⌘K palette's Pinned group after the pinned notes. A pinned block's row opens its note focused on that block — a focused view of the block and what is beneath it — and the row's **⋯** menu unpins it or copies a link to it. A block held in several notes opens in the note it was written in while that note still reaches it, otherwise in the first note that does. The pin is a prop on the block, so it is the owner's: a block in a note someone shared with you is never listed, and cannot be pinned from your side.

## Saved views

Any note, and any block, can carry a `filter` and a `sort` — the narrowing a note's header applies (see [query-language.md](./query-language.md), "Filtering a note in place"). With them the thing is not just a place but a **view**: "the open to-dos under this heading" rather than "this heading". Nothing has to be pinned for this; a pin merely puts the row in the sidebar, and what that row opens is decided here.

What saves the view is whatever the view is ROOTED at: the focused block when the page is focused on one, else the note itself. Both are nodes with props, so both remember a view the same way, and the header offers the same buttons on each.

**Where the view comes from.** The URL wins where it speaks — that is what makes a narrowed view a link — and the saved view fills the silence. So a `?filter=` in the address is the view; with no such param, the node's own is applied, which is how a note opens the way it was left. The two are told apart by presence, not by emptiness: an ABSENT param means "nothing said", and an EMPTY one (`?filter=`) means "explicitly none", which is how a filter is cleared on a note whose saved one is not empty. Without that distinction, clearing would drop the param, the saved view would come straight back, and the whole note would be unreachable.

**The save is always deliberate.** Changing the filter or sort puts a dot on the header button that moved, and that button's menu grows a footer offering **Update to default** (write what is on screen onto the node, and drop the params, since the node now says it) and **Reset to default** (drop the params and go back to what the node holds) — so a filter tried out in passing never overwrites the saved one.

The dot says which half moved; the buttons act on the **whole view**. A node holds one view, so settling it from the Sort menu keeps whatever the filter is set to, and the other way round. Both keys are absent when nothing is saved, and removed again by updating with the view cleared. A note shared with you saves nothing: its props are its owner's.

## No frontmatter

Properties are never read from or written to markdown. A leading `---` YAML block in pasted text is dropped rather than turned into blocks, and a note copied out as markdown carries its blocks only.
