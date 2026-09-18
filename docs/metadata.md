# Metadata

A note's metadata is a small JSON object of properties on its page node — the `props` column of the graph (docs/graph-schema-v2.md). It is data, not text: nothing in the note body carries it, and it never renders as part of the note.

## Properties the app sets

| Key          | Set by                                   |
| :----------- | :--------------------------------------- |
| `title`      | Renaming the note (the page node's text) |
| `pinned`     | Pin / unpin (a note, or a block: below)  |
| `filter`     | A pinned block's saved filter (below)    |
| `sort`       | A pinned block's saved sort (below)      |
| `font`       | The note's font choice                   |
| `width`      | The note's width choice                  |
| `updated_at` | Every save                               |

Date-valued properties put the note on the calendar for that date. Any property can be searched with `has:`, `no:`, `key:value` and `sort:` (see [query-language.md](./query-language.md)).

## Pinned blocks

`pinned` is also set on blocks. Pinning a note puts it at the top of the sidebar's notes; pinning a block (**Pin** in the block's right-click menu) lists the block in the sidebar under **Pinned**, between the notes and the notes shared with you, and in the ⌘K palette's Pinned group after the pinned notes. A pinned block's row opens its note focused on that block — a focused view of the block and what is beneath it — and the row's **⋯** menu unpins it or copies a link to it. A block held in several notes opens in the note it was written in while that note still reaches it, otherwise in the first note that does. The pin is a prop on the block, so it is the owner's: a block in a note someone shared with you is never listed, and cannot be pinned from your side.

### A pin's saved view

A pinned block can also carry a `filter` and a `sort` — the narrowing a note's header applies (see [query-language.md](./query-language.md), "Filtering a note in place"). With them the pin is not just a place but a **view**: "the open to-dos under this heading" rather than "this heading". Opening the row from the sidebar applies them, so it comes back as it was left.

They are only ever written on purpose. Changing the filter or sort of a pinned block puts a dot on the button that moved and offers **Update to default** (write what is on screen onto the pin) and **Reset to default** (put the pin's own back) — so a filter tried out in passing never overwrites the saved one. Both keys are absent when the pin saved none, and removed again by updating with the view cleared.

## No frontmatter

Properties are never read from or written to markdown. A leading `---` YAML block in pasted text is dropped rather than turned into blocks, and a note copied out as markdown carries its blocks only.
