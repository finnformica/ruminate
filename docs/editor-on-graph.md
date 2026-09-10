# Editor on the graph: retiring the markdown bridge

> **Status (2026-09-10):** a design record. The bridge it describes has been
> retired — see [graph-native-app.md](./graph-native-app.md) for what was
> built; code references below may no longer exist.

An assessment of what it takes for the app to operate on nodes and links
directly, with markdown reduced to import and export. Written against the
code as of the developer-mode branch; extends [graph-storage.md](./graph-storage.md)
and [block-editor-architecture.md](./block-editor-architecture.md).

## The problem in one paragraph

The store is a graph (`nodes` + `link`, multi-parent, delete-rescue) and the
replica syncs rows. The UI, though, still exchanges **markdown strings** with
the store: `rollup(page)` renders a note to `<id>.md`, the editor `parse`s
that into a tree keyed by block id, and every autosave `serialize`s the tree
and re-derives links from it (`planNoteWrite`). A block linked under two
parents in one note rolls up twice with the same `id::`; `parse` must remint
the second occurrence (a map can hold an id once), and the next save turns
the remint into a fork. The graph can hold the shared node; the round trip
cannot carry it. Cross-note sharing survives only because each note's rollup
names the id once.

## What the seam actually looks like

The research is the good news: the markdown coupling is narrow.

- **Outside `src/data` the seam is three symbols wide:** `markdownFilesAtom`
  (read by `notesAtom`, the paste-as-link resolver, and the developer
  metadata index), `useWriteNotes`, and `useGetNoteContents`.
  `databaseFilesAtom`/`databaseWriteFiles` have no consumers outside
  `src/data`; the projection lives in three helpers in `database-mode.ts`.
- **The store is already graph-native.** `NoteStore` exposes `upstream`,
  `downstream`, `addLink` (with position and cycle rejection) and
  `removeLink` (delete-rescue). None of them has a caller in the app today;
  only the conformance suite exercises them. `SqlNoteStore` keeps an
  in-memory mirror (`mem`) of nodes and links that `planNoteWrite` diffs
  against.
- **The replica is rows.** `replica-sync.ts` pushes `{ nodes, links }`, the
  Worker stores rows, pulls apply rows. No markdown crosses the wire. The one
  markdown touch is a note count for the "replica far behind" heuristic.
- **`planNoteWrite` already reconciles per parent.** It takes a
  `childrenOf: Map<parentId, childId[]>` and a node list, keeps unchanged
  links, tombstones dropped ones, cascades orphans. The only reason it forks
  a shared node is that its input comes from `parse`. Feed it a DAG and it
  writes a DAG.

Where the markdown is load-bearing:

| Area                  | Files                                                                         | What they do with markdown                                                                      |
| --------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Editor bridge         | `block-note-editor.tsx`                                                       | `parse` on load, `serialize` on every change                                                    |
| Editor position state | `block-editor.tsx`, `block-item.tsx`, `ops.ts`, `commands.ts`                 | not markdown, but every position is a bare block id                                             |
| Note metadata         | `parse-note.ts` (mdast), `global-state.ts`                                    | title, tags, tasks, dates, frontmatter, pinned, type, display name                              |
| Search                | `block-search.ts`, `search-notes.ts`                                          | fuzzy index over `content`; block index `parse`s each note                                      |
| Text surgery          | `hooks/task.ts`, `hooks/tag.ts`, frontmatter helpers                          | move a task by byte offsets; rename a tag by regex over the corpus; pin via frontmatter rewrite |
| Creation              | `create-new-note.ts`, `command-menu.tsx`, templates (EJS)                     | build markdown strings for a new page                                                           |
| Interop               | copy markdown, gist share, rich clipboard, `to-display-markdown.ts`           | genuinely need markdown out                                                                     |
| Invariants            | `graph.test.ts`, `blocks.test.ts`, conformance suite, `rollup-equivalence.ts` | pin the round trip as a fixpoint                                                                |

## The conversion, in phases

### Phase 1: the editor reads and writes the graph (the one that matters)

This alone fixes within-note multi-parent. Everything else can trail.

1. **Build the editor doc from rows, not from markdown.** `BlockDoc` is
   already almost a graph slice: a node map plus ordered `children`. The
   change is to allow one id in several `children` arrays and to build the
   doc from `mem` rather than from `parse(rollup)`. The per-node text is
   `marker(type) + text`, which `graph.ts` already knows how to produce
   (`MARKER_OF_TYPE`, `classifyLine`); `docFromGraph(pageId)` is the rollup
   walk minus the string emission. New code, roughly 80 lines. The store
   exposes a graph snapshot atom (nodes and links maps, updated on write and
   pull) that both this and the markdown projection derive from.
2. **Key positions by occurrence, not by id.** This is the bulk of the work
   and it is mechanical. An occurrence is `(parentId, id)`; a path is the
   list of ids from the zoom root. Today's id-keyed state: `selected`,
   `anchorId`, `focus`, `zoomStack`, `collapsed`, and the `data-block-id`
   DOM hook the copy and cut handlers query. `ops.ts` (351 lines) finds a
   block's parent with a first-match search; every function that takes `id`
   takes an occurrence instead. `commands.ts` (667 lines) has 25 commands
   that take `id`; same change. `block-editor.tsx` (1,489) and
   `block-item.tsx` (696) follow. Undo keeps whole docs, so it is unaffected.
   Collapse state is the one judgement call: per occurrence (Logseq) or per
   node; per occurrence is the honest reading of the graph.
3. **Write the doc, not a string.** Split `docToGraphParts` into
   `parse` + `docToParts(doc)`; `planNoteWrite` takes parts. The editor's
   change handler computes parts from its doc and calls the store. The
   remint in `parse` leaves the save path entirely; it stays correct for
   imports. Paste within a note becomes an `addLink`, which is what the
   twin, cycle and same-parent rules already describe.
4. **Keep the rollup as a derived projection** so `markdownFilesAtom`
   consumers keep working unchanged during the phase. Nothing above the
   seam has to move in Phase 1.

Cost: about 3,200 lines touched, most of it signature changes, plus the 89
editor tests and the ops/commands tests. Two or three PRs: occurrence keying
first (behaviour-neutral, testable on its own), then the graph read/write
swap.

Decisions to take before starting:

- **Orphans.** Today a node that loses its last inbound link is tombstoned
  and its children rescued to the page root. A "universe of blocks" model
  would instead let it float, unlinked and invisible. Floating nodes need a
  way to be found again (a search over unlinked nodes, or a bin), or they
  are just leaked rows. Recommendation: keep delete-rescue for now; it is
  recoverable by design (soft deletes) and costs nothing to revisit.
- **Same parent twice.** The `link` primary key forbids it and the schema
  doc calls that "the sane invariant". Keep it; the editor's twin rule
  already skips such a paste.

### Phase 2: note metadata off the graph

`parse-note.ts` runs mdast over each rollup to get title, tags, tasks,
dates, frontmatter and type. On the graph these are direct reads: title is
the page node's text, frontmatter is its props, a task is a `todo`/`done`
node, tags come from the tag micromark extension run over block text.
`blockIndexAtom` indexes nodes instead of parsing notes. Search over
`content` can keep using the rollup string. Medium effort, roughly 1,300
lines of derivation code, and it retires the "reparse the whole corpus on
every change" TODO for free because node diffs are incremental.

### Phase 3: text surgery becomes graph ops

`useMoveTask` is a `removeLink` plus `addLink`. Tag rename is a text edit on
the nodes that carry the tag. Pin and other properties are a props update on
the page node. New-note flows create a page node and optional props instead
of formatting frontmatter strings. Each is small and independently
shippable.

### Phase 4: markdown as import and export only

`parse` and `serialize` stay, scoped to their real jobs: foreign paste,
template rendering (EJS output is imported like any markdown), copy as
markdown, gist share, and the corpus export. The round-trip test suite
stays as the contract for that import/export path. The developer "upstream"
readout reads `NoteStore.upstream` instead of scanning `id::` lines.

## How simple is it?

Simpler than the size of the editor suggests, because the hard architectural
work is already done: the graph is truth, the store has the operations, and
the sync is rows. The conversion is not a rewrite of storage; it is
retargeting the editor from a string to the rows behind it, and the single
genuinely new idea is "a position is an occurrence, not an id". Phase 1 is
the only phase that needs to land as a unit. The rest is incremental and
each step deletes markdown-specific code rather than adding to it.
