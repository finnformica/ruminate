# Query language

Search your notes with Ruminate's [GitHub-style](https://docs.github.com/en/search-github/searching-on-github/searching-issues-and-pull-requests) query language. Here's how it works:

- A search query can contain any combination of qualifiers, which are key-value pairs separated by spaces. For example, `tag:log date:2021-07-11` matches notes with the `log` tag AND the date `2021-07-11`.
- To exclude notes matching a qualifier, prefix the qualifier with a hyphen. For example, `-tag:log` matches notes that do not have the `log` tag.
- To include multiple values in a qualifier, separate the values with commas. For example, `tag:article,book` matches notes with either the `article` OR `book` tag.
- Qualifiers can also be used to filter notes based on numerical ranges. To do this, use one of the following operators before the qualifier value: `>`, `<`, `>=`, `<=`. For example, `tags:>1` matches notes with more than one tag; `date:>=2021-01-01` matches notes with a date on or after `2021-01-01`.
- Text outside of qualifiers is used to fuzzy search the note's title and body. For example, `tag:recipe cookie` matches notes with the `recipe` tag that also contain the word "cookie" in the title or body.
- To search for a value that contains spaces, wrap the value in quotes. For example, `genre:"science fiction"` matches notes with `genre: science fiction` in their [frontmatter](/docs/metadata.md).
- Use `sort:` to order results. For example, `sort:title`, `sort:id:desc`, or multiple keys `sort:title,tags:desc`. Direction can be `asc` or `desc`. Default is `asc` for `id` and `title`. `tags` and `updated_at` default to `desc`.

## Qualifiers

| Key     | Example                                                                                                                                                                                                                                                                                |
| :------ | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`    | `id:1652342106359` matches the note with ID `1652342106359`.                                                                                                                                                                                                                           |
| `tag`   | `tag:recipe` matches notes with the `recipe` tag.                                                                                                                                                                                                                                      |
| `tags`  | `tags:>1` matches notes with more than one tag.                                                                                                                                                                                                                                        |
| `date`  | `date:2021-07-11` matches notes with the date `2021-07-11`.                                                                                                                                                                                                                            |
| `dates` | `dates:>1` matches notes with more than one date.                                                                                                                                                                                                                                      |
| `tasks` | `tasks:>0` matches notes with at least one open task.                                                                                                                                                                                                                                  |
| `no`    | `no:tags` matches notes without a tag. `no` can be used with any filter qualifier key or property key.                                                                                                                                                                                 |
| `has`   | `has:tags` matches notes with one or more tag. `has` can be used with any filter qualifier key or property key.                                                                                                                                                                        |
| `type`  | `type:daily` matches daily notes (`note`, `daily`, `weekly`, `template`). With a block-type value it matches _blocks_ instead — see below.                                                                                                                                             |
| `in`    | `in:1652342106359` scopes the query to what is _inside_ a note (by id, or by name: `in:"Reading list"`); with a block id, to the blocks under that block. See "Scoping with `in:`" below.                                                                                              |
| `sort`  | `sort:title`, `sort:id:desc`, `sort:tags,title:desc`. Supports `id`, `title`, `tags`, `updated_at`, and any property key. Use `:asc` or `:desc`. Default is `asc` for `id` and `title`. `tags` and `updated_at` default to `desc`. Multiple comma-separated sorts apply left-to-right. |

Unrecognized qualifier keys are assumed to be [property](/docs/metadata.md) keys. For example, `read:true` matches notes whose `read` property is `true`.

## Results are blocks

Any query with text in it — or a block-scoped `type:` (below) — resolves at _block_ granularity: the results are the individual blocks that match, at any depth, each shown with the note and ancestor path it came from. Searching `nvidia` returns the heading three levels down that says "nvidia", not just the file it lives in.

- **Expand a result in place** with the chevron or <kbd>→</kbd> to see the blocks inside it; <kbd>←</kbd> closes it again (and, from a revealed child, jumps to the block it sits under). Only the level you open is fetched, and it's remembered.
- <kbd>↵</kbd> **on a highlighted result** opens its note, zoomed to that block.
- <kbd>↵</kbd> **on the query itself** in <kbd>⌘</kbd> <kbd>K</kbd> (the "see all …" row) opens the full results view. That view is just a URL — `/?query=type:todo+tag:work` — so any filter is bookmarkable and back/forward behave.
- The result count is the number of **matched blocks**, alongside how many notes they live in. Blocks revealed by expanding are context, not matches, so they never change the count.

A query that names only notes — `tag:recipe` on its own, a date, a bare property qualifier, or an empty query — still lists notes: every block of every tagged note isn't a search result, it's your corpus.

## Scoping with `in:`

`in:` limits a query to what is downstream of a note or a block — the blocks inside it.

- `in:<note>` names a note by its id or by its name (quote a name with spaces: `in:"Reading list"`). `type:todo in:"Reading list"` is every open to-do in that note; `in:"Reading list"` on its own lists just that note.
- `in:<block id>` names a block; the query then runs over the blocks under it (the block itself is not inside itself). `type:heading in:blk_a1b2c3` lists the headings within that section.
- It composes like any qualifier: `-in:` excludes, `in:a,b` means either, and it stacks with `tag:`, `type:` and text.

**It is set for you inside a note.** Open <kbd>⌘</kbd> <kbd>K</kbd> from a note and block results are scoped to that note — or, if you have zoomed into a block, to that block — shown as a pill under the query (**Blocks in …**). Click the pill to search everything instead, or type your own `in:` to scope elsewhere. "See all …" carries the scope into the results view as a plain `in:` in the URL, so it reads back as what it is.

## Suggestions as you type

Typing a qualifier whose values are a known set opens a picker under the search box — on the notes and tags pages and in <kbd>⌘</kbd> <kbd>K</kbd>:

- `type:` — the block types below, then the note types.
- `in:` — your notes, by name, most recent first (the open note leads).
- `tag:` — your tags, with how many notes carry each.
- `has:` / `no:` — `tags`, `dates`, `tasks`, `title`.

Keep typing to narrow the list, <kbd>↑</kbd>/<kbd>↓</kbd> to move, <kbd>↵</kbd> or <kbd>Tab</kbd> to pick (a note lands as its id; a value with spaces is quoted), <kbd>Esc</kbd> to leave what you typed. `-type:` and comma lists (`type:todo,done`) work the same way.

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

Block queries compose with everything else: note-level qualifiers filter by the containing note (`type:todo tag:work` = open todos in notes tagged `work`), `in:` scopes to a note or a block's subtree, fuzzy text matches the block's own text (`type:todo milk`), `-type:done` excludes, and `sort:updated` orders blocks by their note's last update, most recent first.

Each result is drawn exactly as the block is in its note — by the editor's own row, so the same marker (dot, `#`, number, checkbox, `>`), the same type scale, the same collapse chevron in the marker slot and the same guide lines under an expanded result — with only the breadcrumb added to say where it lives. The `type:` vocabulary above is the block registry's: a query value names stored block types, so `type:ul` and the row's bullet mean the same thing.
