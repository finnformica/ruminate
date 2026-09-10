# Graph-native app: retiring the markdown bridge

Status: **steps 1 to 3 landed** (2026-09-10) — see §5 for what each step
delivered and what remains. Extends
[editor-on-graph.md](./editor-on-graph.md) (which assessed the same move
from the editor's side) and [graph-schema-v2.md](./graph-schema-v2.md) (the
storage this runs on); the mutation model below is shaped to fit
[event-sourcing-design.md](./event-sourcing-design.md) without depending on
it.

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
at the start of a block still sets its type, and copy, paste and gists still
speak markdown at the edge. Nothing between the store and the screen is a
string. (Two features that were markdown at heart went rather than crossed
over: `((blk_x))` transclusions — the graph says "this block here too" with a
link — and EJS templates.)

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
  | { op: "create"; id: string; type: string; text: string; props: string | null }
  | { op: "setText"; id: string; text: string }
  | { op: "setType"; id: string; type: string }
  | { op: "setProps"; id: string; props: string | null }
  | { op: "link"; source: string; destination: string; sortKey: string }
  | { op: "unlink"; source: string; destination: string }
  | { op: "delete"; id: string }
```

An op is a row mutation (`src/data/ops.ts`), self-contained: a `link`
carries the sort key chosen against the snapshot, so the same batch applies
identically to the in-memory snapshot (`applyOps`, pure) and to the store
(`NoteStore.applyOps`, verbatim row writes returning the `GraphDiff` the
replica queue consumes). The client decides what cascades and says so with
explicit `delete`s; the store never guesses.

**Where ops come from.** The editor keeps its pure, doc-level command layer
(`commands.ts`, `ops.ts` in `src/blocks`) — the 108 editor tests assert it on
the same fixtures as before. What changed is what a command's result _is_:
the doc it returns is handed to `docToOps(pageId, doc, snapshot)`, which
derives the batch that makes the graph agree with it. Creating a block is
one `create` and one `link`; typing is one `setText`; a reorder is only the
links whose keys had to move; a block the doc names that the graph already
holds (paste-as-link) is a `link` and nothing else — one node, two links;
what the page reached before and no longer names is unlinked and, if
nothing else holds it, deleted, cascading through children left without a
parent. A block another page holds survives untouched.

This is the diff the store already computed on every whole-note ingest,
moved to the client and made the unit of change. It has three consequences
the original plan wanted from "commands emit ops": writes are the rows the
change touched and nothing else; the pending set the pull path protects is
the pages those rows belong to; and an op batch is a self-describing event
the way event-sourcing-design.md wants one.

**Optimistic, coalesced.** `useNoteDoc` walks the page out of the live
snapshot — there is no editor copy to reseed — and applies each batch to the
graph atom in the same tick. Signed in, `databaseApplyOps` coalesces a run
of ops for 150 ms (a typed word is one row write), writes them, hands the
diff to the replica, and refreshes the rollups of the pages the batch
touched; a queued markdown write, repair or pull flushes the pending ops
first, and a refresh from the store re-applies anything still pending, so
the store never reads behind the screen. Signed out, ops apply to the
in-memory sample graph. The page's `updated_at` is stamped on every change.

**Undo** stays what it was: the editor's history of doc snapshots, restored
through the same `onChange`. Restoring a snapshot diffs against the graph
like any other edit, so the inverse ops fall out of `docToOps` rather than
being recorded — `setText` back to the previous text, a deleted subtree
re-created under its original ids (a revived id is clean in the store), a
link removed. Coalescing (consecutive text edits to one block are one step)
is unchanged.

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

Each step keeps the app working and deletes bridge code. One PR per step,
each branched from the last.

1. **Typed blocks, docs from the graph, flat view** — _landed (PR #61)_.
   `Block { type, text }` with markers only in `parse`/`serialize`;
   `docFromGraph`/`pageDoc`/`rollup` as the one walk; `graphSnapshotAtom`;
   `buildRows` and the flat `BlockEditor` keyed by occurrence with folds per
   occurrence; transclusions and templates removed. Selection and focus
   still key by block id (a block occurring twice in one note is addressed
   by its first row) — the commands are still doc-level, see step 2.
2. **Ops** — _landed_. The vocabulary, `applyOps`, `docToOps`,
   `NoteStore.applyOps`, `databaseApplyOps` with the coalesced flush, the
   in-memory sample graph (hard-coded blocks, no markdown), `useNoteDoc`.
   The string autosave, `useEditorDoc`, doc-level saves and the file-shaped
   optimistic update are gone. Undo is unchanged (see §3.3).
3. **Metadata, search and previews from the graph; every writer is ops** —
   _landed_. `Note` is read off the graph (`src/data/note-meta.ts`: the
   page node's text and props, tags found in block text, tasks as
   `todo`/`done` blocks by id, headings, the text preview); `Note.content`
   and `frontmatter` are gone, `props` and `text` replace them. `notesAtom`
   and `blockIndexAtom` derive from the snapshot with per-page memoization.
   Previews render the page's view read-only; copy and gists take the
   rollup explicitly; the gist share page imports its markdown into a
   graph of its own. Rename, pin/width/font/gist props, tag rename and
   delete, create and delete note are each one batch of ops. The doc
   carries page `props` (the title inline) rather than frontmatter text —
   YAML exists only where `parse` and `serialize` meet markdown. The
   markdown files layer, `parseNote`, the task and list-item markdown
   surgery, the markdown component's editing affordances and five mdast
   dependencies are deleted.
4. **The last of the doc-level editor.** Selection and focus re-key by
   occurrence (so a block twice in one note is two addressable rows), and
   the commands take the row rather than the id. `?content=` (a new note's
   seed) is the one import left on the note path.
5. **Views everywhere.** The filtered results as a multi-root view, page
   nodes as results, `in:` as reachability, one vocabulary, the caret
   popover. (Absorbs the results renderer of PR #60, rebased onto this.)

## 6. Decisions

- **Occurrence keys** for rows, folds and the DOM hooks: yes, in step 1.
  Selection and focus follow in step 4.
- **Metadata from the graph, memoized per page.** A `Note` object is kept
  while the rows its page reaches are unchanged (row identity, no content
  compare), so the notes list, search index and React keys stay stable
  across an edit to another note. Done.
- **Folds per occurrence**, stored per note by key; folds stored by id from
  before resolve to every occurrence of the block. Done.
- **Undo** stays snapshot restore; the inverse ops are derived (§3.3). The
  op log, if it comes, records the batches `docToOps` emits.
- **Autosave granularity.** Per-batch, applied at once, 150 ms coalescing
  before the store write. Done.
- **The page node is a row.** Its title leads a zoomed view today; as a
  result row in step 5.
- **`Note.content` removal.** Done; the rollup is an export (`rollup`), not
  a field, and `Note.text` (the blocks' text) is what fuzzy search matches.
- **Delete-rescue** stays as the `removeLink` semantics of the store API;
  `docToOps` cascades explicitly and never rescues (a child the doc still
  names has a parent in it). Unchanged.
- **Page metadata is props.** There is no frontmatter in the app: the page
  node's props are the metadata (`Note.props`, `BlockDoc.props`,
  `useSetPageProps`), and YAML survives only at the markdown edge
  (`pagePropsFromText` / `frontmatterTextOfProps`). Done. A metadata editor
  over the props is UI still to build; the gist share page keeps the
  read-only markdown renderer.
- **Sample notes are hard-coded blocks** (`src/data/sample-graph.ts`),
  held in a writable atom signed out. Done.
- **Transclusions and templates** removed rather than carried over. Done.

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
- **A new page's first edit.** The page node is created by the first edit
  with content (`useNoteDoc` skips an empty doc), never twice: the second
  edit finds the page in the snapshot.
- **The developer "upstream" readout and paste-as-link** currently scan
  `id::` lines; both become link-index reads and get more accurate.
