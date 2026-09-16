import { useAtomValue, useStore } from "jotai"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { emptyBlock } from "../../blocks/ops"
import type { BlockDoc, ChangeHint } from "../../blocks/types"
import { imagesEnabled, uploadImage } from "../../data/images"
import { fetchLinkPreview } from "../../data/link-previews"
import { deleteBlockOps, deleteSubtreeOps, parentCount } from "../../data/ops"
import { useApplyOps } from "../../data/store"
import { useFoldRule } from "../../data/view-state"
import { collapsedKeysOf } from "../../blocks/default-collapsed"
import { graphSnapshotAtom, isDatabaseModeAtom } from "../../global-state"
import { upstreamIndexAtom, useDeveloperDebug } from "../../hooks/is-developer"
import { resolveBlockSubtrees } from "../../utils/resolve-blocks"
import { BlockEditor, type BlockDebugOptions } from "./block-editor"

/** Ensure a parsed doc always has at least one block to edit. */
function withStarterBlock(doc: BlockDoc): BlockDoc {
  if (doc.rootBlockIds.length > 0) return doc
  const block = emptyBlock()
  return { ...doc, rootBlockIds: [block.id], blocks: { [block.id]: block } }
}

/**
 * Keep an empty block at the very bottom, so there's always somewhere to click
 * and start typing (like Notion). No-op if the last root block is already an
 * empty, childless block.
 */
function ensureTrailingBlank(doc: BlockDoc): BlockDoc {
  const lastId = doc.rootBlockIds[doc.rootBlockIds.length - 1]
  const last = lastId ? doc.blocks[lastId] : undefined
  if (last && last.type === "text" && last.text === "" && last.children.length === 0) return doc
  const block = emptyBlock()
  return {
    ...doc,
    rootBlockIds: [...doc.rootBlockIds, block.id],
    blocks: { ...doc.blocks, [block.id]: block },
  }
}

/**
 * The zoomed-view stand-in for `ensureTrailingBlank`: while zoomed we don't
 * append root-level blanks (they'd be invisible below the zoomed subtree);
 * instead we only make sure the zoom root has at least one child to edit when
 * the zoom *starts* (e.g. zooming into a leaf). Deleting the last child later
 * is allowed — the title alone is a valid view (Enter on it creates a child).
 */
function ensureZoomChild(doc: BlockDoc, zoomId: string): BlockDoc {
  const root = doc.blocks[zoomId]
  if (!root || root.children.length > 0) return doc
  const block = emptyBlock()
  return {
    ...doc,
    blocks: { ...doc.blocks, [block.id]: block, [zoomId]: { ...root, children: [block.id] } },
  }
}

/**
 * Adapts the block editor to the note's doc model. The note's doc (walked
 * from the graph) is seeded on mount; each edit calls `onChange` with the next
 * doc, so the surrounding page keeps its save logic. Remount (via a `key`) to
 * load a different note.
 *
 * An external `doc` (a pull updating the open note, a props edit from
 * the actions menu) re-seeds the editor in place — see the `lastDoc` tracking
 * below — so pulled content appears without a remount or page refresh.
 * Internal edits update `lastDoc` first and are never re-seeded, so live
 * typing can't be clobbered.
 */
export function BlockNoteEditor({
  doc: incoming,
  onChange,
  noteId,
  startEditing,
  onExitTop,
  focusFirstSignal,
  focusFirstMode,
  newRootSignal,
  refocusSignal,
  readOnly = false,
  browse = false,
  zoomBlockId = null,
  onZoomNavigate,
  noteTitle,
  collapseKey,
  folds,
  onToggleCollapse,
  trailingBlank = true,
  rowRemoval = "unlink",
}: {
  doc: BlockDoc
  onChange: (doc: BlockDoc, hint?: ChangeHint) => void
  /**
   * The folds of a doc walked lazily by its owner (the note page,
   * `useNoteDoc`): the keys the walk closed, and the toggle that records
   * the reader's decision and re-walks. Absent, this editor keeps its own
   * (the basket, standalone use): the reader's fold rule over the whole doc
   * it was given.
   */
  folds?: { collapsed: ReadonlySet<string>; toggle: (key: string) => void }
  /** Told after a block is folded or unfolded — the note page counts it as
   * touching the note. */
  onToggleCollapse?: (key: string) => void
  /**
   * The note's id. When provided, the note's folds persist per-device in
   * localStorage (seeded on first open from the default-expansion policy);
   * without it, collapse is transient local state (e.g. Storybook /
   * standalone usage).
   */
  noteId?: string
  /** Start with the first block in edit mode (e.g. a brand-new note). */
  startEditing?: boolean
  /** Navigating up past the first block hands focus here (e.g. the note title). */
  onExitTop?: () => void
  /** Bump to move focus into the first block (e.g. Down-arrow from the title). */
  focusFirstSignal?: number
  /** Whether that hand-off opens the first block editing or just highlighted. */
  focusFirstMode?: "edit" | "select"
  /** Bump to add a new root block (e.g. Cmd+Enter from the title). */
  newRootSignal?: number
  refocusSignal?: number
  /** Display-only: render the note as read-only blocks (e.g. past-day history). */
  readOnly?: boolean
  /** Read-only, but still the reader's to move through, fold and zoom — a
   * note someone shared with them (`BlockEditor.browse`). */
  browse?: boolean
  /** Block id the editor is zoomed into (`?block=` search param), or null. */
  zoomBlockId?: string | null
  /** Zoom navigation (crumbs, F/Shift+F, bullet clicks) — updates the URL. */
  onZoomNavigate?: (id: string | null) => void
  /** The note's title, shown as the breadcrumb's first crumb while zoomed. */
  noteTitle?: string
  /** Where this editor's folds are kept, when not under the note's own id —
   * a second editor on the page (the Unassigned basket) keeps its own. */
  collapseKey?: string
  /** Whether an editable doc always ends with a blank block to type into. Off
   * for the basket: a blank there would be a new unassigned block. */
  trailingBlank?: boolean
  /** What removing a row (⌫, Cut, the menu) does to the block. `"unlink"` —
   * the outline: the block stays, in the note's Unassigned basket if nothing
   * else holds it, and the menu offers Delete beside Unlink. `"delete"` —
   * the basket (`basketToOps`): the removal is the delete, so the menu
   * offers only that. */
  rowRemoval?: "unlink" | "delete"
}) {
  // Read-only history views are shown verbatim; only editable notes get the
  // always-present trailing blank.
  const seedDoc = (incoming: BlockDoc) => {
    const seeded = withStarterBlock(incoming)
    return readOnly || !trailingBlank ? seeded : ensureTrailingBlank(seeded)
  }

  const [doc, setDoc] = useState<BlockDoc>(() => seedDoc(incoming))
  // The last doc this editor produced (or was seeded from). When the incoming
  // `doc` is a different object, the change came from *outside* the editor —
  // a pull that updated the open note, or the page transforming the content
  // (props updates) — so re-seed from it. Internal edits go through
  // `handleChange`, which updates `lastDoc` before `onChange` round-trips, so
  // live typing is never re-seeded or lost.
  const [lastDoc, setLastDoc] = useState(incoming)
  if (incoming !== lastDoc) {
    setLastDoc(incoming)
    setDoc(seedDoc(incoming))
  }

  // Folds: the owner's, or this editor's own rule over its whole doc.
  const own = useFoldRule(folds ? undefined : (collapseKey ?? noteId))
  const ownCollapsed = useMemo(
    () => (folds ? null : new Set(collapsedKeysOf(doc, own.expanded))),
    [folds, doc, own.expanded],
  )
  const collapsed = folds ? folds.collapsed : (ownCollapsed as Set<string>)
  const toggleCollapse = (key: string) => {
    if (folds) folds.toggle(key)
    else own.setFold(key, collapsed.has(key))
    onToggleCollapse?.(key)
  }

  const handleChange = (next: BlockDoc, hint?: ChangeHint) => {
    // While zoomed, the trailing-blank rule is suspended (a root-level blank
    // would be invisible below the zoomed subtree) — see `ensureZoomChild`.
    const withBlank =
      readOnly || !trailingBlank ? next : zoomBlockId ? next : ensureTrailingBlank(next)
    setDoc(withBlank)
    setLastDoc(withBlank)
    onChange(withBlank, hint)
  }

  // "Paste as link": resolve pasted block ids to their live subtree markdown
  // from the graph. Read lazily through the jotai store (no subscription —
  // the graph changes on every edit of any note, and a paste only needs the
  // value at the moment it runs). The graph IS the live truth of the open
  // note too, so nothing is excluded.
  const jotaiStore = useStore()
  const resolveBlocks = useCallback(
    (ids: string[]) => resolveBlockSubtrees(jotaiStore.get(graphSnapshotAtom), ids),
    [jotaiStore],
  )

  // The context menu's graph-aware delete: how many places a block appears
  // (read at open, off the live graph), and deleting it from all of them —
  // a batch of ops applied straight to the graph, which the page then
  // re-walks (not an editor edit, so not an undo step).
  const applyOps = useApplyOps()
  const parentCountOf = useCallback(
    (id: string) => parentCount(jotaiStore.get(graphSnapshotAtom), id),
    [jotaiStore],
  )
  const deleteEverywhere = useCallback(
    (id: string) => applyOps(deleteBlockOps(id, jotaiStore.get(graphSnapshotAtom))),
    [applyOps, jotaiStore],
  )
  const deleteSubtree = useCallback(
    (id: string) => applyOps(deleteSubtreeOps(id, jotaiStore.get(graphSnapshotAtom))),
    [applyOps, jotaiStore],
  )
  // Undo needs to tell a block an edit created from one it linked in: only
  // the former is deleted when the edit is taken back.
  const knownBlock = useCallback(
    (id: string) => jotaiStore.get(graphSnapshotAtom).nodes.has(id),
    [jotaiStore],
  )

  // Images (docs/images.md): pasted pictures upload to the Worker — only where
  // the build has the feature on and the reader is signed in (the sample
  // corpus has nowhere to put bytes). Off, the editor never offers it.
  const isDatabaseMode = useAtomValue(isDatabaseModeAtom)
  const onImageUpload = imagesEnabled && isDatabaseMode && !readOnly ? uploadImage : undefined
  // Link blocks (docs/links.md): a link's preview is fetched through the
  // Worker, which takes a session — signed out, a link block is made without
  // one (the card shows the address's host) and offers no refresh.
  const onLinkPreview = isDatabaseMode && !readOnly ? fetchLinkPreview : undefined

  // Developer mode (`src/hooks/is-developer.ts`): the debug readouts, and the
  // corpus index behind the "upstream" metadata. Both are inert — no corpus
  // subscription, no extra chrome — unless the developer switched them on.
  const debugFlags = useDeveloperDebug()
  const upstreamIndex = useAtomValue(upstreamIndexAtom)
  const debug = useMemo<BlockDebugOptions | undefined>(() => {
    if (!debugFlags.blockIds && !debugFlags.blockMetadata) return undefined
    return {
      showIds: debugFlags.blockIds,
      showMetadata: debugFlags.blockMetadata,
      upstreamOf: upstreamIndex ? (id) => upstreamIndex.get(id) ?? [] : undefined,
    }
  }, [debugFlags, upstreamIndex])

  // Entering a zoom (mount-with-param or navigation) on a childless block adds
  // one empty child so there's something to edit under the title.
  const docRef = useRef(doc)
  docRef.current = doc
  useEffect(() => {
    if (readOnly || !zoomBlockId) return
    const current = docRef.current
    const ensured = ensureZoomChild(current, zoomBlockId)
    if (ensured === current) return
    setDoc(ensured)
    setLastDoc(ensured)
    onChange(ensured)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoomBlockId, readOnly])

  return (
    <BlockEditor
      doc={doc}
      onChange={handleChange}
      startEditing={startEditing}
      collapsed={collapsed as Set<string>}
      onToggleCollapse={toggleCollapse}
      onExitTop={onExitTop}
      focusFirstSignal={focusFirstSignal}
      focusFirstMode={focusFirstMode}
      newRootSignal={newRootSignal}
      refocusSignal={refocusSignal}
      readOnly={readOnly}
      browse={browse}
      zoomRootId={zoomBlockId}
      onZoomNavigate={onZoomNavigate}
      noteTitle={noteTitle}
      resolveBlocks={resolveBlocks}
      debug={debug}
      noteId={noteId}
      parentCountOf={noteId && rowRemoval === "unlink" ? parentCountOf : undefined}
      onDeleteEverywhere={noteId && rowRemoval === "unlink" ? deleteEverywhere : undefined}
      onDeleteSubtree={noteId && rowRemoval === "delete" ? deleteSubtree : undefined}
      knownBlock={noteId ? knownBlock : undefined}
      onImageUpload={onImageUpload}
      onLinkPreview={onLinkPreview}
      // The trailing blank is what keeps a block to type in; without it (the
      // basket) the last row may go, and the basket goes with it.
      emptyable={!trailingBlank}
    />
  )
}
