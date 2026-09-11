# Metadata

A note's metadata is a small JSON object of properties on its page node — the `props` column of the graph (docs/graph-schema-v2.md). It is data, not text: nothing in the note body carries it, and it never renders as part of the note.

## Properties the app sets

| Key          | Set by                                   |
| :----------- | :--------------------------------------- |
| `title`      | Renaming the note (the page node's text) |
| `pinned`     | Pin / unpin                              |
| `font`       | The note's font choice                   |
| `width`      | The note's width choice                  |
| `updated_at` | Every save                               |

## Properties the app reads when present

These are recognised on notes that carry them (imported notes, or older notes written when frontmatter was editable):

| Key        | Effect                                                                                                                           |
| :--------- | :------------------------------------------------------------------------------------------------------------------------------- |
| `tags`     | List of tag names — added to the note's tags alongside `#tag` in the body (see [markdown-syntax.md](./markdown-syntax.md#tags)). |
| `alias`    | An alternative name the note is found by in search.                                                                              |
| `url`      | A link the note stands for; its favicon becomes the note's icon.                                                                 |
| `github`   | A GitHub login; the avatar becomes the note's icon.                                                                              |
| `birthday` | `YYYY-MM-DD` or `MM-DD`; the note shows the next birthday, and the date appears on the calendar.                                 |

Date-valued properties in general put the note on the calendar for that date.

## No frontmatter

Properties are never read from or written to markdown. A leading `---` YAML block in pasted text is dropped rather than turned into blocks, and a note copied out as markdown carries its blocks only.
