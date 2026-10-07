import { useAtomValue, useSetAtom, useStore } from "jotai"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { emptyBlock } from "../../blocks/ops"
import type { BlockDoc, ChangeHint } from "../../blocks/types"
import { imagesEnabled, uploadImage } from "../../data/images"
import { fetchLinkPreview } from "../../data/link-previews"
import { isNoteType } from "../../data/graph"
import { deleteBlockOps, deleteSubtreeOps, parentCount } from "../../data/ops"
import { sharedOriginAtom } from "../../data/shared-mode"
import { useApplyOps } from "../../data/store"
import { useFoldRule } from "../../data/view-state"
import { collapsedKeysOf } from "../../blocks/default-collapsed"
import { titlesFocus } from "../../blocks/markers"
import { graphSnapshotAtom, isDatabaseModeAtom } from "../../global-state"
import { upstreamIndexAtom, useDeveloperDebug } from "../../hooks/is-developer"
import { resolveBlockSubtrees } from "../../utils/resolve-blocks"
import { deleteNoteDialogAtom } from "../delete-note-dialog"
import { linkBoardDialogAtom } from "../link-board-dialog"
import { newBoardDialogAtom } from "../new-board-dialog"
import { BlockEditor, type BlockDebugOptions, type BoardRequest } from "./block-editor"

/**
 * Ensure a parsed doc always has at least one block to edit. The starter is
 * the editor's alone until it is typed into: it is seeded into the editor's
 * doc, never written to the note. Not for a view that may legitimately be
 * empty — see `seedDoc`.
 *
 * There is no blank kept at the bottom beyond this. A note used to end in
 * an empty paragraph whatever it held, minted on every edit so there was
 * always a row to click into — and written to the note, so every note
 * carried an empty block it never asked for. Now the note ends where its
 * last block does, as a Notion page does, and the room beneath it is the
 * place to click: the page's foot (`_appRoot.views_.$.tsx`) asks the editor
 * for a block at the end (`appendRootSignal`), which edits the last block
 * if it is already an empty one and makes a new one otherwise.
 */
function withStarterBlock(doc: BlockDoc): BlockDoc {
  if (doc.rootBlockIds.length > 0) return doc
  const block = emptyBlock()
  return { ...doc, rootBlockIds: [block.id], blocks: { [block.id]: block } }
}

/**
 * The focused-view stand-in for the starter: while focused there is no root
 * to seed (a blank beside the focused block would be a root the note never
 * holds); instead we only make sure the focus root has at least one child to
 * edit when the focus *starts* (e.g. focusing on a leaf). Deleting the last
 * child later is allowed — the title alone is a valid view (Enter on it
 * creates a child).
 *
 * Only where the block is drawn as the view's title (`titlesFocus`): a block
 * that leads the view as its own first row is already something to edit, and
 * minting a blank child under it would put a block in the note for nothing
 * more than having looked at one.
 */
function ensureFocusChild(doc: BlockDoc, focusId: string): BlockDoc {
  const root = doc.blocks[focusId]
  if (!root || root.children.length > 0 || !titlesFocus(root.type)) return doc
  const block = emptyBlock()
  return {
    ...doc,
    blocks: { ...doc.blocks, [block.id]: block, [focusId]: { ...root, children: [block.id] } },
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
  appendRootSignal,
  refocusSignal,
  readOnly = false,
  browse = false,
  focusBlockId = null,
  onFocusNavigate,
  noteTitle,
  collapseKey,
  folds,
  onToggleCollapse,
  starter = true,
  rowRemoval = "unlink",
  context,
  onEditingChange,
  onOpenBoard,
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
  folds?: {
    collapsed: ReadonlySet<string>
    toggle: (key: string) => void
    /** Record a row as open in its own right (`reveal`), whatever the rule
     * would say — a row that is about to become a parent has nothing folded
     * to toggle. */
    setOpen: (key: string) => void
  }
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
  /** Bump to edit a block at the END of the note (a click in the room
   * beneath it): the last block if it is already an empty one, else a new
   * one after it. */
  appendRootSignal?: number
  refocusSignal?: number
  /** Display-only: render the note as read-only blocks (e.g. past-day history). */
  readOnly?: boolean
  /** Read-only, but still the reader's to move through, fold and focus — a
   * note someone shared with them (`BlockEditor.browse`). */
  browse?: boolean
  /** Block id the editor is focused on (`?block=` search param), or null. */
  focusBlockId?: string | null
  /** Focus navigation (crumbs, F/Shift+F, bullet clicks) — updates the URL. */
  onFocusNavigate?: (id: string | null) => void
  /** The note's title, shown as the breadcrumb's first crumb while focused. */
  noteTitle?: string
  /** Where this editor's folds are kept, when not under the note's own id —
   * a second editor on the page (the Unassigned basket) keeps its own. */
  collapseKey?: string
  /** Whether an editable doc always keeps a block to type into: an empty
   * one is seeded when it holds none, and the only root cannot be removed.
   * Off for the basket (a blank there would be a new unassigned block, and
   * removing the last block empties the basket) and for a narrowed view (a
   * blank row is one the filter would hide). */
  starter?: boolean
  /** What removing a row (⌫, Cut, the menu) does to the block. `"unlink"` —
   * the outline: the block stays, in the note's Unassigned basket if nothing
   * else holds it, and the menu offers Delete beside Unlink. `"delete"` —
   * the basket (`basketToOps`): the removal is the delete, so the menu
   * offers only that. */
  rowRemoval?: "unlink" | "delete"
  /** Rows the view keeps only as context — a filter's unmatched ancestors
   * (`src/data/filter-view.ts`), drawn dimmed. */
  context?: ReadonlySet<string>
  /** Told which block is being edited as it changes (`BlockEditor`). */
  onEditingChange?: (id: string | null) => void
  /** Open a board's page (a board card's "Open board", docs/boards.md).
   * The page's to give: navigation is its business. */
  onOpenBoard?: (id: string) => void
}) {
  // A view that may legitimately hold nothing gets no starter: a filter that
  // matched nothing, and the basket, would otherwise show one empty row that
  // reads as "this note is empty" when it is not, and that the filter would
  // hide again as soon as it was typed into. (While focused the doc's one
  // root is the focused block, so the starter never applies there either —
  // `ensureFocusChild` is the focus rule.)
  const seedDoc = (incoming: BlockDoc) => (starter ? withStarterBlock(incoming) : incoming)

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
  const revealRow = (key: string) => {
    if (folds) folds.setOpen(key)
    else own.setFold(key, true)
    onToggleCollapse?.(key)
  }

  const handleChange = (next: BlockDoc, hint?: ChangeHint) => {
    setDoc(next)
    setLastDoc(next)
    onChange(next, hint)
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
  // (read at open, off the live graph), and deleting blocks — the selected
  // ones, when the menu is opened on a selection — from all of them: a
  // batch of ops applied straight to the graph, which the page then
  // re-walks (not an editor edit, so not an undo step).
  const applyOps = useApplyOps()
  const parentCountOf = useCallback(
    (id: string) => parentCount(jotaiStore.get(graphSnapshotAtom), id),
    [jotaiStore],
  )
  // A board's row (docs/boards.md, "A board in a note") is the board's own
  // node, which `deleteBlockOps` leaves alone: its Delete is the board's
  // own — asked first, in the dialog the sidebar's Delete opens, then
  // `deleteNoteOps`, the board with everything only it held. Blocks in the
  // same selection go as they always have.
  const requestDeleteNote = useSetAtom(deleteNoteDialogAtom)
  const deleteEverywhere = useCallback(
    (ids: string[]) => {
      const snapshot = jotaiStore.get(graphSnapshotAtom)
      const notes = ids.filter((id) => isNoteType(snapshot.nodes.get(id)?.type ?? ""))
      const blocks = ids.filter((id) => !notes.includes(id))
      if (blocks.length > 0) applyOps(deleteBlockOps(blocks, snapshot))
      if (notes.length > 0) requestDeleteNote({ noteId: notes[0] })
    },
    [applyOps, jotaiStore, requestDeleteNote],
  )
  const deleteSubtree = useCallback(
    (ids: string[]) => applyOps(deleteSubtreeOps(ids, jotaiStore.get(graphSnapshotAtom))),
    [applyOps, jotaiStore],
  )
  // Undo needs to tell a block an edit created from one it linked in: only
  // the former is deleted when the edit is taken back.
  const knownBlock = useCallback(
    (id: string) => jotaiStore.get(graphSnapshotAtom).nodes.has(id),
    [jotaiStore],
  )

  // A board at a row (docs/boards.md, "A board in a note"): the slash
  // menu's Board and Link board open the app's dialogs, each told where the
  // board goes and how to put its row in the doc. Only in a note of the
  // reader's own: a note someone shared is theirs, and its slash menu
  // offers neither.
  const sharedOrigin = useAtomValue(sharedOriginAtom)
  const openNewBoard = useSetAtom(newBoardDialogAtom)
  const openLinkBoard = useSetAtom(linkBoardDialogAtom)
  const ownNote = noteId !== undefined && !readOnly && !sharedOrigin.has(noteId)
  const onRequestBoard = useCallback(
    ({ kind, ...into }: BoardRequest) => {
      if (noteId === undefined) return
      if (kind === "new") openNewBoard({ into })
      else openLinkBoard({ noteId, into })
    },
    [noteId, openNewBoard, openLinkBoard],
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

  // Entering a focus (mount-with-param or navigation) on a childless block adds
  // one empty child so there's something to edit under the title.
  const docRef = useRef(doc)
  docRef.current = doc
  useEffect(() => {
    if (readOnly || !focusBlockId) return
    const current = docRef.current
    const ensured = ensureFocusChild(current, focusBlockId)
    if (ensured === current) return
    setDoc(ensured)
    setLastDoc(ensured)
    onChange(ensured)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusBlockId, readOnly])

  return (
    <BlockEditor
      doc={doc}
      onChange={handleChange}
      startEditing={startEditing}
      collapsed={collapsed as Set<string>}
      onToggleCollapse={toggleCollapse}
      onReveal={revealRow}
      onExitTop={onExitTop}
      focusFirstSignal={focusFirstSignal}
      focusFirstMode={focusFirstMode}
      newRootSignal={newRootSignal}
      appendRootSignal={appendRootSignal}
      refocusSignal={refocusSignal}
      readOnly={readOnly}
      browse={browse}
      focusRootId={focusBlockId}
      onFocusNavigate={onFocusNavigate}
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
      onRequestBoard={ownNote ? onRequestBoard : undefined}
      onOpenBoard={onOpenBoard}
      // The starter is what keeps a block to type in; without it (the
      // basket) the last row may go, and the basket goes with it.
      emptyable={!starter}
      context={context}
      onEditingChange={onEditingChange}
    />
  )
}
