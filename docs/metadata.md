# Metadata

A note's metadata is a small JSON object of properties on its page node — the `props` column of the graph (docs/graph-schema-v2.md). It is data, not text: nothing in the note body carries it, and it never renders as part of the note.

## Properties the app sets

| Key          | Set by                                   |
| :----------- | :--------------------------------------- |
| `title`      | Renaming the note (the page node's text) |
| `pinned`     | Pin / unpin (a note, or a block: below)  |
| `font`       | The note's font choice                   |
| `width`      | The note's width choice                  |
| `updated_at` | Every save                               |

Date-valued properties put the note on the calendar for that date. Any property can be searched with `has:`, `no:`, `key:value` and `sort:` (see [query-language.md](./query-language.md)).

## Pinned blocks

`pinned` is also set on blocks, and both kinds land in the same place. **Pinned** heads the sidebar and the notes page — above the notes, the pinned notes first and then the pinned blocks (**Pin** in a block's right-click menu) — and the ⌘K palette's Pinned group lists the two in that order as well. A pinned _note_ stays in the notes list below too, in whatever place the sort gives it: the pin is a second way to reach it, not a note taken out of the order, which is what leaves the order entirely to the sort (docs/graph-storage.md, "Ordering notes"). **Where the pin is drawn depends on what is drawing the row.** In the sidebar's lists it is the row's icon, on the left, in place of the note's own favicon: a nav row is a name and one glyph, the glyph is the only thing there to carry the state, and a favicon saying which kind of note this is earns its slot rather less than the pin does. Everywhere the block editor draws the row — the notes page, the palette, a search result, a note's own outline — the pin **trails the content**, in the slot that mirrors the marker at the row's head, and the row keeps the marker that says what it is. Those rows are blocks, drawn to one rhythm with a shared text column, and a pin in the head slot would displace a marker that means something (a to-do's checkbox, a bullet's dot, a heading's `#`) or be covered by the fold chevron the moment the row had anything in it.

A pinned block's row opens its note focused on that block — a focused view of the block and what is beneath it — and the row's **⋯** menu unpins it or copies a link to it. A block held in several notes opens in the note it was written in while that note still reaches it, otherwise in the first note that does. The pin is a prop on the block, so it is the owner's: a block in a note someone shared with you is never listed, and cannot be pinned from your side.

## No frontmatter

Properties are never read from or written to markdown. A leading `---` YAML block in pasted text is dropped rather than turned into blocks, and a note copied out as markdown carries its blocks only.
