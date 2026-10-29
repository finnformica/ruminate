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

A pin is a property: `pinned_at`, the time the note or block was pinned (below). Until migrations/0015–0016 the props `pinned`, `filter` and `sort` held a note's place and how it opened; a row still carrying those keys is read like any other prop, which is to say not at all.

## Pins

Views are removed (see [removing-views.md](./removing-views.md)). The notes page, the outline from the root, is the one list of notes, in the order you drag them into.

**Pin** in the menu of a note or a block sets its `pinned_at` prop. **Unpin** takes the prop out. The sidebar's **Pinned** list, and the palette's Pinned group with nothing typed, show your pinned notes and blocks, oldest pin first. Beneath it, the sidebar's **Notes** list shows every note in the notes page's order: the same rows as the notes page, so the two never disagree. A pinned block's row opens its note focused on the block. A pin is an edit like any other, so it travels in the event log. A note someone shared with you has no **Pin**: its props are the owner's.

A filter and a sort are not saved on a note. They live in the address with the frames, so a link or a bookmark keeps them.

## No frontmatter

Properties are never read from or written to markdown. A leading `---` YAML block in pasted text is dropped rather than turned into blocks, and a note copied out as markdown carries its blocks only.
