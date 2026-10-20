# The graph walk: queries and pivots

Status: **design, not built.** Requested by Finn, who prefers the walk of
[Pensive](https://github.com/aatack/Pensive) to the walk ruminate has now.
This document describes the two walks and lists what a reader sees
differently. It proposes a design for pivots (section 4), a sections-only
toggle and an in-place filter in the walk (section 5), and fixes for fold
state (section 6). Section 7 records how Views, panes and frames fit
together, as Finn decided on 2026-10-20. It gives a migration plan, the
questions still open, and a note on layered stores for later. Pensive has no
license: this document takes ideas from it and copies no code.

The design changes no storage, events, sync or D1 schema, with one
exception: the recommended `stack` field on a View (7.6). The `link` table
(`source_id`, `destination_id`, `kind='child'`, `sort_key`) stays as it is. A
pivot is view state, like a fold.

The words used below:

- **Down** — follow a block's child links: what the block holds.
- **Up** — follow child links the other way: what holds the block (its
  parents, its backlinks).
- **Row** (or occurrence) — one place a block shows in a view: one path from
  the view's root (`src/blocks/view.ts`).
- **Query** — the rule for the rows beneath a row: down, up, or nothing
  (collapse).
- **Pivot** — a query set on one block. It replaces the walk beneath that
  block's rows.
- **Frame** — one live query state in a pane's stack: a root, a selection,
  pivots, a filter and folds (7.1; `FocusFrame` in the split-view work,
  `src/data/panes.ts`).
- **View** — a saved stack of frames: a bookmark. One frame is the simple
  case (7.1, 7.6).
- **Pane** — a stack of frames: the pane's history (7.1).

## 1. Ruminate's walk today

### The pieces

| Piece                                         | File                              | What it does                                                                                                                  |
| --------------------------------------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `walkGraph`                                   | `src/data/graph.ts`               | The lazy walk. It builds a `BlockDoc` from the graph snapshot and descends only where the fold rule opens a row.              |
| `noteView`                                    | `src/data/graph.ts`               | `walkGraph` from a note: the note's children are the roots, at level 1. The note id is on the path from the start.            |
| `blockView`                                   | `src/data/graph.ts`               | `walkGraph` from a focused block: the block is the one root, at level 0.                                                      |
| `LinkDirections`                              | `src/data/graph.ts`               | `"downstream" \| "upstream" \| "both"`: which links every row follows.                                                        |
| `linkDirectionsAtom`                          | `src/global-state.ts`             | The device setting (Settings → Editor, "Show links"). The default is `"downstream"`.                                          |
| `useNoteDoc`                                  | `src/hooks/note-doc.ts`           | Calls `blockView` (in focus) or `noteView`, then `filteredView`. `setDoc` turns an edit into ops (`docToOps`).                |
| `ExpandedRule`                                | `src/blocks/view.ts`              | `(key, level, type) => boolean`: is this row open?                                                                            |
| `expandedByDepth`                             | `src/blocks/default-collapsed.ts` | The standing depth rule: open while `level < n` (n = 2 by default).                                                           |
| `foldRule`, `useFoldRule`, `withFold`         | `src/data/view-state.ts`          | The reader's own folds (open and closed keys, per view, in localStorage) over the depth rule. A board's row starts closed.    |
| `buildRows`, `walkDoc`, `rowsBeneath`         | `src/blocks/view.ts`              | Turn the walked doc into the flat list of rows the editor draws, with keys, depth, guide lines and fold state.                |
| `keyOf`, `directionOfKey`, `hasOccurrence`    | `src/blocks/view.ts`              | The occurrence key: ids joined by `/`, an up segment marked `^` (`root/child/^parent`).                                       |
| `siblingsOf`, `indentBlock`, `removeBlock`, … | `src/blocks/ops.ts`               | The doc maths. They read the direction off the key and edit `children` or `upstream`, which they keep as mirrors of one edge. |
| `filteredView`                                | `src/data/filter-view.ts`         | A narrowed view (filter or sort). It walks eagerly, then applies the fold rule to what survives.                              |
| `buildUpstreamIndex`                          | `src/utils/block-upstream.ts`     | Not part of the walk. It finds the notes that reach each block, for the developer metadata readout only.                      |

### How a note is drawn

1. The route (`src/routes/_appRoot.views_.$.tsx`) reads `?block=` (the
   focused block), `?filter=` and `?sort=`. It gets the fold rule from
   `useFoldRule(noteId, { filter, sort })` and the directions from
   `linkDirectionsAtom`.
2. `useNoteDoc` calls `blockView` when a block is in focus, else `noteView`.
3. `walkGraph` visits each root. For each block it builds a `Block` with the
   complete list of its children (and, when `directions` is not
   `"downstream"`, the complete list of its parents in `upstream`). These
   lists draw the chevron and keep a save diff empty.
4. At each row, `walkGraph` asks the fold rule. A closed row goes into
   `collapsed` and the walk does not go beneath it. An open row walks its
   children (down) and then its parents (up), as the setting says.
5. `buildRows` walks the doc again, depth-first, and makes the rows.
6. An edit comes back through `setDoc`. `docToOps` diffs it against the
   rows that were shown.

### Direction

Direction is one setting for the whole device. It applies to every row of
every note:

- **Downstream** — the tree. This is the default.
- **Upstream** — the note's blocks are still the roots, but beneath each row
  the walk shows only its parents. The note's own parents are rows after its
  blocks (`BlockDoc.upstream`).
- **Both** — beneath each open row, first its children, then its parents.

Note: `docs/graph-storage.md` ("How the app is fed") says the walk goes
"upstream as well as down by default". The code default is `"downstream"`.
Step 9 of the plan corrects that text.

### The path guard and loops

The walk guards by **path**, not by a visited set:

- A child already on the path is shown once more, as a leaf (`looped`): no
  chevron, nothing beneath. The outline ends where the loop closes.
- A parent already on the path is **skipped**. The parent the row came from
  is not a row beneath it. This also hides a real loop in the up direction.
- Beneath an up row, a child already on the path is skipped, for the same
  reason.

### Laziness

The walk is O(rows on screen). A closed row carries its id lists but no rows
beneath it. Opening a fold walks one more level. There is no budget: the
depth rule and the reader's folds decide what is walked.

### Focus

Focus is one level, in the URL (`?block=`). A focused block's view is the
same walk from a different root. Leaving focus opens the folds down to the
block (`revealOnLeaveFocus`). The split-view work adds a stack of frames per
pane (`src/data/panes.ts`, below).

## 2. Pensive's walk

Pensive's walk is about 150 lines (`frontend/src/queries/resolution.ts`,
`types.ts` and `helpers.ts`). Its model:

- **The view is a query tree.** A tab shows one frame. A frame has a root
  entity and a query. The root query is always "outbound links" (down).
- **A query** is one of two shapes: links in one direction (outbound or
  inbound), or collapse (no rows beneath).
- **The walk is breadth-first** from the root. Each entity it reaches
  becomes a result node. The query gives the ids beneath it.
- **A pivot** is a query stored for one entity id. When the walk reaches an
  entity with a pivot, it does not go beneath it with the current query. It
  puts the entity on a list, and walks it later with the pivot's query. The
  pivot's query then applies to everything beneath that entity, until
  another pivot.
- **Collapse is a pivot.** A collapsed entity gets the collapse query, which
  has no rows beneath. A collapse wins over a link pivot on the same entity.
- **State.** Pivots are kept on the frame, keyed by entity id. Collapses are
  kept on the tab, keyed by entity id. So a pivot or a collapse applies to
  every row of that entity in the view. A hotkey cycles the selected
  entity's pivot through inbound, outbound and none.
- **Budget.** Each query walk stops after 200 entities. A result with ids
  that were not walked is marked incomplete. Each pivot gets a new budget of
  its own.
- **Cycles.** There is no path guard. The budget is the only thing that
  stops a cycle: the cycle repeats until the budget is spent.
- **Drawing.** The result tree is flattened depth-first for display, so
  breadth-first order changes only which rows the budget drops. A pivoted
  row shows a small label (`--> inbound`).
- **Filter.** Each frame has a highlight: a text, a sections-only flag and
  "hide snoozed". A row passes when its text holds the highlight text, it
  is a section (when the flag is on), and it is not snoozed. `prune` keeps a
  row when it passes or when a row beneath it passes, so the ancestors stay
  as the path. A passing row's children go unless they pass too. The prune
  keeps a pivoted subtree whole. A section is a flag on any entity, not a
  type. Finn toggles sections-only with `q`.
- **Focus.** A frame has a `context` (the frame beneath it). Push makes the
  selected entity the new root with no pivots. Pop goes back to the frame
  beneath, with its pivots.
- **Edits.** A row's path is a list of ids. The move tool takes the row
  above as the parent, and does not look at the pivot direction.

## 3. What a reader sees differently

| Topic                     | Ruminate today                                                                                                                                   | Pensive                                                                                                                               |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| Who chooses the direction | One setting per device, for every row of every note.                                                                                             | The reader, per entity, in the view. One row shows its backlinks; the rest show children.                                             |
| Mixed directions          | "Both" shows children and then parents beneath every open row.                                                                                   | A row shows one direction. There is no "both".                                                                                        |
| Beneath an up row         | Its other children and its parents ("both"), or only its parents ("upstream").                                                                   | Only its parents: the inbound query continues down the chain of holders until another pivot.                                          |
| The row it came from      | Skipped. A block's own parent is not shown beneath it.                                                                                           | Shown. An inbound pivot under its parent lists that parent again beneath it.                                                          |
| How deep a view opens     | n levels (2 by default), then rows start closed. Each closed row has a chevron.                                                                  | Everything opens until 200 rows, then the rest is marked incomplete.                                                                  |
| Fold scope                | Per row (occurrence key), per view, per device. A block with two rows has two folds.                                                             | Per entity, per tab. A collapse closes every row of that entity.                                                                      |
| Pivot scope               | No pivots.                                                                                                                                       | Per entity, per frame.                                                                                                                |
| Root direction            | The note's blocks are always the roots.                                                                                                          | The root is always walked outbound. A pivot on the root is not read.                                                                  |
| Cycles                    | Shown once where they close (down), or skipped (up).                                                                                             | Repeated until the budget is spent.                                                                                                   |
| Focus                     | One level (`?block=`), plus browser history. The split-view work adds a stack per pane.                                                          | A stack of frames per tab. Each frame keeps its pivots.                                                                               |
| A marker on the row       | Up rows look like child rows.                                                                                                                    | A pivoted row has a label that names its query.                                                                                       |
| Editing a parent row      | Direction-aware: Enter adds a new holder, indent and outdent move the link the other way, ⌫ unlinks.                                             | The move tool takes the row above as the parent in every direction.                                                                   |
| Filter                    | A query in the note's header (`?filter=`), first pane only. It keeps a match's ancestors and all of its children. A narrowed view walks eagerly. | A text, a sections-only flag (`q`) and hide snoozed, per frame. It keeps a match's ancestors only, and keeps a pivoted subtree whole. |
| Sections                  | No toggle. ⌘P lists the headings in the palette.                                                                                                 | Sections-only shows the structure without the detail.                                                                                 |

## 4. The design

### 4.1 The model in one paragraph

A view is a root and a query. The default query is down, so with no pivots a
note reads exactly as it does today. The reader can put a **pivot** on a
block in the view: "show what holds this" (up) or, inside an up region, "show
what this holds" (down). The pivot replaces the walk beneath each row of that
block, and the rows beneath inherit it until another pivot. A **fold** is a
collapse pivot on one row. The walk stays lazy and has no budget: it walks
only rows that are open. Pivots belong to a frame, so each pane, and each
frame in a pane's focus stack, has its own. The global "Show links" setting
goes away at the end.

Example graph, used below:

```
Note N ── A ── X ── Y
     └─── B
Note P ── X            (X has two parents: A and P)
```

With no pivots, N shows `A, X (under A), Y (under X), B`. Put an up pivot on
X. Beneath the X row the reader now sees `P` (an up row) and not `Y`. A is
not listed: it is the row X came from. Beneath P, the walk stays up: P's
holders (none here). The other rows of N do not change.

### 4.2 Types

A new pure module, `src/blocks/query.ts`. The names reuse `Direction`
(`"down" | "up"`, `src/blocks/view.ts`), so there is one name for each
direction.

```ts
/** The rule for the rows beneath a row. */
export type Query = { type: "links"; direction: Direction } | { type: "collapse" }

/** The link pivots of one frame: block id → the direction its rows walk.
 * Keyed by block id, as Pensive keys them (see 4.4). */
export type LinkPivots = ReadonlyMap<string, Direction>

/** Everything a walk reads to decide a row: the frame's link pivots, and
 * the fold rule (the reader's folds over the depth rule) for collapse. */
export interface WalkRule {
  pivots: LinkPivots
  expanded: ExpandedRule
}

/** The query beneath one row. Pure. */
export function queryAt(
  rule: WalkRule,
  row: { key: string; id: string; level: number; type?: string },
  inherited: Direction,
): Query
```

`queryAt` decides in this order:

1. The fold rule says the row is closed → `collapse`. A fold wins over a
   link pivot, as in Pensive. The pivot stays stored. When the reader opens
   the row, the pivot applies again.
2. The block has a link pivot → `links` in that direction.
3. Else → `links` in the inherited direction (the direction of the row
   above's query; the frame's root query at the top).

`Occurrence` (`src/blocks/view.ts`) gains one field, `pivot?: Direction`,
set when the row's block has a link pivot. The editor draws the marker from
it.

The root query of a frame is the pivot on the frame's root id (the note id
or the focused block id). No pivot there means down. So a pivot on the root
is read, which Pensive does not do.

### 4.3 The guard: one rule in both directions

The rows beneath a row are the ids its query lists, with one rule:

- The block the row **came from** is not a row beneath it. That is the row
  above, when the row above is reached in the other direction (an up row
  beneath a down row, or a down row beneath an up row).
- Any other block already on the path is a **looped** row: shown once, as a
  leaf, with no chevron and no pivot control.

Today the guard skips every parent on the path. Under the new rule an up
loop shows where it closes, the same as a down loop. Example: blocks C and D
hold each other, and C is in N. Pivot C up. Beneath C: D (C's holder).
Beneath D (still up): C is D's holder and is on the path, so C shows as a
looped leaf. Today that C is skipped, and the reader cannot see the loop.

The note id (or the focused block id) is on the path from the start, as
today (`rootId` in `walkGraph`).

### 4.4 Where pivot state lives

| Choice                    | Result                                                                                              |
| ------------------------- | --------------------------------------------------------------------------------------------------- |
| Per frame, in the URL     | **Decided.** Each pane and each frame has its own. Reload, share and pop keep them.                 |
| Per view, in localStorage | Two panes on the same view share pivots. Lost on another device.                                    |
| In the `views` table      | Synced, but it is a schema change, and it mixes reading state with what a note lists. Not proposed. |

The design:

- The frame (7.5) holds `pivots: LinkPivots`. A pushed frame starts with
  none (decision 1, 7.4). `popTo` keeps each frame's pivots as they are, so
  a pop restores the pivots the reader left.
- The URL holds them in the frame's encoding (7.5). A change of pivot
  replaces the URL entry (`replace: true`), so it does not add a history
  step.
- Pivots are keyed by **block id**, as in Pensive, not by occurrence key. A
  pivot is a question about a block ("what holds this?"). The answer is the
  same at each place it shows, and an id is short in a URL. It also
  survives an indent or a move that changes the row's path.
- Until the split-view work merges, the note route holds one frame's pivots
  in the `pivots` parameter, with the same codec.

### 4.5 Folds are collapse pivots

Folds are frame state (decisions 1 and 3, 7.4). A frame keeps the rows
that differ from the default rule, each by its path of block ids from the
frame root, and the URL holds them (7.5). A pushed frame starts with no
folds, and a pop restores the folds of the frame below. The per-view
localStorage store (`src/data/view-state.ts`) retires. A note's stored
folds seed its frame once (step 10).

At the walk, a fold is the collapse query (`queryAt`, step 1). Folds are
keyed by path, one row each. Link pivots are keyed by block id. Both live
on the frame.

Two rules join them:

- **Setting a pivot opens the row.** The command records an open fold for
  that row in the frame, as `indent` does with `reveal`.
  The reader asked to see the row's holders, so the depth rule must not hide
  them.
- **The depth count starts again at a pivot.** The rows beneath a pivot row
  are level 1, as a focused block's children are. So a pivot opens n levels
  of holders, whatever the depth of the row. (Open question 5.)

A board's row still starts closed (`foldRule`).

### 4.6 The lazy walk, with no budget

`walkGraph` keeps its shape: depth-first, lazy, one `Block` per id. Changes:

- It takes `pivots` and asks `queryAt` at each row, instead of reading one
  `directions` value.
- `blockOf` fills a block's `upstream` list when the row's query is up, or
  the row was reached up. The default view (no up pivot) then builds the
  same doc as today, so the walk-equals-parse invariant still holds.
- There is no queue, no budget and no incomplete marker. Pensive is
  breadth-first only to share its budget fairly. With no budget the order of
  the walk does not change what is drawn.

What bounds the walk is what the reader can see:

- A closed row (fold, depth rule, board) carries its id lists and no rows.
- A looped row is a leaf.
- An up region follows the depth rule, from the pivot row down.

So the cost stays O(rows on screen plus their id lists). The renderer's
hard depth cap stays as a last guard.

### 4.7 A block with many parents, and a cycle

- **Many parents.** A block with two parents is two rows, one per path, as
  today. Each row has its own path and its own fold. A link pivot on the
  block applies to both rows. Beneath an up pivot, a block with three
  holders shows them as three rows, less the one it came from. A text edit
  shows in every row.
- **Order of holders.** Holders have no order of their own. They show in
  the order `parentIdsOf` gives them, as up rows do today. They cannot be
  reordered, as today (decision 6).
- **A cycle.** The guard in 4.3 shows a cycle once where it closes, in
  either direction. A looped row has no chevron and offers no pivot.
  Focusing on it starts a fresh path, as today.
- **A block under itself** stays refused (`docToOps`, paste).

### 4.8 Editing inside an up pivot

Decided (7.4, decision 6): editing behaves as it does today on an up row.
This section records today's behaviour; it adds none.

The rows beneath an up pivot are up occurrences, keyed with `^`, exactly as
the "upstream" setting draws them today. So the doc maths in
`src/blocks/ops.ts` already act on them correctly. They read the direction
off the key. The change is that a command must see the same rows the walk
drew: `CommandInput` gains the frame's `pivots`, and `keysBeneath`
(`src/blocks/commands.ts`) calls the new `rowsBeneath` with them.

Take row X with an up pivot, and its holder rows P1 and P2 beneath it.

| Command on P1 (an up row)       | Effect on the graph                                                                      |
| ------------------------------- | ---------------------------------------------------------------------------------------- |
| Type, change type               | The block's own text and type, as everywhere.                                            |
| Enter (new row after P1)        | A new block that holds X. The new row is an up row beside P1.                            |
| Enter with text after the caret | Refused with a toast when P1 has more than one place, as today for any block held twice. |
| Indent P2 (under P1)            | P2 stops holding X and holds P1. The row now shows beneath P1, as P1's holder.           |
| Outdent P2 (from beneath P1)    | The reverse: P2 stops holding P1 and holds X again, as a row beside P1.                  |
| ⌫ on an empty row, Cut, Unlink  | Unlinks P1 → X. P1 lives on wherever else it is held, or goes to its note's basket.      |
| Delete (block menu)             | `deleteBlockOps`, as everywhere: every inbound link and the row are tombstoned.          |
| Move up or down                 | Refused: holders have no order (`moveBlocks` returns the doc as it is).                  |
| Duplicate                       | Refused: a copy of a holder would copy the block too (`duplicateBlocks` returns null).   |
| Paste in select mode            | As today: each pasted block becomes a new holder of X (`insertBlocksAfter`).             |
| Add downstream / upstream link  | As today: they act on the block, not on the row's direction.                             |
| Set or clear a pivot            | Allowed on any row except a looped row. A down pivot on P1 shows what P1 holds, less X.  |

The pivot row itself (X) edits by its own key, as today. The pivot changes
what is beneath X, not X.

Enter on a heading (`insertBelow`) nests the new block under the heading
with `indentBlock`, in the heading's key direction, so the new block is a
child. Under an up pivot on the heading, the pivot hides that child. This is
what the "upstream" setting does today, and it stays (decision 6). Step 6
pins it with a test.

Markdown stays a tree. The rollup, copy, the clipboard payload and the
search index walk down only, and ignore pivots. Copy of a selection in an up
region copies the selected blocks with what they hold, as today.

### 4.9 Filter and sort

Section 5 moves the filter, the sort and a new sections-only toggle into the
walk. They apply to down rows only. An up region is kept whole, as Pensive's
prune keeps a pivoted subtree whole (open question 7).

### 4.10 What the reader sees

- The block menu gets two entries: **Show what holds this** (up) and, on a
  row in an up region, **Show what this holds** (down). A row with a pivot
  gets **Clear pivot** instead of its current entry. The final copy is for
  Finn (docs/settings.md, Copy).
- One shortcut cycles the selected row's pivot: up, then down, then none.
  It goes in `src/shortcuts/registry.ts` and `src/blocks/keymap.ts`.
- A pivoted row shows a small arrow beside its chevron: up for "held by",
  down for "holds". The rows beneath look like rows.
- The touch screen offers the same entries in the long-press sheet.

### 4.11 What does not change

- The graph, the `link` table, ops, events, sync and D1.
- The occurrence key format (`/` and `^`), inside the editor. The frame
  stores paths (decision 2).
- The doc maths for up rows.
- Markdown import and export.

## 5. Sections and the in-place filter

Finn uses Pensive's sections toggle (`q`) to walk the structure of a note
without the detail. This section adds a sections-only toggle to each pane,
and moves the text filter into the walk.

### 5.1 What ruminate has now

- **Filter.** The note header's Filter takes a query-language string
  (`?filter=`, `viewNarrowing`, `src/utils/view-narrowing.ts`). The search
  engine answers it (`searchBlocks`). `filteredView`
  (`src/data/filter-view.ts`) then prunes an **eager** walk. It keeps a
  match, the match's ancestors (drawn dimmed, as `context`), and everything
  beneath the match. The row in edit stays until the edit leaves it
  (`keep`). The split-view work keeps the filter on the first pane only.
- **Sections.** There is no toggle. `type:heading` as a filter does not do
  the job: it keeps everything beneath each heading, so the note comes back
  almost whole. ⌘P lists the headings in the palette, but that is a list,
  not the outline.

### 5.2 State: on the frame

The filter and sections-only are fields of the frame (7.5), beside its
pivots and folds.

- Each pane, and each frame in a pane's stack, has its own toggle and its
  own filter. A pop restores them with the frame, as in Pensive.
- A pushed frame starts with no filter and sections-only off (decision 1,
  7.4).
- The URL holds both in the frame's encoding (7.5). The first pane's frame
  on screen keeps `?filter=`, so links made before panes still open
  filtered.
- A View's `filter` column is the top frame's filter, as `narrowingParam`
  reads it today. The frames below keep theirs in the `stack` field (7.6).
  The sort stays a View setting.

### 5.3 Sections-only

**What counts as a section.** A heading block: `h1`, `h2` or `h3`
(`isHeading`, `src/blocks/markers.ts`). Decided (7.4, decision 4): no other
type counts, and there is no section flag.

**The rule.** With sections-only on, a down row shows when:

1. it is a section, or
2. a section is beneath it. It is then drawn dimmed, as path, like the
   filter's `context`.

Beneath a section, only rows that pass the same rule show. So the body of a
section is hidden, and a section's chevron shows only when a section is
beneath it. This is Pensive's prune, and it is different from the text
filter, which keeps a match's body.

**With a text filter.** Both apply: a row passes when it is a section and
it matches. Its ancestors stay as path.

**The view's root** always stays, as the filter keeps it today
(`keepRoots`). A note with no sections shows its title and a short notice.
The notice copy is for Finn.

**Pivots.** Sections-only applies to down rows only. An up region is kept
whole (4.9).

**Edits.** A sections-only view is a narrowed view. It edits by the rules a
filtered view edits by today (`docToOps` with `shown`): text and type edits
act on the block; a move or an indent acts among the rows shown; the hidden
rows and their order do not change. A new row made by Enter after a heading
is not a section. It stays while in edit (`keep`), and then goes, as a
non-matching row does under a filter today.

### 5.4 The in-place text filter

The filter keeps its query language and its prune rule (a match, its
ancestors as path, and its body). The change is where it runs: in the walk,
per frame, for every pane.

- **Per frame and per pane.** It comes from `Frame.filter` (7.5). The
  second pane gets a filter of its own.
- **One box.** The pane header's Filter field. `/` already focuses the
  page's search field (`APP_SHORTCUTS.focusSearch`). On a note, `/` in select
  mode focuses the active pane's filter field. `Escape` in the field leaves
  it, and `Escape` again on an empty field clears the filter.
- **Scope.** The engine scopes hits to the note (`viewNarrowing`). Rows of
  other notes in an up region never match. So the filter keeps an up region
  whole (4.9).

Pensive also has "hide snoozed". Ruminate has no snooze. The nearest
counterpart is "hide done to-dos" (`-type:done` as a filter today). A third
toggle is open question 15.

### 5.5 Part of the walk, and still lazy

Today a narrowed view walks the whole note eagerly, because a branch's fate
depends on what is beneath it. Both narrowings can tell that from an index
instead, so the walk stays lazy and has no budget:

- **Sections.** A `sectionReach` set per snapshot: every node from which a
  section can be reached down. Build it once by walking **up** from each
  section over the reverse index (`parentLinks`). Memoise it on
  `graphSnapshotAtom`, so every pane shares it. The cost is O(sections ×
  their ancestors).
- **Text filter.** The ancestor closure of the matched ids, built by
  walking up from each match to the view's root. The cost is O(matches ×
  depth), once per filter and snapshot.
- **Sort.** `walkGraph` orders a block's child list when it walks the
  block. Each `Block` already holds the complete list, so the sort needs no
  eager walk either.

`walkGraph` takes the narrowing as one more option. Beneath a row it lists
only the children that pass: in the reach set or the closure, or beneath a
match. Then it asks the fold rule as usual. `filteredView` becomes a thin
wrapper and then goes away (step 13).

### 5.6 Keys

**Row paths.** A narrowed row keeps the path it has in the full frame,
because the path is the row's place in the graph. So a selection, a fold or
a pivot survives a toggle of sections-only or of the filter.

**Narrowed folds.** A narrowed walk's default is everything open. The frame
keeps its folds apart (`narrowFolds`, 7.5) and clears them when the filter
or sections-only changes. So a fold made in sections-only never closes a
row of the full frame.

**Keyboard keys.**

| Key (select mode)   | Action                                                   |
| ------------------- | -------------------------------------------------------- |
| `q`                 | Toggle sections-only in the active pane. Free on `main`. |
| `/`                 | Focus the active pane's filter field.                    |
| `Escape` (in field) | Leave the field. On an empty field, clear the filter.    |

The split-view work adds `o` (open beside), so `q` does not collide. The
help panel lists the keys from `src/shortcuts/registry.ts` as usual.

## 6. Fold state: why rows need folding again

Finn often folds and unfolds the same rows again and again. This section
finds the causes in the code, compares Pensive, and ranks the fixes.

### 6.1 The fold model today

- A standing **depth rule**: a row is open while `level < n`, n = 2 by
  default (`expandedByDepth`, `src/blocks/default-collapsed.ts`).
- Over it, the reader's **own folds**: open and closed occurrence keys, per
  view, in localStorage (`collapse:<viewKey>`, `src/data/view-state.ts`).
  At most 500 views are kept.
- A board row starts closed (`foldRule`).
- A narrowed view has its own entry, over a rule of everything open.

### 6.2 Causes

1. **Leaving a focus stores opens.** `revealOnLeaveFocus`
   (`src/routes/_appRoot.views_.$.tsx`) opens each closed fold on the path
   back to the block, with `setFold(key, true)`. These are stored as the
   reader's own opens. After a few focus trips the note stays open along
   every path the reader came back on, and the reader folds those rows
   again.
2. **Focus changes the keys and the levels.** `blockView` keys rows from
   the focused block (`F/c`). The note keys the same row `a/F/c`. So a fold
   made in focus does not apply in the note, and the opposite. The depth
   rule also counts from the focused block (level 0), so a row closed in
   the note can be open in focus, and the opposite.
3. **A fold is lost when its row moves.** Indent, outdent, a move to
   another parent, cut and paste, and a drag give the row a new path, and
   so a new key. The new key has no entry, so the depth rule decides. The
   level can change too, so a row that was open can now start closed.
4. **The depth rule closes new rows.** A row that arrives from another
   device, a paste or a sync is decided by the rule. Every parent at
   level n starts closed.
5. **A block with two places has two folds.** The reader folds it in one
   place and finds it open in the other.
6. **Folds stay on one device.** Another device, a cleared browser, or a
   note older than the last 500 written starts on the depth rule again.
7. **Two panes overwrite each other** (when the split view lands). Each
   `useFoldRule` holds its own copy and writes the whole entry on each
   toggle (`writeFolds`). Two panes, or two browser tabs, on one note undo
   each other's toggles. A reload shows the last pane's set.
8. **A filter's folds stay with the filter.** A fold made while filtered
   does not carry to the note. This is by design.

### 6.3 What Pensive does

- Everything is open by default. The 200-row budget stops the walk.
- A collapse is keyed by entity id, per tab. It survives a move and
  applies at every place the entity shows.
- The reader narrows by scope, not by folds: push a frame (focus), or
  turn on sections-only or a text filter. A pop restores the frame as it
  was.

### 6.4 Fixes, ranked by value against cost

| Rank | Fix                                                                                                                                                                                                                                                                          | Causes  | Value  | Cost   |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ------ | ------ |
| 1    | **Do not store the opens that leaving a focus makes.** Hold them on the frame, as a transient layer over the folds. `useFoldRule` already takes a `held` set for this kind of layer.                                                                                         | 1       | High   | Low    |
| 2    | **Write one key, not the whole entry.** Read the stored entry, change the one key, and write it back. Listen for the `storage` event so other panes and tabs see the change.                                                                                                 | 7       | High   | Low    |
| 3    | **Move a fold with its row.** `indentBlock` and `outdentBlock` already return the row's new key. A move among siblings keeps its key. Cut and paste, and a drag, pass the old and the new path. Rewrite the stored keys under the old path to the new path in the same step. | 3       | High   | Low    |
| 4    | **Scope instead of fold.** Sections-only (`q`) and the per-pane filter (section 5) let the reader see the structure without closing rows one by one, and leave the folds alone.                                                                                              | 4, 5    | High   | Medium |
| 5    | **A depth setting of "All"** (Pensive's default), plus two fold commands: fold the siblings of the row, and fold the note to the row's level.                                                                                                                                | 4       | Medium | Low    |
| 6    | **Collapse by block id** (Pensive), with a key per row only for a block that shows in more than one place. A fold then survives a move and applies in focus and in the note. `foldRule` already reads bare-id entries.                                                       | 2, 3, 5 | Medium | Medium |
| 7    | **Folds per focus frame.** A frame keeps the folds made in it, so a pop restores them exactly. With fixes 1 and 2, a pop already restores the view it returns to, so this adds little.                                                                                       | 1, 2    | Low    | Medium |
| 8    | **Folds on every device.** Sync the reader's folds. This needs a store change, which is out of scope here.                                                                                                                                                                   | 6       | Medium | High   |

This ranking was made before Finn's decisions. 6.5 gives what they
settle.

### 6.5 What the decisions settle

Finn decided on 2026-10-20 that folds are frame state, in the URL, as
differences from the default rule, keyed by path (7.4, decisions 1 to 3).
So:

- **Fix 7 (folds per frame) is the model.** A pop restores the frame's
  folds exactly. A push starts with none.
- **Fix 1 follows from it.** The opens that leaving a focus makes go into
  the new frame only. A pop drops them with the frame.
- **Fix 2 is not needed.** There is no shared store to overwrite: each
  pane's frames hold their own folds.
- **Fix 3 is still needed.** A fold is a path, and a move changes the path
  (step 12).
- **Fix 4 is built** by section 5.
- **Fix 6 is not done.** Folds are keyed by path, the same identity as the
  selection (decision 2).
- **Fix 5 is still open** (open question 16).
- **Fix 8 is in part solved.** A URL carries its folds to another device,
  A View does not save folds (7.6, 7.7).

What stays from 6.2: cause 3 (a move) until step 12; cause 4 (the depth
rule closes new rows), which is the rule; and cause 5, which is now by
design: a block in two places is two paths.

## 7. How it fits together

Finn decided this model on 2026-10-20. This section records it as decided.
7.6 records Finn's later proposal, recommended here: a View saves a whole
stack. Section 9 keeps the questions that are still open.

### 7.1 Terms

- **View** — a saved stack of frames: a bookmark. A View with one frame is
  the simple case. It is a row in the `views` table (`root_id`, `filter`,
  `sort`, `pinned`, `sort_key`, and the recommended `stack`), synced as
  view events. Decided on 2026-10-20 as one saved frame; Finn's later
  proposal, recommended here, makes it a stack (7.6).
- **Pane** — one column of the split view. It holds a stack of frames: its
  history. Its **base frame** comes from a View, or from the hidden root.
- **Frame** — one live query state: a root, a selection, pivots, a filter
  (text and sections-only) and folds. The URL holds it (7.5).
- **The hidden root** — the `corpus_root` node. A frame rooted there is the
  list of all notes.

| Ruminate        | Pensive          | What it is                                                    | Where it is kept                         |
| --------------- | ---------------- | ------------------------------------------------------------- | ---------------------------------------- |
| The graph       | The entity store | One graph per user: `nodes` and `link` rows.                  | D1 and the browser's SQLite, synced      |
| The hidden root | —                | The `corpus_root` node. Its frame lists every note.           | A node and its `child` links             |
| A **View**      | A saved stack    | A saved stack of frames: a bookmark into the graph.           | The `views` table, synced as view events |
| A **pane**      | A tab            | A stack of live frames: the pane's history.                   | The URL (`src/data/panes.ts`)            |
| A **frame**     | A frame          | One live query state: root, selection, pivots, filter, folds. | The URL (7.5)                            |
| A pivot         | A pivot          | A query on one block (section 4).                             | The frame                                |
| A fold          | A collapse       | A collapse on one row, kept as a difference from the default. | The frame                                |

### 7.2 How the parts move

1. **One graph.** Notes hang under the hidden root. Today the root
   (docs/graph-storage.md, "Ordering notes") orders notes only. It holds
   only the notes that were dragged. A note is a note because its type is
   `note`.
2. **Open a View.** The pane's stack becomes the View's saved frames, base
   first, with the top frame on screen (7.6). A one-frame View gives one
   frame.
3. **Open the hidden root.** The pane's base frame is the list of all
   notes (decision 5).
4. **Focus pushes a frame.** The new frame is rooted at the focused block.
   Its filter, pivots and folds are the defaults (decision 1).
5. **Pop restores the frame below** as it was: its root, selection,
   pivots, filter and folds. The URL holds each of them, so nothing is
   recomputed.
6. **Save as view** writes the pane's stack, up to the frame on screen,
   into the View row of the top frame's root (7.6).
7. **The breadcrumb** shows the stack's frames, then the path inside the
   frame on screen. The split-view work builds it. A frame crumb pops to
   that frame. A path crumb is one id of the selection path (decision 2). A
   click on a path crumb pushes a frame rooted there.
8. **Back pops a frame.** Each push adds a browser history entry. A change
   of selection, pivot, filter or fold replaces the entry and adds none.

### 7.3 An example

1. Finn opens the View "Project X" from the sidebar. Pane 1 has one frame:
   root "Project X", with the View's saved filter.
2. Finn presses `q`. The frame now has sections-only on. The outline shows
   the headings only.
3. Finn selects the heading "Decisions" and presses `f`. A frame is pushed,
   rooted at "Decisions", with no filter, no sections-only, no pivots and
   no folds. The crumbs read "Project X › Decisions".
4. Finn puts an up pivot on one row, to see the other notes that hold it,
   and folds two rows.
5. Finn presses `⇧F` (or Back). The pane pops to "Project X", with
   sections-only on, "Decisions" selected and the frame's folds as they
   were. The pivot and the two folds of the popped frame are gone.
6. Finn chooses **Save as view**. The "Project X" View now holds this
   frame, with sections-only on (7.6). Had he saved in step 4, the View
   would be rooted at "Decisions", with "Project X" saved below it.

### 7.4 Decisions (2026-10-20)

1. **A pushed frame resets.** Its filter (text and sections-only), its
   pivots and its folds start at the defaults. Nothing is inherited. A pop
   restores the frame below exactly.
   - `goTo` (`src/data/panes.ts`) makes the new frame with default fields.
     There is no inheritance rule to build or test.
   - Leaving a focus for a wider view that is not on the stack is a push
     too. The opens that `revealOnLeaveFocus` makes go into the new frame's
     folds only (6.5).

2. **Selection identity is the path of block ids from the frame root**, as
   in Pensive. The root is not part of the path.
   - Occurrence keys do not equal this path today. A focus frame's keys
     start with the root id (`F/c`), and a note frame's keys do not. An up
     segment carries `^`. So the frame stores the path, not the key.
   - From key to path: `pathIdsOf(key)` (`src/blocks/view.ts`) already
     strips the marks. A focus frame drops the first id.
   - From path to key: walk the path from the root. The query of each row
     (the frame's pivots) gives the direction of the next step. Once "Show
     links" goes (step 9), each row walks one direction only, so a path
     names one row at most.
   - Folds use the same identity: a fold is a path (7.5).
   - When a path no longer names a row (the block moved), select the
     block's first row in the frame by id. When the block is gone, select
     nothing.
   - Pivots stay keyed by block id (4.4, open question 1).

3. **Frame state lives in the URL**, encoded compactly. Folds are kept as
   differences from the default rule. The URL can grow too long; 7.5 gives
   the sizes and the fallback.

4. **A section is a heading block** (`h1`, `h2`, `h3`; `isHeading`). Linked
   note rows and board rows are not sections. There is no section flag.

5. **A note with no View shows only in a frame rooted at the hidden root.**
   - The root frame's rows are every live note. First come the notes the
     root links, in `sort_key` order. Then come all other notes, by title.
     These are rows the walk adds from the note type, so no backfill of
     root links is needed.
   - A move of a note row in the root frame writes the root's `child` link,
     as a drag writes it today (`src/data/note-order.ts`).
   - "No View" means no listed `views` row. Such a note is in no other
     list: not the sidebar's Views and not the Views page. Search, Recent,
     the calendar and a link still open the note itself, because they open
     a node, not a list.
   - The sidebar and the Views page get one entry that opens the root
     frame. Its label is for Finn.

6. **Editing inside an inbound pivot behaves as editing does today** on an
   up row (docs/graph-schema-v2.md, "Upstream"). 4.8 records each case.
   - A paste after an up row adds each pasted block as a new holder.
     `insertBlocksAfter` reads the direction off the key.
   - Enter on a heading with an up pivot makes a child, which the pivot
     hides. This is what the "upstream" setting does today. It stays.
   - Holders cannot be reordered or duplicated, as today.
   - The one change: a command sees the rows the walk drew, so
     `CommandInput` carries the frame's pivots.

7. **The phone works as it does today.** Focus goes down; the breadcrumb
   goes up. The browser's Back pops a frame (the gesture, Android's Back
   key, or the browser button). The phone shows one pane only. It offers
   no split, and a URL with a second pane shows the active pane only, as
   the split-view work does.

### 7.5 The frame in the URL

The frame type replaces `FocusFrame` (`src/data/panes.ts`):

```ts
interface Frame {
  /** The note the frame is in; `corpus_root` for the list of all notes. */
  noteId: string
  /** The block the frame is rooted at; null = the whole note. */
  root: string | null
  /** The selected row: block ids from the root (decision 2). [] = none. */
  selection: string[]
  pivots: LinkPivots
  /** The in-place filter: a query-language string; "" for none. */
  filter: string
  sections: boolean
  /** The depth rule's n when the frame was made (2 by default), so a fold
   * difference means the same on every device. */
  depth: number
  /** Rows that differ from the default rule, by path. */
  folds: FoldDiff
  /** The same for the narrowed walk; cleared when the filter or
   * sections-only changes. */
  narrowFolds: FoldDiff
}

interface FoldDiff {
  open: string[][]
  closed: string[][]
}
```

**The default rule** is the depth rule at the frame's `depth`, with a
board row closed. A narrowed walk's default is everything open. A fold
equal to the default is not stored.

**The encoding.** A frame stays one comma-free string in the pane's
parameter, as the split-view format has it. Its fields are in a fixed
order, and empty trailing fields are left out:

```
note : root : selection : pivots : filter : flags : folds : narrowFolds
```

- A block id loses its `blk_` prefix (`blk_` + 10 base-36 characters
  becomes 10 characters). Other ids stay as they are.
- A path joins its ids with `.`.
- Pivots: each id with a direction mark.
- The filter is URI-encoded.
- Flags: `s` for sections-only, `d3` for a depth other than 2.
- Folds are a prefix tree, so rows with a common path share it. Each leaf
  ends with an open or a closed mark.

Step 17 picks the final marks, with a round-trip test over each id shape
(`blk_` ids and the older date-shaped note ids).

**The size.**

| What                                                                   | About            |
| ---------------------------------------------------------------------- | ---------------- |
| One id in a path                                                       | 11 characters    |
| A frame: root, a 3-id selection, 2 pivots, a short filter and 10 folds | 200 characters   |
| A pane with 5 frames                                                   | 1,000 characters |
| Two panes with 5 frames each                                           | 2,000 characters |
| One frame with 100 folds                                               | 1,200 characters |

**Yes, the URL can grow too long.** Each fold in each frame of each pane
adds to it. Browsers accept long URLs, but a link pasted into a chat or a
log is hard to use past about 2,000 characters. The Worker serves every
route, and Cloudflare refuses a URL over 16 KB.

**The fallback**, in this order:

1. Keep the URL under a cap: 2,000 characters is proposed.
2. Over the cap, move the frames below the top frame of each pane into
   `sessionStorage`, under a short token. The URL holds the token in place
   of those frames. A reload or Back in the same tab restores them. A link
   copied to another browser opens the top frame, without the stack below.
3. If the top frame alone is over the cap, move its folds the same way. The
   URL keeps the root, the selection, the pivots and the filter: the part
   that a shared link needs.
4. **Save as view** keeps a stack for good, in the View row (7.6).

### 7.6 A View saves a stack (recommended)

Status: proposed by Finn after the decisions of 2026-10-20. This design
recommends it. It replaces "a View is one saved frame": a one-frame View is
now the simple case of a saved stack.

**Why.** Finn's "Todos" View is the path he walks: Ruminate › Tasks ›
Todos. "Ruminate" is the hidden root frame (the list of all notes). Opening
the View restores all three frames, so:

- the breadcrumb shows the path he used, not a path the app picks;
- `⇧F` and Back pop to "Tasks", then to "Ruminate", as if he had walked
  there;
- the saved path picks the parent of a block with many parents. If "Todos"
  is held by "Tasks" and by "Projects", the View says "Tasks".

**The row.**

- `root_id` is the **top** frame's root: the frame on screen when the View
  opens. So "one View per root" holds, and the row is still minted under
  its root's id.
- `filter` and `sort` stay the top frame's.
- A new field, `stack`, holds the rest: the frames below the top, base
  first, and the top frame's pivots and sections-only. Each frame below
  holds its note, its root, its filter (text and sections-only) and its
  pivots. The field uses the frame encoding of 7.5, without selections and
  folds. Empty means a one-frame View, which is every View today.
- Selections and folds are not saved. A lower frame's selection is the path
  to the next frame's root. When the View opens, each lower frame opens the
  folds on that path, as `revealOnLeaveFocus` does, so the crumbs and the
  rows agree.

**The event.** The view event vocabulary (docs/event-sourcing.md, "One
event = one change to one entity") gains `stack`: `create` may set it, and
`update` may set it, as an absolute value like every other field. An older
client that edits another field of the row leaves `stack` as it is,
because an update patches only the fields it names. This is a schema
change: a `views.stack` column in D1 and in the local store's schema ladder
(`migrations/`), and the field in the fold and in `GET /api/replica/verify`.
This document only records it. The step that builds it (step 19) makes the
migration.

**Open a View.** The pane's stack becomes the saved frames, base first,
with the top frame on screen. These frames are restored, not pushed, so
they keep their saved filters and pivots (decision 1 applies to a push).

**Save as view** saves the pane's whole stack, up to the frame on screen,
into the View of the top frame's root. On a root that has a View, it
overwrites that row. **Add to Views** stays as today: it lists the root
alone, a one-frame View.

**When the saved path no longer holds.** A block in the path can move, be
unlinked or be deleted. On open, check the stack from the top down:

1. Keep the top frame while its root exists. When the top root is gone,
   leave the View out of the list, as today.
2. Keep each lower frame while its root still reaches the root of the frame
   above it (`pathToBlock`, `src/data/graph.ts`).
3. At the first frame that fails, drop it and every frame below it.
4. Show the graph path to the top root in the breadcrumb, as path crumbs:
   the shortest chain that `pathToBlock` finds from the top frame's note.

The row does not change on open. The next **Save as view** writes the
stack as it is then.

**The sidebar** shows the View's name, which is its top root's title or
text, as today. After the name it shows the path as a hint: the roots of
the frames below, for example "Todos" with "Ruminate › Tasks", in the
secondary colour and clipped to fit. The Views page and the palette draw
the same list (`viewEntriesAtom`), so they show the same hint. A one-frame
View has no hint.

### 7.7 Still open

- **The `stack` field** (7.6) is a schema change. Until it is built,
  **Save as view** saves the top frame's root, filter and sort, as
  **Update to default** does today.
- **One View per root.** A View is minted under its top root's id, so
  **Save as view** on that root overwrites the row. Two Views that end on
  the same block by two paths (for example "Todos" by "Tasks" and by
  "Projects") are not possible. More than one View per root is a further
  schema change.
- **Folds in a View.** 7.6 saves no folds. Ask Finn if a View must also
  restore folds.
- **The root frame's entry.** Where the "all notes" entry sits, and its
  label.

## 8. Migration plan

Each step is one small PR. Each PR runs only the test files it touches, and
the pre-push gate. A step that a reader can see adds a changelog file.

1. **Add the query types and the rule.** Add `src/blocks/query.ts` with
   `Query`, `LinkPivots`, `WalkRule` and `queryAt`. No caller yet.
   Tests (`query.test.ts`): fold beats pivot; pivot beats inherited; no
   pivot inherits; the depth count starts again at a pivot; a board row
   starts closed.
2. **Teach `walkGraph` to read pivots.** Add `WalkOptions.pivots`, passed
   through `noteView` and `blockView`. Keep `directions` as it is for now.
   With no pivots, the walk is the same as today.
   Tests (`graph.test.ts`): every existing walk test passes unchanged; an up
   pivot on a row lists its holders, less the row it came from; the region
   inherits up; a down pivot inside an up region; a pivot on the note root;
   a closed row beneath a pivot is not walked (its rows are not in
   `blocks`).
3. **Teach the rows to read pivots.** `buildRows`, `walkDoc`,
   `rowsBeneath`, `occurrenceKeys` and `firstOccurrenceKey` take the
   pivots. `Occurrence.pivot` is set. `CommandInput` gains `pivots`, and
   `keysBeneath` uses them.
   Tests (`view.test.ts`, `commands.test.ts`): the rows equal the walk for
   the same pivots; `hasChildren` follows the row's query; fold toggles
   under a pivot act on the right keys.
4. **Hold pivots on the frame.** Add `pivots` to the frame (7.5) and the URL
   codec (`src/data/panes.ts`), or, before the split-view work merges, a
   `pivots` parameter on the note route. `useNoteDoc` passes them to the
   walk.
   Tests (`panes.test.ts`): format and parse round-trip; a malformed pivot
   is dropped; `goTo` starts a frame with none (decision 1); `popTo`
   restores a frame's pivots; two panes keep their own.
5. **Let the reader set a pivot.** Add the block menu entries, the
   shortcut, the row marker and the long-press entries. Setting a pivot
   records an explicit open fold. Add a changelog file.
   Tests: a `commands.test.ts` case for the pivot command; `keymap.test.ts`
   resolves the shortcut; a Storybook story with an up pivot (its visual
   baseline comes from CI).
6. **Pin every edit inside an up pivot.** Add a test for each row of the
   table in 4.8, on a block with two holders and on a cycle. The tests pin
   today's behaviour (decision 6); this step changes none.
   Tests: `commands.test.ts`, `ops.test.ts`, `block-editor` tests for paste.
7. **One guard in both directions.** Show an up loop where it closes
   (4.3). This changes what the "upstream" setting shows, so it is its own
   PR.
   Tests (`graph.test.ts`, `view.test.ts`): a two-block cycle walked up
   shows one looped leaf; the row it came from is still skipped.
8. **Pivots in a narrowed view.** `filteredView` walks with the frame's
   pivots, and keeps an up region whole (4.9). Step 13 later moves the
   narrowing into the walk.
   Tests (`filter-view.test.ts`): a filter does not prune an up region; a
   sort leaves up rows in holder order.
9. **Retire "Show links".** Remove `linkDirectionsAtom`, `LinkDirections`,
   the `directions` options and the Settings entry. Remove the stored
   `link-directions` value. Update `docs/graph-schema-v2.md` ("Upstream"),
   `docs/graph-storage.md` ("How the app is fed"),
   `docs/block-editor-architecture.md` ("Rows, keys and direction") and
   `docs/settings.md`. Run knip. Add a changelog file.
   Tests: the settings tests lose the option; the walk tests that used
   `directions` move to pivots.

10. **Folds on the frame** (decisions 1 and 3; 4.5, 6.5). Add `folds`,
    `narrowFolds` and `depth` to the frame, as paths, with their URL form.
    `useFoldRule` reads the frame instead of localStorage. A pushed frame
    starts with none. The first open of a note seeds its base frame from the
    stored `collapse:<noteId>` entry, once. Then remove the store, its
    500-view cap and the Settings reset.
    Tests (`panes.test.ts`, `view-state.test.ts`): fold paths round-trip; a
    fold equal to the default is not written; a push starts with no folds;
    a pop restores them; two panes keep their own; the seed reads a stored
    entry once. Add a changelog file.
11. **Selection as a path** (decision 2). Store the frame's selection as a
    path of ids. Add `pathOfKey` and `keyOfPath` beside `pathIdsOf`
    (`src/blocks/view.ts`). Fall back to the block's first row, then to
    none.
    Tests (`view.test.ts`, `panes.test.ts`): key to path to key round-trips
    in a note frame, a focus frame and an up region; a moved block selects
    its first row; a gone block selects nothing.
12. **Move a fold with its row** (fix 3). Add a pure `rekeyFolds(folds,
from, to)` over paths. Indent, outdent, cut and paste, and a drag call
    it with the old and the new path.
    Tests (`view-state.test.ts`, `commands.test.ts`): a closed row stays
    closed after indent and outdent; its closed descendants stay closed;
    other paths do not change. Add a changelog file.
13. **Narrow inside the walk** (5.5). Add the `sectionReach` index and the
    filter's ancestor closure. `walkGraph` takes the narrowing and sorts
    child lists as it walks. `filteredView` becomes a thin wrapper, then
    goes.
    Tests (`graph.test.ts`, `filter-view.test.ts`): the lazy walk gives
    the same rows, context and matches as the eager walk for every
    existing filter test; a closed row is not walked; a loop ends the
    walk.
14. **Sections-only** (5.3). Add the `sections` frame flag, its URL form,
    the `q` key and a header toggle.
    Tests: `query.test.ts` or `graph.test.ts` for the rule (a heading, a
    path row, a hidden body, a linked note row that is not a section, a
    note with no sections); `panes.test.ts` for the URL; `keymap.test.ts`
    for `q`; a Storybook story. Add a changelog file.
15. **A filter per frame and per pane** (5.4). Move the filter to
    `Frame.filter`, with the first pane's `?filter=` kept. The second
    pane gets a filter field. `/` focuses the active pane's field.
    Tests (`panes.test.ts`): an encoded filter round-trips; a pop restores
    the frame's filter; two panes keep their own. Add a changelog file.
16. **The hidden root frame** (decision 5). The root frame lists the
    root's notes in `sort_key` order, then every other note by title. Add
    one entry to the sidebar and the Views page that opens it. A move of a
    note row writes the root's link.
    Tests (`graph.test.ts`, `note-order.test.ts`): every live note is a row
    once; a note with no View is a row; a move writes one link. Add a
    changelog file.
17. **A compact URL, with a cap** (7.5). Pick the final marks. Drop the
    `blk_` prefix, write fold paths as a prefix tree, and add the
    `sessionStorage` fallback over the cap.
    Tests (`panes.test.ts`): each id shape round-trips; a frame over the
    cap keeps its root, selection, pivots and filter in the URL; a reload
    restores the stack from `sessionStorage`; a missing token opens the top
    frame.
18. **Back pops a frame** (decision 7). A push adds a history entry; any
    other change of frame state replaces it. The phone offers no split.
    Tests: `panes.test.ts` for which changes push and which replace; an
    `e2e/` case for Back after two pushes, run in the e2e slot.

19. **A View saves a stack** (7.6). Add the `views.stack` column (D1 and
    the local schema ladder), the `stack` field in view events, the fold
    and `GET /api/replica/verify`. **Save as view** writes the stack; opening
    a View restores it and checks the path; the sidebar row shows the
    path hint. Update docs/event-sourcing.md and docs/metadata.md. Add a
    changelog file.
    Tests: the migration on both stores; a `view.update` without `stack`
    keeps it; fold equals tables; the codec round-trips a stack; opening
    restores three frames with the path open; a moved block drops the
    frames below the break and keeps the top; a gone top root leaves the
    View out; the hint shows the lower roots.

Steps 1 to 3 change nothing a reader sees. Steps 4, 10, 11, 15, 17 and 18
need the split-view work's frame model. Steps 5 to 8 can merge in any
order after 4. Step 12 needs step 10. Steps 14 and 15 need step 13. **Save
as view** with a stack waits for step 19 and its schema change (7.6).

## 9. Open questions for Finn

The numbers stay as they were, so the references above still hold. A
question Finn decided on 2026-10-20 says so.

1. **Pivot key.** This design keys a pivot by block id, as Pensive does, so
   a pivot applies to every row of the block in the frame. Do you want it
   per row (occurrence key), like a fold?
2. **"Both".** Pensive has no query that shows children and holders
   together. Do you use "Both" today? If yes, do you want a third query,
   or can it go?
3. **Where pivots live.** Decided: in the URL, per frame (7.4, decision
   3).
4. **Focus into a pivoted row.** Decided: a pushed frame starts with no
   pivots (7.4, decision 1).
5. **Depth inside a pivot.** This design starts the depth count again at a
   pivot, so a pivot shows n levels of holders. Do you want all holders
   open (as in Pensive), or one level only?
6. **An up pivot on the note root.** It replaces the note's blocks with what
   holds the note, as in Pensive. Is that what you want, or must the note's
   blocks stay?
7. **Filter and pivots.** This design keeps an up region whole under a
   filter and under sections-only, as Pensive keeps a pivoted subtree
   whole. Do you want the filter to prune holders too?
8. **Paste and drag into an up region.** Decided: as today. A paste adds
   each block as a new holder (7.4, decision 6).
9. **Order of holders.** Decided: as today, in `parentIdsOf` order, not
   reorderable (7.4, decision 6).
10. **Folds per pane.** Decided: folds are per frame, so per pane too
    (7.4, decisions 1 and 3).
11. **Labels and shortcut.** Which words and which key do you want for the
    pivot entries and the cycle shortcut?
12. **What is a section.** Decided: a heading block only (7.4, decision
    4).
13. **A section's hidden body.** Do you want a count of hidden rows on a
    section in sections-only, so you can see where the detail is?
14. **The filter's language.** The design keeps the query language
    (`type:`, `under:`, text). Pensive matches plain text only. Is the
    query language right for the in-place filter?
15. **A third toggle.** Do you want "hide done to-dos" as a toggle, the
    nearest counterpart of Pensive's "hide snoozed"?
16. **Depth "All".** Folds are keyed by path, not by block id (decided,
    7.4, decision 2). Still open: do you want a depth setting of "All"
    (fix 5)?
17. **Keys.** Is `q` right for sections-only, and `/` for the filter field?

## 10. Later: layered stores

Finn: a nice-to-have, not for now. This section records the idea only.

**Today.** A share is a slice of another user's corpus, fetched whole and
held in memory, then merged into `graphSnapshotAtom`
(`src/data/shared-mode.ts`, docs/sharing.md). The write seam
(`src/data/store.ts`) sends a batch of ops to the share it names, and only
the verbs the owner granted are allowed. A block cannot live in a shared
note and in one of your own at once.

**The idea.** Treat each share as a read-only **layer** under your own
corpus. Your edits go in your own layer, on top:

- A link from one of your blocks to a block of the share puts that block in
  your outline, with no copy.
- A change of text or type on a share's block is an override row in your
  layer. You see the override; the owner's block does not change.
- To hide a share's link in your view is a hide row in your layer.

**What the walk needs.** Nothing new. The walk reads one merged snapshot,
so pivots, folds, sections and the filter work across layers. An up pivot
on a share's block shows its holders in both layers.

**What it needs elsewhere.** This is why it is not for now:

- Override and hide rows in your corpus, keyed by share and node. That is
  a schema and sync change.
- A rule for an override when the owner later changes the same text.
- A marker on a row that shows an override, and a way to drop it.
- A share with write still writes to the owner's corpus. The layer is for
  read-only shares, or for edits the reader wants to keep private.
