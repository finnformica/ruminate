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

| Key     | Example                                                                                                                                                                                                                                                                                                       |
| :------ | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`    | `id:1652342106359` matches the note with ID `1652342106359`.                                                                                                                                                                                                                                                  |
| `date`  | `date:2021-07-11` matches notes with the date `2021-07-11`.                                                                                                                                                                                                                                                   |
| `dates` | `dates:>1` matches notes with more than one date.                                                                                                                                                                                                                                                             |
| `tasks` | `tasks:>0` matches notes with at least one open task.                                                                                                                                                                                                                                                         |
| `no`    | `no:dates` matches notes without a date. `no` can be used with any filter qualifier key or property key.                                                                                                                                                                                                      |
| `has`   | `has:dates` matches notes with one or more date. `has` can be used with any filter qualifier key or property key.                                                                                                                                                                                             |
| `type`  | `type:daily` matches daily notes (`note`, `daily`, `weekly`, `template`). With a block-type value it matches _blocks_ instead — see below.                                                                                                                                                                    |
| `in`    | `in:1652342106359` scopes the query to what is _inside_ a note (by id, or by name: `in:"Reading list"`); with a block id, to the blocks under that block. See "Scoping with `in:`" below.                                                                                                                     |
| `sort`  | `sort:title`, `sort:id:desc`, `sort:updated_at,title:desc`. Supports `text` and `type` (a block's own), `id`, `title`, `updated_at`, and any property key. Use `:asc` or `:desc`. Default is `asc` for `id` and `title`. `updated_at` defaults to `desc`. Multiple comma-separated sorts apply left-to-right. |

Unrecognized qualifier keys are assumed to be [property](/docs/metadata.md) keys. For example, `read:true` matches notes whose `read` property is `true`.

## Results are blocks

Any query with text in it — or a block-scoped `type:` (below) — resolves at _block_ granularity: the results are the individual blocks that match, at any depth, each shown with the note and ancestor path it came from. Searching `nvidia` returns the heading three levels down that says "nvidia", not just the file it lives in.

- **Expand a result in place** with the chevron or <kbd>→</kbd> to see the blocks inside it; <kbd>←</kbd> closes it again (and, from a revealed child, jumps to the block it sits under). Only the level you open is fetched, and it's remembered.
- <kbd>↵</kbd> **on a highlighted result** opens its note, focused on that block.
- <kbd>↵</kbd> **on the query itself** in <kbd>⌘</kbd> <kbd>K</kbd> — straight after typing, with no item highlighted — opens the full results view. That view is just a URL — `/?query=type:todo+in:%22Reading+list%22` — so any filter is bookmarkable and back/forward behave.
- A note whose **title** matches the text is a result row too, ranked among the blocks **purely by score** — both are fast-fuzzy matches at the one threshold, so a title that matched well sits beside the blocks that matched as well, never in a bucket of its own. Ties keep the note above the block. A query that names a block type or an `in:` scope asks for blocks, so it lists no note rows; an explicit `sort:` orders the notes and then the blocks by the sort instead. The notes page and <kbd>⌘</kbd> <kbd>K</kbd> rank the same way.
- The result count is the number of **matched blocks**, alongside how many notes they live in, and how many notes matched by title. Blocks revealed by expanding are context, not matches, so they never change the count.

A query that names only notes — a date, a bare property qualifier, or an empty query — still lists notes: every block of every matching note isn't a search result, it's your corpus.

## Scoping with `in:`

`in:` limits a query to what is downstream of a note or a block — the blocks inside it.

- `in:<note>` names a note by its id or by its name (quote a name with spaces: `in:"Reading list"`). `type:todo in:"Reading list"` is every open to-do in that note; `in:"Reading list"` on its own lists just that note.
- `in:<block id>` names a block; the query then runs over the blocks under it (the block itself is not inside itself). `type:heading in:blk_a1b2c3` lists the headings within that section.
- It composes like any qualifier: `-in:` excludes, `in:a,b` means either, and it stacks with `type:`, a property and text.

**It is never set for you.** <kbd>⌘</kbd> <kbd>K</kbd> searches everything wherever it opens; inside a note, type `in:` and the open note leads the suggestions, so scoping to it is one pick. <kbd>⌘</kbd> <kbd>P</kbd> is the one preset: the palette with `type:heading` and `in:` the open note (or the focused block) already set — its headings, narrowed as you type.

## Filters as pills

The query box — on the notes page and in <kbd>⌘</kbd> <kbd>K</kbd> — keeps the qualifiers out of the line. A `key:value` you finish typing (a space after it, or a pick from the suggestions) is lifted out as a **pill** beneath the box: an `in:` named as the note (or note › block), anything else as typed (`type: todo`, `-type: done`, `sort: updated`). The line holds only the words you are searching for, and the query the app runs — and the `?query=` URL <kbd>↵</kbd> opens — is the pills and the words together, pills first. Click a pill to take it out; <kbd>⌫</kbd> on an empty line takes the last pill back into the line to edit; Clear (or <kbd>Esc</kbd> in the palette) empties both.

## Suggestions as you type

Typing a qualifier whose values are a known set opens a popover beside the token — on the notes page and in <kbd>⌘</kbd> <kbd>K</kbd>, the same one (`src/components/query-box.tsx`):

- `type:` — the block types below, each beside its markdown glyph, then the note types. Headings are offered as the one `heading` and lists as `bullet` and `ordered`; `h1`…`h3` and `list` still work typed.
- `in:` — your notes, by name, most recent first (the open note leads, even before it exists).
- `has:` / `no:` — `dates`, `tasks`, `title`.
- `sort:` — in two steps: the key (Text, Type, Title, Updated at), then, once the key and its colon are there, Ascending or Descending, written in full (`sort:title:asc`, `sort:updated_at:desc`). Typing `sort:title:` goes straight to the second step. (`sort:id` still works typed; an id is opaque, so it is not offered.) `text` and `type` sort blocks by their own text and their own type; the rest sort by the containing note.
- `date:` — the slash menu's date shortcuts (Today, Tomorrow, Yesterday, Next week, Last week — `dateShortcuts` in `src/blocks/slash-menu.ts`, the one source for both). The day is what lands in the query (`date:2026-09-14`), exactly as the slash menu writes a day into a note; type a word (`date:tomorrow`) to keep a query relative.

The rows are just the values, capitalised (a block type beside its glyph): no header, no glosses, no key hints. ↑/↓ move, ↵ or Tab pick, Esc closes.

Focus never leaves the box: keep typing to narrow the list, <kbd>↑</kbd>/<kbd>↓</kbd> to move, <kbd>↵</kbd> or <kbd>Tab</kbd> to pick (a note lands as its id; a value with spaces is quoted), <kbd>Esc</kbd> to leave what you typed. `-type:` and comma lists (`type:todo,done`) work the same way. On a phone, or in a narrow box, the popover takes the box's full width instead of hanging at the token.

## Filtering a note in place

The query language also narrows a note **where it stands**, rather than resolving to a list of results elsewhere. **Filter** and **Sort** sit beside the **⋯** menu at the top right of a note (and of a focused block):

- The rows that match stay. The rows above a match are kept as **context** and drawn dimmed — so you can see which heading a to-do lives under without that heading pretending to be a result. A branch holding no match is dropped.
- Everything beneath a match is kept as context too: a to-do you filtered to is still the to-do with its notes underneath.
- It is drawn by the block editor, from the note's own doc, so the markers, the typography, the folds and the keys are the note page's — a filtered note is the note, shorter, never a second kind of list.
- The filter and the sort live in the URL (`?filter=type:todo&sort=text:desc`), so a narrowed view is a link, and the back button takes the narrowing off.

**What a filter may say: everything.** A note's filter is run by the same engine that runs a search — `searchBlocks`, scoped to the note (`src/utils/view-narrowing.ts`) — so every qualifier above works here on the day it works in the box: `type:` on the block, `in:` on its ancestry, `has:` / `no:` / `date:` / a property on the containing note, `-` to exclude, comma lists to OR, and free text fuzzy-matched over the block's own text. Nothing is reimplemented, so the two cannot drift.

A note-level qualifier behaves honestly rather than being ignored: inside one note it holds for every row or for none, so `area:work` shows the whole note or nothing at all — which is exactly what the same query means in a search.

**The menu offers `type:` and nothing else.** The rest of the vocabulary is note-level, and inside a single note a note-level qualifier holds for every row or for none — so as a menu item it is not a filter but a switch between the whole note and a blank page. `in:` is left out for a different reason: it names the view's **root**, which is what focusing already does (a bullet, <kbd>f</kbd>, the breadcrumb). Both still work typed into a filter by hand, and mean there exactly what they mean in a search.

The block types the menu lists are the query box's own picker vocabulary (`STATIC_QUALIFIER_OPTIONS`), so a block type added to the registry appears in the note header with it.

**What a sort may say.** The **Sort** menu offers the keys that order a block by something of its own — `text` and `type` — each `:asc` (the default) or `:desc`, taken from the same two-step `sort:` picker the query box walks through. Several comma-separated keys apply left to right. `title` and `updated_at` remain in the language and in the box, but belong to the containing note, so inside one note they tie and reorder nothing; the menu does not offer them for that reason. Ordering is the search's own comparator (`compareBlockHits`), so `sort:text:desc` orders a note's rows exactly as it orders results.

A sort reorders each parent's **children** and leaves the nesting alone: a filtered outline is still an outline, and a single order over a tree is not something a reader can follow. Document order is the default, and the absence of a sort.

A filter that matches nothing shows an empty page, not a blank row to type in: a narrowed view writes no structure, so a row offered there could not be written.

**A narrowed view edits its rows, not the note's shape.** Tick a to-do, retype a line, change a block's properties — those land in the graph as they always do. Structure does not: a narrowed view holds only the rows that survived, in the order the sort put them, so reconciling it against the graph would read every hidden row as removed. New rows, indents, removals and reorders belong to the note, which is one click away with the filter cleared. For the same reason a narrowed view has no trailing blank row to type into.

A pinned block can save a filter and a sort of its own, so a pin becomes a view — see [metadata.md](./metadata.md).

## Block types

`type:` with a block-type value resolves the query at _block_ granularity. For example, `type:todo` finds every unchecked checkbox in your notes.

| Value           | Matches                                                   |
| :-------------- | :-------------------------------------------------------- |
| `text`          | plain paragraph                                           |
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
| `link`          | a link block (docs/links.md); text matches its title      |

Block queries compose with everything else: note-level qualifiers filter by the containing note (`type:todo area:work` = open todos in notes whose `area` property is `work`), `in:` scopes to a note or a block's subtree, fuzzy text matches the block's own text (`type:todo milk`), `-type:done` excludes, and `sort:updated` orders blocks by their note's last update, most recent first.

Each result is drawn exactly as the block is in its note — by the block editor itself, so the same marker (dot, `#`, number, checkbox, `>`), the same type scale, the same collapse chevron in the marker slot, the same guide lines under an opened result, and the same keys. The `type:` vocabulary above is the block registry's: a query value names stored block types, so `type:ul` and the row's bullet mean the same thing.
