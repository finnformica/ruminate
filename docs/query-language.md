# Query language

Search your notes with Ruminate's [GitHub-style](https://docs.github.com/en/search-github/searching-on-github/searching-issues-and-pull-requests) query language. Here's how it works:

- A search query can contain any combination of qualifiers, which are key-value pairs separated by spaces. For example, `type:daily date:2021-07-11` matches daily notes with the date `2021-07-11`.
- To exclude notes matching a qualifier, prefix the qualifier with a hyphen. For example, `-type:daily` matches notes that are not daily notes.
- To include multiple values in a qualifier, separate the values with commas. For example, `genre:article,book` matches notes whose `genre` property is either `article` OR `book`.
- Qualifiers can also be used to filter notes based on numerical ranges. To do this, use one of the following operators before the qualifier value: `>`, `<`, `>=`, `<=`. For example, `dates:>1` matches notes with more than one date; `date:>=2021-01-01` matches notes with a date on or after `2021-01-01`.
- Text outside of qualifiers is used to fuzzy search the note's title and body. For example, `genre:recipe cookie` matches notes with the `recipe` genre that also contain the word "cookie" in the title or body.
- To search for a value that contains spaces, wrap the value in quotes. For example, `genre:"science fiction"` matches notes with `genre: science fiction` in their [properties](/docs/metadata.md).
- Use `sort:` to order results. For example, `sort:title`, `sort:id:desc`, or multiple keys `sort:title,updated_at:desc`. Direction can be `asc` or `desc`. Default is `asc` for `id` and `title`. `updated_at` defaults to `desc`.

## Qualifiers

| Key     | Example                                                                                                                                                                                                                                                                    |
| :------ | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`    | `id:1652342106359` matches the note with ID `1652342106359`.                                                                                                                                                                                                               |
| `date`  | `date:2021-07-11` matches notes with the date `2021-07-11`.                                                                                                                                                                                                                |
| `dates` | `dates:>1` matches notes with more than one date.                                                                                                                                                                                                                          |
| `tasks` | `tasks:>0` matches notes with at least one open task.                                                                                                                                                                                                                      |
| `no`    | `no:dates` matches notes without a date. `no` can be used with any filter qualifier key or property key.                                                                                                                                                                   |
| `has`   | `has:dates` matches notes with one or more date. `has` can be used with any filter qualifier key or property key.                                                                                                                                                          |
| `type`  | `type:daily` matches daily notes (`note`, `daily`, `weekly`, `template`). With a block-type value it matches _blocks_ instead — see below.                                                                                                                                 |
| `in`    | `in:1652342106359` scopes the query to what is _inside_ a note (by id, or by name: `in:"Reading list"`); with a block id, to the blocks under that block. See "Scoping with `in:`" below.                                                                                  |
| `sort`  | `sort:title`, `sort:id:desc`, `sort:updated_at,title:desc`. Supports `id`, `title`, `updated_at`, and any property key. Use `:asc` or `:desc`. Default is `asc` for `id` and `title`. `updated_at` defaults to `desc`. Multiple comma-separated sorts apply left-to-right. |

Unrecognized qualifier keys are assumed to be [property](/docs/metadata.md) keys. For example, `read:true` matches notes whose `read` property is `true`.

## Results are blocks

Any query with text in it — or a block-scoped `type:` (below) — resolves at _block_ granularity: the results are the individual blocks that match, at any depth, each shown with the note and ancestor path it came from. Searching `nvidia` returns the heading three levels down that says "nvidia", not just the file it lives in.

- **Expand a result in place** with the chevron or <kbd>→</kbd> to see the blocks inside it; <kbd>←</kbd> closes it again (and, from a revealed child, jumps to the block it sits under). Only the level you open is fetched, and it's remembered.
- <kbd>↵</kbd> **on a highlighted result** opens its note, zoomed to that block.
- <kbd>↵</kbd> **on the query itself** in <kbd>⌘</kbd> <kbd>K</kbd> — straight after typing, with no item highlighted — opens the full results view. That view is just a URL — `/?query=type:todo+in:%22Reading+list%22` — so any filter is bookmarkable and back/forward behave.
- A note whose **title** matches the text is a result row too, ranked among the blocks **purely by score** — both are fast-fuzzy matches at the one threshold, so a title that matched well sits beside the blocks that matched as well, never in a bucket of its own. Ties keep the note above the block. A query that names a block type or an `in:` scope asks for blocks, so it lists no note rows; an explicit `sort:` orders the notes and then the blocks by the sort instead. The notes page and <kbd>⌘</kbd> <kbd>K</kbd> rank the same way.
- The result count is the number of **matched blocks**, alongside how many notes they live in, and how many notes matched by title. Blocks revealed by expanding are context, not matches, so they never change the count.

A query that names only notes — a date, a bare property qualifier, or an empty query — still lists notes: every block of every matching note isn't a search result, it's your corpus.

## Scoping with `in:`

`in:` limits a query to what is downstream of a note or a block — the blocks inside it.

- `in:<note>` names a note by its id or by its name (quote a name with spaces: `in:"Reading list"`). `type:todo in:"Reading list"` is every open to-do in that note; `in:"Reading list"` on its own lists just that note.
- `in:<block id>` names a block; the query then runs over the blocks under it (the block itself is not inside itself). `type:heading in:blk_a1b2c3` lists the headings within that section.
- It composes like any qualifier: `-in:` excludes, `in:a,b` means either, and it stacks with `type:`, a property and text.

**It is never set for you.** <kbd>⌘</kbd> <kbd>K</kbd> searches everything wherever it opens; inside a note, type `in:` and the open note leads the suggestions, so scoping to it is one pick. <kbd>⌘</kbd> <kbd>P</kbd> is the one preset: the palette with `type:heading` and `in:` the open note (or the zoomed block) already set — its headings, narrowed as you type.

## Filters as pills

The query box — on the notes page and in <kbd>⌘</kbd> <kbd>K</kbd> — keeps the qualifiers out of the line. A `key:value` you finish typing (a space after it, or a pick from the suggestions) is lifted out as a **pill** beneath the box: an `in:` named as the note (or note › block), anything else as typed (`type: todo`, `-type: done`, `sort: updated`). The line holds only the words you are searching for, and the query the app runs — and the `?query=` URL <kbd>↵</kbd> opens — is the pills and the words together, pills first. Click a pill to take it out; <kbd>⌫</kbd> on an empty line takes the last pill back into the line to edit; Clear (or <kbd>Esc</kbd> in the palette) empties both.

## Suggestions as you type

Typing a qualifier whose values are a known set opens a popover beside the token — on the notes page and in <kbd>⌘</kbd> <kbd>K</kbd>, the same one (`src/components/query-box.tsx`):

- `type:` — the block types below, then the note types.
- `in:` — your notes, by name, most recent first (the open note leads).
- `has:` / `no:` — `dates`, `tasks`, `title`.
- `sort:` — `title`, `updated_at`, `id`, each with its other direction (`title:desc`); typing `sort:title:` narrows to it.
- `date:` — the slash menu's date shortcuts (Today, Tomorrow, Yesterday, Next week, Last week — `dateShortcuts` in `src/blocks/slash-menu.ts`, the one source for both), each glossed with the day it means. The day is what lands in the query (`date:2026-09-14`), exactly as the slash menu writes a day into a note; type a word (`date:tomorrow`) to keep a query relative.

Focus never leaves the box: keep typing to narrow the list, <kbd>↑</kbd>/<kbd>↓</kbd> to move, <kbd>↵</kbd> or <kbd>Tab</kbd> to pick (a note lands as its id; a value with spaces is quoted), <kbd>Esc</kbd> to leave what you typed. `-type:` and comma lists (`type:todo,done`) work the same way. On a phone, or in a narrow box, the popover takes the box's full width instead of hanging at the token.

## Block types

`type:` with a block-type value resolves the query at _block_ granularity. For example, `type:todo` finds every unchecked checkbox in your notes.

| Value           | Matches                                                   |
| :-------------- | :-------------------------------------------------------- |
| `todo`          | unchecked checkbox                                        |
| `done`          | checked checkbox                                          |
| `task`          | any checkbox, checked or not                              |
| `heading`       | any heading                                               |
| `h1`…`h3`       | a specific heading type                                   |
| `list`          | bullet or ordered list item                               |
| `bullet` / `ul` | bullet list item                                          |
| `ordered`/ `ol` | ordered list item                                         |
| `quote`         | quote                                                     |
| `code`          | a code block (or a fenced line in old notes)              |
| `image`         | an image block (docs/images.md); text matches its caption |
| `text`          | plain paragraph                                           |

Block queries compose with everything else: note-level qualifiers filter by the containing note (`type:todo area:work` = open todos in notes whose `area` property is `work`), `in:` scopes to a note or a block's subtree, fuzzy text matches the block's own text (`type:todo milk`), `-type:done` excludes, and `sort:updated` orders blocks by their note's last update, most recent first.

Each result is drawn exactly as the block is in its note — by the block editor itself, so the same marker (dot, `#`, number, checkbox, `>`), the same type scale, the same collapse chevron in the marker slot, the same guide lines under an opened result, and the same keys. The `type:` vocabulary above is the block registry's: a query value names stored block types, so `type:ul` and the row's bullet mean the same thing.
