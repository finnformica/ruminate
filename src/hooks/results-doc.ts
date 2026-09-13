import { useAtomValue, useStore } from "jotai"
import React from "react"
import type { NodeRow } from "../../worker/handlers/replica-payload"
import { asBlockType, type Block, type BlockDoc, type ChangeHint } from "../blocks/types"
import { idOfKey, walkDoc } from "../blocks/view"
import { childIdsOf, parseProps, propsJson, type GraphSnapshot } from "../data/graph"
import { partsToOps, reachableFrom, type Op } from "../data/ops"
import { useApplyOps } from "../data/store"
import { graphSnapshotAtom } from "../global-state"
import type { NoteId } from "../schema"

/**
 * **A results view's doc, straight from the graph — and the way back.**
 *
 * The notes list, a search's results and a filtered view are all the same
 * thing: a set of ROOTS (notes, or matched blocks) the block editor draws.
 * A note is a node whose children are its blocks (docs/graph-schema-v2.md),
 * so a note root and a block root are walked the same way. The doc is the
 * walk of those roots over the live snapshot (as `useNoteDoc` walks a note),
 * so an edit — ours a moment ago, or a pull's — shows the instant the
 * snapshot changes, and there is no editor copy to reconcile.
 *
 * The walk is LAZY. Every block in the doc carries its children's ids (the
 * graph's, exactly — which is what draws the fold chevron and keeps a save
 * diff to nothing), but the children themselves are walked in only for
 * blocks the reader has opened (`loaded`). The editor's own walk skips an id
 * whose block is absent, so an unopened row is a row with a chevron and
 * nothing beneath it; opening it loads one more level. Nothing is fetched:
 * the graph is in memory, and this is the O(what is on screen) slice of it.
 */

/** A root of a results view, and the note it is read as part of. */
export interface ResultRoot {
  id: string
  noteId: NoteId
}

/** The doc of `roots` over `graph`, descended into only where `loaded`. */
export function resultsDoc(
  roots: readonly ResultRoot[],
  graph: GraphSnapshot,
  loaded: ReadonlySet<string>,
): BlockDoc {
  const blocks: Record<string, Block> = {}
  const visit = (id: string): boolean => {
    if (blocks[id]) return true
    const node = graph.nodes.get(id)
    if (!node) return false
    const props = parseProps(node.props)
    const block: Block = {
      id,
      type: asBlockType(node.type),
      text: node.text,
      ...(props ? { props } : {}),
      // A node under itself (a corrupted row) has no closing row to show.
      children: childIdsOf(graph, id).filter((childId) => childId !== id),
    }
    blocks[id] = block
    if (loaded.has(id)) for (const childId of block.children) visit(childId)
    return true
  }
  // A block matched twice (once per note that holds it) is one root: the
  // editor keys a root by its id.
  const rootBlockIds: string[] = []
  const seen = new Set<string>()
  for (const root of roots) {
    if (seen.has(root.id)) continue
    seen.add(root.id)
    if (visit(root.id)) rootBlockIds.push(root.id)
  }
  return { props: null, rootBlockIds, blocks }
}

/** The note each block of `doc` is read as part of: a root's own, and its
 * descendants' the root's. A block reached under two roots keeps the first. */
function notesOfBlocks(doc: BlockDoc, roots: readonly ResultRoot[]): Map<string, NoteId> {
  const noteOfRoot = new Map(roots.map((root) => [root.id, root.noteId]))
  const noteOf = new Map<string, NoteId>()
  walkDoc(doc, doc.rootBlockIds, ({ block, parentKey }) => {
    if (noteOf.has(block.id)) return false
    const noteId = parentKey === null ? noteOfRoot.get(block.id) : noteOf.get(idOfKey(parentKey))
    if (noteId !== undefined) noteOf.set(block.id, noteId)
  })
  return noteOf
}

/**
 * The batch that makes the graph hold what a results view now shows — the
 * counterpart of `docToOps` for a doc whose roots belong to several notes.
 * Each note's blocks go through the same reconciliation as a note's own
 * save (`partsToOps`): a retyped block is one `setText`, a new block under
 * a matched one is a `create` and a `link` with that note as its home, a
 * child taken out of a matched block is an `unlink` (the block keeps its
 * note and shows in its Unassigned basket, unless blank). A note root's
 * text is the note's title, so retyping it renames the note.
 *
 * The root list itself is never reconciled: the roots are the view's, not a
 * parent's children (`BlockEditor.fixedRoots` refuses an edit to them).
 */
export function resultsToOps(
  next: BlockDoc,
  roots: readonly ResultRoot[],
  snapshot: GraphSnapshot,
  discard?: Iterable<string>,
): Op[] {
  const byNote = new Map<NoteId, string[]>()
  for (const [id, noteId] of notesOfBlocks(next, roots)) {
    const ids = byNote.get(noteId)
    if (ids) ids.push(id)
    else byNote.set(noteId, [id])
  }
  const now = Date.now()
  const discarded = new Set(discard ?? [])
  const ops: Op[] = []
  for (const [noteId, ids] of byNote) {
    const nodes: NodeRow[] = ids.map((id) => {
      const block = next.blocks[id]
      return {
        id,
        type: block.type,
        text: block.text,
        props: propsJson(block.props),
        updated_at: now,
      }
    })
    // Every block's child order is the graph's unless the edit changed it —
    // an unopened block's is exactly the graph's, so it reconciles to nothing.
    const childrenOf = new Map(ids.map((id) => [id, next.blocks[id].children]))
    ops.push(
      ...partsToOps(
        noteId,
        nodes,
        childrenOf,
        snapshot,
        reachableFrom(snapshot, ids),
        "keep",
        discarded,
      ),
    )
  }
  return ops
}

/** Same ids, same order. */
function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index])
}

/**
 * The live doc of a results view, its folds, and the way back — what a
 * `ResultsEditor` hands the block editor.
 *
 * Folds are the view's own, not the notes': every row starts closed (a list
 * is closed rows until the reader opens one), opening a row loads its
 * children, and a new query (`resetKey`) closes everything again. A row
 * an edit gives children it did not have — a new block, a first child —
 * counts as opened, so what the reader just made is never hidden behind a
 * chevron.
 */
export function useResultsDoc({
  roots,
  resetKey,
}: {
  /** Memoized by the caller: a new array is a new view. */
  roots: readonly ResultRoot[]
  /** The query. Changing it folds everything and forgets what was loaded. */
  resetKey: string
}) {
  const snapshot = useAtomValue(graphSnapshotAtom)
  const store = useStore()
  const apply = useApplyOps()

  const [loaded, setLoaded] = React.useState<ReadonlySet<string>>(() => new Set())
  const [opened, setOpened] = React.useState<ReadonlySet<string>>(() => new Set())

  const prevResetKey = React.useRef(resetKey)
  if (prevResetKey.current !== resetKey) {
    prevResetKey.current = resetKey
    // Render-phase reset: the doc below is derived in this same render, so
    // the first paint of a new query is never stale.
    if (loaded.size > 0) setLoaded(new Set())
    if (opened.size > 0) setOpened(new Set())
  }

  const doc = React.useMemo(() => resultsDoc(roots, snapshot, loaded), [roots, snapshot, loaded])
  const noteOf = React.useMemo(() => notesOfBlocks(doc, roots), [doc, roots])

  // Closed unless opened — every occurrence, leaves included (a fold on a
  // leaf is inert, and a leaf an edit turns into a parent is then opened by
  // the editor's own demand rather than born closed).
  const collapsed = React.useMemo(() => {
    const keys = new Set<string>()
    walkDoc(doc, doc.rootBlockIds, ({ key }) => {
      if (!opened.has(key)) keys.add(key)
    })
    return keys
  }, [doc, opened])

  const toggleCollapse = React.useCallback((key: string) => {
    setOpened((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
    const id = idOfKey(key)
    setLoaded((prev) => (prev.has(id) ? prev : new Set(prev).add(id)))
  }, [])

  const setDoc = React.useCallback(
    (next: BlockDoc, hint?: ChangeHint) => {
      // Diff against the graph as it is NOW (edits can outrun renders).
      const current = store.get(graphSnapshotAtom)
      // A block whose children the edit changed (a new block, a first child
      // given to a leaf, a child moved under a sibling) is loaded from here
      // on, or the walk would drop what was just put beneath it.
      setLoaded((prev) => {
        let grown: Set<string> | null = null
        for (const block of Object.values(next.blocks)) {
          if (prev.has(block.id) || sameIds(childIdsOf(current, block.id), block.children)) continue
          grown ??= new Set(prev)
          grown.add(block.id)
        }
        return grown ?? prev
      })
      apply(resultsToOps(next, roots, current, hint?.discard))
    },
    [store, apply, roots],
  )

  return { doc, collapsed, toggleCollapse, setDoc, noteOf }
}
