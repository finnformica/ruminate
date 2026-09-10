# Graph-native app: retiring the markdown bridge

Status: **investigation** (2026-09-10). Extends
[editor-on-graph.md](./editor-on-graph.md) (which assessed the same move
from the editor's side) and [graph-schema-v2.md](./graph-schema-v2.md) (the
storage this runs on); the mutation model below is shaped to fit
[event-sourcing-design.md](./event-sourcing-design.md) without depending on
it. Nothing here is built.

## 0. The target

A block is a row: `text`, a `type`, some `props`, an `updated_at`. Containment
is link rows with sort keys. Everything the app shows is a **view**: a graph
slice built from one or more starting points under constraints (filters,
depth, folds), rendered as a flat list of block occurrences indented by their
depth in that slice. The notes page is the view whose one starting point is a
page node; a filtered view has many; the sidebar is a special-cased query over
page nodes. Creating a block is one node row and one link row.

Markdown survives as **look and feel**, not as a data path: block text
renders with inline markdown (bold, links, code spans), typing `# ` or `[ ] `
at the start of a block still sets its type, and copy, paste, templates,
gists and the sample notes still speak markdown at the edge. Nothing between
the store and the screen is a string.

The storage already is this (graph-schema-v2.md). What follows is the
inventory of everything above it that is not.

## 1. What stays

- **Storage, sync, Worker.** `nodes` + `link`, soft deletes, per-row LWW,
  the replica push/pull of rows, tenancy. Untouched. `NoteStore` already
  exposes `upstream`, `downstream`, `addLink`, `removeLink` with cycle
  rejection and delete-rescue; today nothing calls them.
- **The write planner.** `planNoteWrite` in `sql-note-store.ts` reconciles
  per parent, keeps unchanged rows, tombstones dropped links, rescues
  orphans. It takes `nodes` + `childrenOf`; only its input is markdown.
- **Rendering primitives.** `block-marker.tsx` (marker slot, type scale,
  chevron), `block-content.tsx` (inline markdown of a block's text),
  `slash-menu.tsx`, `note-title.tsx`, the keymap. All of these already work
  on "a type and some text"; they just receive it as a marker-prefixed
  string today.
- **The command vocabulary.** The 36 commands in `commands.ts` (indent,
  outdent, split, merge, move, duplicate, turn-into, zoom, fold…) are the
  right verbs. Their implementations move from tree-of-strings to graph ops.
- **Markdown at the edge.** `parse` (import), `serialize`/`rollup` (export),
  `html-to-markdown.ts` (foreign paste), `rich-clipboard.ts` (copy/paste
  between notes), the EJS templates, the gist share page, the sample notes.

## 2. The bridge, in full

Everything below handles a note as a markdown string. Fate: **retire** (goes
away), **retarget** (same job, reads the graph), **edge** (stays, import or
export only).

| Seam                                         | Where                                                                                                              | What it does today                                                                                                       | Fate     |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ | -------- |
| `markdownFilesAtom` / `databaseFilesAtom`    | `global-state.ts`, `database-mode.ts` (synthesizeFiles, applyToFilesAtom, notesFromFiles)                          | On every write and pull, rolls up **every** page to `<id>.md` strings; the UI's only source                              | retire   |
| `notesAtom` → `parseNote`                    | `global-state.ts:241`, `utils/parse-note.ts` (270 lines, mdast)                                                    | Re-parses every string for title, tags, dates, tasks, frontmatter, type, pinned, displayName                             | retarget |
| `blockIndexAtom`                             | `utils/block-search.ts` (`indexNoteBlocks` → `parse`)                                                              | Re-parses every string a second time to index blocks; ancestry and child counts re-derived from text                     | retarget |
| `BlockNoteEditor`                            | `block-editor/block-note-editor.tsx` (238)                                                                         | `parse(value)` on load, `serialize(doc)` on every keystroke; re-parses on external change                                | retire   |
| `useEditorValue`                             | `hooks/editor-value.ts` (117)                                                                                      | A local markdown string with debounced write-through autosave; flush on hide/unmount                                     | retire   |
| `useSaveNote` / `useWriteNotes` / `store.ts` | `hooks/note.ts`, `data/store.ts`, `database-mode.ts` (`databaseWriteFiles`)                                        | Stamps `updated_at` into YAML frontmatter, writes `<id>.md`, queues `store.writeNotes` which `parse`s it back into rows  | retire   |
| `docToGraphParts` calling `parse`            | `data/graph.ts`                                                                                                    | The ingest half; re-mints a node reachable twice in one page, forking shared nodes on every save                         | edge     |
| `Block.content` + `getBlockType(content)`    | `blocks/types.ts`, `blocks/block-type.ts` (122)                                                                    | The editor's block _is_ a marker-prefixed string; type derived by regex at render; `toggleTodo`, `withMarker` rewrite it | retarget |
| `ops.ts`, `commands.ts`, `history.ts`        | `blocks/` (351, 681, 87)                                                                                           | Tree ops on `BlockDoc` (one `children` array per id); undo keeps whole-doc snapshots                                     | retarget |
| `BlockEditor` / `BlockItem`                  | `block-editor/` (1,506, 670)                                                                                       | Recursive render of `doc.blocks[id].children`; every position, selection, fold and DOM hook keyed by bare id             | retarget |
| Collapse state                               | `data/view-state.ts`                                                                                               | One set of collapsed ids per **note id** in localStorage                                                                 | retarget |
| Frontmatter edits                            | `utils/frontmatter.ts` (365) via `note-actions-menu.tsx`, the note route, `note.ts`, `task.ts`, `command-menu.tsx` | Pin, width, font, gist id, title, `updated_at`: YAML text rewrites of the note string                                    | retarget |
| Task move                                    | `hooks/task.ts` (71)                                                                                               | Cuts a line out of one note's string by byte offset, appends it to another's                                             | retarget |
| Tag rename / delete                          | `hooks/tag.ts` (47)                                                                                                | Regex over the content of every note                                                                                     | retarget |
| New note / templates                         | `hooks/create-new-note.ts`, `command-menu.tsx`, the note route (`renderTemplate`)                                  | Builds a markdown string (EJS for daily/weekly), writes it as the note                                                   | edge     |
| Headings / outline                           | `utils/headings.ts` (regex over content), `utils/note-outline.ts` (over the doc)                                   | Palette's per-note headings and ⌘P outline                                                                               | retarget |
| Paste-as-link, upstream index                | `utils/resolve-blocks.ts`, `utils/block-upstream.ts`, `hooks/is-developer.ts`                                      | Scan `id::` lines across every string to find a block's subtree / its parents                                            | retarget |
| Previews                                     | `note-preview.tsx`, `note-preview-card.tsx`, `hover-card.tsx`, `nav-items.tsx` via `Markdown` (908)                | Render `note.content` as a markdown document                                                                             | retarget |
| `Note.content`                               | `schema.ts` and ~20 readers                                                                                        | The string itself, carried on every note object                                                                          | retire   |
| Gist share                                   | `routes/share.$gistId.tsx`, `utils/gist.ts`                                                                        | Publishes the rollup; renders a fetched gist as markdown                                                                 | edge     |

Two things stand out. First, the bridge is one loop: **store → rollup every
page → strings → parse (three times) → UI → serialize → parse → rows**, and
every item above is a consequence of that loop. Second, the Worker never sees
any of it, so the whole change is client-side and shippable in pieces.

## 3. Target architecture

### 3.1 The block

```ts
interface Block {
  id: string
  type: BlockType // the type registry: page | text | h1 | todo | done | ul | ol | quote | code | …
  text: string // marker-free; inline markdown allowed
  props: Record<string, unknown> | null // pages: frontmatter entries; code: { language }
  updatedAt: number
}
```

This is `NodeRow` with `props` parsed. `getBlockType(content)` becomes
`block.type`; `stripMarker` disappears from the render path; `toggleTodo`
becomes `setType(id, type === "todo" ? "done" : "todo")`; the turn-into keys
become `setType`. Markers exist in exactly two places: `parse` (import) and
`serialize` (export). The one marker behaviour that survives in the editor is
the **typing shortcut**: a block whose text begins with `# `, `- `, `[ ] `,
`> `, `1. ` at the moment of typing has the marker stripped and its type set,
which is `leadingMarker` applied once, in the change handler.

### 3.2 The view

```ts
interface ViewQuery {
  roots: string[] // starting points: page ids or block ids
  scope?: ScopeFilter // in: — restrict to what is downstream of these
  where?: BlockFilter[] // type, text, props, tag, date constraints on the roots
  folds: ReadonlySet<OccurrenceKey> // what the reader has collapsed
  maxDepth?: number // the rollup's depth cap (64) by default
}

interface Occurrence {
  key: string // the path from its root: "root/id/id" — one node can occur many times
  id: string
  depth: number // indentation
  parentKey: string | null
  hasChildren: boolean
  collapsed: boolean
}

interface View {
  blocks: Map<string, Block> // every node the view touches, once
  rows: Occurrence[] // depth-first, folds applied — what the screen shows
  childrenOf: Map<string, string[]> // sort-key order, for ops and export
}
```

`buildView(snapshot, query)` is the rollup walk with the string emission
removed and folds applied: start at each root, follow child links in sort-key
order, emit an occurrence per visit, stop at the depth cap or a collapsed
occurrence. `rollup(pageId)` becomes `serializeView(buildView({ roots:
[pageId], folds: none }))`, so there is one walk in the codebase and the
existing rollup tests pin it.

The views the app needs are all instances:

| View                   | Query                                                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Notes page             | `roots: [pageId]` (the page occurrence is the title row; children at depth 0 beneath it)                                  |
| Zoomed                 | `roots: [blockId]`, breadcrumb from the navigation stack as today                                                         |
| Filtered results       | `roots: matching ids`, `where` chosen by the query language; descendants of another root are folded into it, not repeated |
| `in:` scoping          | `scope`: candidate roots must be reachable from the scope roots                                                           |
| Sidebar                | special-cased: `type = page ∧ props.pinned`, no walk                                                                      |
| Previews / hover cards | `roots: [pageId]`, read-only, `maxDepth` small                                                                            |
| ⌘P outline             | the current view's rows filtered to heading types                                                                         |

**Rendering is a flat list.** `BlockEditor` maps `view.rows` to rows,
indenting by `depth` with the guide geometry `block-marker.tsx` already
encodes. This replaces the recursive `BlockItem` → `children` render, and it
is the same shape the search results already render, so the filtered view and
the notes page become one component by construction. Keyboard navigation is
index arithmetic over `rows` (the tree commands `treeNext`, `selectParent`,
`collapseOrParent` are all expressible on rows with `depth` and `parentKey`).

**Positions are occurrences.** Selection, anchor, focus, folds and the DOM
hooks (`data-block-row`, `data-block-id`) key by `Occurrence.key`, not by id.
This is the change editor-on-graph.md sized as "the bulk of the work"; on a
flat row list it is mechanical, because every command already receives a row
index. A node reachable twice in one view is two rows with two keys and one
`Block`, so editing its text updates both, selecting one selects one.

### 3.3 Mutations are graph ops

```ts
type Op =
  | {
      op: "create"
      id: string
      type: BlockType
      text: string
      props?: Props
      parent: string
      after: string | null
    }
  | { op: "setText"; id: string; text: string }
  | { op: "setType"; id: string; type: BlockType }
  | { op: "setProps"; id: string; props: Props | null }
  | { op: "link"; parent: string; id: string; after: string | null }
  | { op: "unlink"; parent: string; id: string } // delete-rescue applies
  | { op: "deletePage"; id: string }
```

Every editor command reduces to a short list of these:

| Command                                                                              | Ops                                                           |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| `insertBelow`, `insertSiblingBelow`, `splitPlain`, `splitContinuingList`, `exitList` | `create` (+ `setText` on the split block)                     |
| typing                                                                               | `setText`                                                     |
| `toggleTodo`, `turnInto*`, slash "turn into"                                         | `setType`                                                     |
| `indent`, `outdent`, `moveBlockUp/Down`                                              | `unlink` + `link` (a move; atomic in one batch)               |
| `deleteBlock`, merge-on-backspace                                                    | `unlink` (rescue handles orphans) + `setText` on the survivor |
| `duplicateAbove/Below`                                                               | `create` per node in the subtree + `link`s                    |
| paste (foreign markdown)                                                             | `parse` → `create`s + `link`s (import)                        |
| paste-as-link (own block ids)                                                        | `link` only — the multi-parent feature, finally structural    |
| title edit, pin, width, font, gist id                                                | `setText` / `setProps` on the page node                       |
| task move (calendar)                                                                 | `unlink` + `link` under the other page                        |
| tag rename                                                                           | `setText` on each node carrying the tag                       |
| new note                                                                             | `create` page node; template body imported as ops             |
| delete note                                                                          | `deletePage`                                                  |
| `toggleCollapse`, zoom, selection                                                    | view state, not ops                                           |

Ops apply **optimistically to the snapshot atom** (pure reducer over
`GraphSnapshot`), so the screen updates in the same render; the same batch is
queued to the store, whose `apply(ops)` reuses the existing `GraphWriter`
(`upsertNode`, `upsertLink`, `tombstoneLink`, `cascadeOrphans`) and returns
the `GraphDiff` the replica queue already consumes. This retires the
debounced string autosave: writes are row diffs of the rows the op touched
and nothing else, which is also what makes per-row LWW honest — today a
keystroke re-ingests the whole note.

**Undo** records the inverse ops of each batch (`setText` → the previous
text, `create` → `unlink`, `link` → `unlink`, and so on) with the same
coalescing rule as today (consecutive `setText` on one id merge). Inverse ops
are the shape event-sourcing-design.md wants for the op log; nothing here
needs the log, but nothing fights it either.

**Concurrency.** The pull path's protection today is "rows owned by pending
notes are never touched" (`expandPendingNodeIds`, page ids plus their
subtrees). With ops the pending set is simply the ids the queued ops touch,
which is narrower and more accurate.

### 3.4 Note metadata from the graph

`Note` stops carrying `content` and is derived per page node:

| Field                    | Source                                                                                                            |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `title`, `displayName`   | page node `text`, with the existing date/untitled ladder                                                          |
| `frontmatter`            | page node `props`                                                                                                 |
| `type`                   | id shape (date/week) or `props.template`, as today                                                                |
| `pinned`, `url`, `alias` | `props`                                                                                                           |
| `updatedAt`              | page node `updated_at` (bumped by any op under it, see below)                                                     |
| `tags`                   | tag tokens in the text of the page's subtree (the micromark tag extension, per node, cached by node `updated_at`) |
| `dates`                  | date tokens in the same texts, plus date-typed props                                                              |
| `tasks`                  | `todo` / `done` nodes in the subtree, with their tags and priority parsed from their own text                     |

The derivation is incremental by construction: a node's tags and dates depend
only on its own text, so they are memoised per `(id, updated_at)` and a page's
sets are unions over its subtree. This retires the "re-parse the whole corpus
on every keystroke" cost that `notesAtom` pays now.

A page's `updated_at` must move when anything beneath it changes, because
sorting, "recent" and the daily-note display all read it. Ops therefore stamp
the ancestors' page node too (one extra row per batch), or the derivation
takes the max over the subtree; the former keeps `sort:updated` cheap and is
what the replica already expects.

### 3.5 Search over the graph

The index is built from the snapshot: type is stored, text is marker-free,
ancestry is link traversal, page nodes are indexed like any node (their
`text` is the title). `in:` is reachability from the scope roots, correct
for multi-parent nodes. A query returns node ids of any type; the view
builder turns them into rows. The notes-versus-blocks mode disappears with
the fork that created it.

### 3.6 Where markdown remains

| Direction | Where                                                                                                                                                                                                           |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Import    | foreign paste (`html-to-markdown` → `parse` → ops); template bodies (EJS → `parse` → ops); the sample notes at boot (`docToGraph`); the gist share page, which renders a fetched string and stays on `Markdown` |
| Export    | copy / rich clipboard (`serializeView`), gist publish (`rollup`), any future backup                                                                                                                             |

`parse` keeps its re-mint of a duplicated `id::` — for **foreign** text a
duplicated id genuinely is two blocks — and the guard against a block
claiming a page's id. Neither ever runs on the editor's own state again.

## 4. Change inventory by area

Sizes are current line counts; "touch" is a judgement of how much of the
file changes.

### Data layer (`src/data`)

| File                                | Lines | Change                                                                                                                                                                                                                                          |
| ----------------------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `graph.ts`                          | 402   | Add `buildView` and `serializeView`; `rollup` becomes a call to them. `docToGraphParts` splits into `parse` + `docToParts(doc)` for import. Add the pure op reducer over `GraphSnapshot`.                                                       |
| `note-store.ts`                     | 50    | Add `getGraph(): GraphSnapshot` and `apply(ops): GraphDiff`. `getNote`/`getAllNotes`/`writeNotes` become import/export helpers or go.                                                                                                           |
| `sql-note-store.ts`                 | 633   | `apply(ops)` on top of `GraphWriter` (create/setText/setType/setProps/link/unlink/deletePage map onto `upsertNode`, `upsertLink`, `tombstoneLink`, `cascadeOrphans`). `planNoteWrite` survives for import only.                                 |
| `database-mode.ts`                  | 609   | `graphSnapshotAtom` replaces `databaseFilesAtom`; the write queue takes op batches; pulls apply row diffs to the snapshot instead of re-rolling every page; sample notes seed the snapshot via `docToGraph`; repair rebuilds from the snapshot. |
| `store.ts`                          | 75    | Rewritten: `useApplyOps`, no file paths.                                                                                                                                                                                                        |
| `view-state.ts`                     | 143   | Folds keyed by occurrence key, stored per **root** (a page or a zoomed block), seeded by `default-collapsed` over the view.                                                                                                                     |
| `note-store-conformance.ts`         | 410   | Grows op-level cases: create, move, delete-rescue via ops, shared node edited once and rendered twice, and the identity `serializeView(buildView([p])) === rollup(p)`.                                                                          |
| replica, D1 source, tenancy, Worker | —     | **Unchanged.** `expandPendingNodeIds` takes the ops' touched ids instead of page ids.                                                                                                                                                           |

### Block core (`src/blocks`)

| File                                                 | Lines | Change                                                                                                                                       |
| ---------------------------------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `types.ts`                                           | 35    | `Block { id, type, text, props, updatedAt }`; `BlockDoc` becomes `View`.                                                                     |
| `block-type.ts`                                      | 122   | Shrinks to the type registry plus `leadingMarker` (the typing shortcut) and the marker map used by import/export.                            |
| `ops.ts`                                             | 351   | Becomes the op reducer's helpers over `childrenOf` (insert-after, move, subtree, ancestors), keyed by occurrence where a position is needed. |
| `commands.ts`                                        | 681   | Each command returns an op batch plus a view-state change instead of a new doc. The keymap and command names are unchanged.                  |
| `history.ts`                                         | 87    | Stores inverse-op batches instead of doc snapshots; same coalescing.                                                                         |
| `keymap.ts`                                          | 205   | Unchanged.                                                                                                                                   |
| `slash-menu.ts`                                      | 250   | "Turn into" emits `setType`; dates unchanged.                                                                                                |
| `default-collapsed.ts`                               | 36    | Runs over a view (rows with types and depths).                                                                                               |
| `parse.ts`, `serialize.ts`, `to-display-markdown.ts` | 253   | Import/export only; unchanged in content, moved out of the editor's path.                                                                    |

### Editor (`src/components/block-editor`)

| File                                                                              | Lines | Change                                                                                                                                                                                             |
| --------------------------------------------------------------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `block-editor.tsx`                                                                | 1,506 | Renders `view.rows` flat; selection/anchor/focus/folds keyed by occurrence; dispatches op batches; zoom, breadcrumb, clipboard and paste retargeted. The largest single change.                    |
| `block-item.tsx`                                                                  | 670   | A row: takes `Block` + `Occurrence`; no `stripMarker`; textarea edits `text`; the beside-toggle, markers and quote bar already come from `block-marker.tsx`. Children are no longer rendered here. |
| `block-note-editor.tsx`                                                           | 238   | Deleted. The note route builds its view from the snapshot with a hook (`useView(query)`).                                                                                                          |
| `note-title.tsx`                                                                  | 180   | Edits the page node's `text` (it is a row of the view).                                                                                                                                            |
| `block-marker.tsx`, `block-content.tsx`, `slash-menu.tsx`, `hash.tsx`, `caret.ts` | —     | Unchanged.                                                                                                                                                                                         |

### State and hooks (`src/global-state.ts`, `src/hooks`)

| File                                                           | Lines | Change                                                                                                                                                 |
| -------------------------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `global-state.ts`                                              | 478   | `markdownFilesAtom` goes; `notesAtom`, `tagsAtom`, `templatesAtom`, `dateMentionsAtom`, `blockIndexAtom` derive from `graphSnapshotAtom` (§3.4, §3.5). |
| `editor-value.ts`                                              | 117   | Deleted.                                                                                                                                               |
| `note.ts`                                                      | 133   | `useSaveNote` → ops; rename → `setText` on the page; delete → `deletePage`.                                                                            |
| `task.ts`                                                      | 71    | Move → `unlink` + `link`.                                                                                                                              |
| `tag.ts`                                                       | 47    | Rename/delete → `setText` over the nodes carrying the tag.                                                                                             |
| `create-new-note.ts`                                           | 48    | `create` page + import of the template body.                                                                                                           |
| `is-developer.ts`                                              | 96    | Upstream readout from the snapshot's link index.                                                                                                       |
| `search-results.ts`, `search-notes.ts`, `block-result-tree.ts` | 295   | Results become view queries; the hit-tree hook is retired by the flat view.                                                                            |

### Routes and UI

| File                                                                           | Lines | Change                                                                                                                                                                             |
| ------------------------------------------------------------------------------ | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `_appRoot.notes_.$.tsx`                                                        | 388   | No `editorValue`; `useView({ roots: [noteId] })`; font/width/gist read and write page `props`; daily/weekly templates import on first open; the save indicator reads the op queue. |
| `note-list.tsx`, `_appRoot.index.tsx`, tags routes                             | ~700  | The list renders view rows for results and page rows for listings; `in:` pills already exist.                                                                                      |
| `note-preview.tsx`, `note-preview-card.tsx`, `hover-card.tsx`, `nav-items.tsx` | ~450  | Render a read-only view of the page instead of `Markdown(note.content)`.                                                                                                           |
| `note-actions-menu.tsx`                                                        | —     | Pin/width/share → `setProps`; copy → `serializeView`.                                                                                                                              |
| `command-menu.tsx`                                                             | 798   | Headings per note from the view; create note via ops; results are view rows.                                                                                                       |
| `share.$gistId.tsx`, `gist.ts`                                                 | 269   | Unchanged (edge).                                                                                                                                                                  |
| `markdown.tsx`                                                                 | 908   | Stays for the gist page, help panel and property values; no longer on the note path.                                                                                               |
| `frontmatter.ts`                                                               | 365   | Stays for import/export (`frontmatter-props.ts`, `page-identity.ts`); the UI-side edit helpers (`updateFrontmatterValue`) lose their callers.                                      |

### Tests, stories, e2e

`block-editor.test.tsx` (108 tests) and `block-note-editor.test.tsx` drive
the editor through markdown fixtures; their harness moves to
`buildView(docToGraph(md))` so the fixtures stay markdown and the assertions
stay. `graph.test.ts` gains the view identity in its property loops.
`commands.test.ts` / `ops.test.ts` assert op batches. The Storybook stories
and the visual-regression baselines render the same views, so the baselines
should not move. New: op reducer tests, view builder tests over rows
(multi-parent, page-as-child, tombstones, cycles, depth cap, N roots, a root
inside another root), and the conformance additions above.

## 5. Sequencing

Each step keeps the app working and deletes bridge code.

1. **View builder + flat editor.** `graphSnapshotAtom`, `buildView`,
   `serializeView`, `rollup` on top of them; `BlockEditor` renders rows
   keyed by occurrence, reading from the snapshot. Writes still go through
   `docToParts(view)` (no `parse` on save), so the re-mint fork is gone here.
   Behaviour-neutral on screen; the identity tests are the proof.
2. **Ops.** The reducer, `store.apply(ops)`, inverse-op undo, optimistic
   snapshot updates; commands emit ops; `editor-value.ts`, `useSaveNote` and
   the string autosave retire. Per-row writes replace whole-note ingest.
3. **Metadata and search from the graph.** `notesAtom` and friends from the
   snapshot; `Note.content` removed; previews render views; `parseNote`
   retires to the gist page; `blockIndexAtom` over nodes. `markdownFilesAtom`
   has no reader left and is deleted with `database-mode.ts`'s file helpers.
4. **Surgery and creation as ops.** Task move, tag rename, pin/width/font/
   gist, new note and templates, delete note. `frontmatter.ts`'s edit
   helpers and `store.ts`'s file API go.
5. **Views everywhere.** The filtered results as a multi-root view, page
   nodes as results, `in:` as reachability, one vocabulary, the caret
   popover. (This is the "PR B" of the earlier discussion, landing last.)

Roughly 4,500 lines touched, about half of it mechanical re-keying in the
editor and commands. Steps 1 and 2 are the ones that must each land as a
unit; 3 to 5 are divisible.

## 6. Decisions to take before starting

- **Occurrence keys now.** The flat row list makes them natural; deferring
  them would mean writing the row renderer twice. Recommend: yes, in step 1.
- **Folds per occurrence.** Logseq's reading of the graph, and the honest
  one; stored per root so a zoomed view has its own folds. Recommend: yes.
- **Undo as inverse ops** rather than snapshot restore. Aligns with the op
  log; snapshots of a whole graph would not scale anyway. Recommend: yes.
- **Autosave granularity.** Per-op batches, applied immediately, with the
  current 150 ms coalescing for `setText` runs so a word is one row write.
  Recommend: yes; the replica queue already batches diffs.
- **The page node is a row.** Its title is the first row of its view (as the
  zoom title is today), so a page appearing as a child or as a result renders
  like anything else. Recommend: yes.
- **`Note.content` removal** in step 3 rather than kept as a derived export.
  Keeping it would keep `Markdown` on the note path. Recommend: remove.
- **Delete-rescue** stays as the `unlink` semantics; soft deletes make it
  recoverable. Unchanged.
- **Frontmatter editing** becomes a props editor on the page node
  (`property-value.tsx` already renders typed values); the raw YAML block the
  editor preserves today is only ever seen at import/export.

## 7. Risks

- **Editor regressions.** 1,500 lines of interaction code re-keyed. Mitigated
  by keeping the command vocabulary, the keymap, and the markdown-fixture
  harness for the 108 editor tests, so behaviour is asserted before and
  after on the same fixtures.
- **Optimistic ops vs pulls.** An op applied to the snapshot and queued must
  win over a pull that lands between; the pending-ids rule already exists
  and gets narrower.
- **Shared-node editing.** Text edits to a node reachable twice apply to
  both occurrences by definition; the UI must make that visible (both rows
  update live), which the flat list does for free.
- **Templates.** EJS output is imported as ops on first open of a daily or
  weekly page; the import must not run twice (today the string seed has the
  same hazard and the same guard, `!note`).
- **The developer "upstream" readout and paste-as-link** currently scan
  `id::` lines; both become link-index reads and get more accurate.
