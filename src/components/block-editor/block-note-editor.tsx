import { useAtomValue, useSetAtom, useStore } from "jotai"
import { useCallback, useEffect, useRef, useState } from "react"
import { parse } from "../../blocks/parse"
import { serialize } from "../../blocks/serialize"
import { emptyBlock } from "../../blocks/ops"
import type { BlockDoc } from "../../blocks/types"
import { useCollapseState } from "../../data/view-state"
import { blockRevealAtom, markdownFilesAtom, noteOutlineAtom } from "../../global-state"
import { buildOutline } from "../../utils/note-outline"
import { resolveBlockSubtrees } from "../../utils/resolve-blocks"
import { BlockEditor } from "./block-editor"

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
  if (last && last.content === "" && last.children.length === 0) return doc
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
 * Adapts the block editor to the note page's string-based value model. The
 * note's markdown is parsed into blocks on mount; each edit serializes back to
 * markdown and calls `onChange`, so the surrounding page keeps its existing
 * save logic. Remount (via a `key`) to load a different note.
 *
 * External `value` changes (a git pull updating the open note, a frontmatter
 * edit from the actions menu) re-parse into blocks in place — see the
 * `lastValue` tracking below — so pulled content appears without a remount or
 * page refresh. Internal edits update `lastValue` first and are never
 * re-parsed, so live typing can't be clobbered.
 */
export function BlockNoteEditor({
  value,
  onChange,
  noteId,
  startEditing,
  highlightHeading,
  onExitTop,
  focusFirstSignal,
  focusFirstMode,
  newRootSignal,
  refocusSignal,
  readOnly = false,
  zoomBlockId = null,
  onZoomNavigate,
  noteTitle,
}: {
  value: string
  onChange: (value: string) => void
  /**
   * The note's id. When provided, the note's folds persist per-device in
   * localStorage (seeded on first open from the default-expansion policy);
   * without it, collapse is transient local state (e.g. Storybook /
   * standalone usage).
   */
  noteId?: string
  /** Start with the first block in edit mode (e.g. a brand-new note). */
  startEditing?: boolean
  /** Heading text to highlight/scroll to on landing (e.g. from Cmd-K). */
  highlightHeading?: string
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
  /** Block id the editor is zoomed into (`?block=` search param), or null. */
  zoomBlockId?: string | null
  /** Zoom navigation (crumbs, F/Shift+F, bullet clicks) — updates the URL. */
  onZoomNavigate?: (id: string | null) => void
  /** The note's title, shown as the breadcrumb's first crumb while zoomed. */
  noteTitle?: string
}) {
  // Read-only history views are shown verbatim; only editable notes get the
  // always-present trailing blank.
  const seedDoc = (markdown: string) => {
    const parsed = withStarterBlock(parse(markdown))
    return readOnly ? parsed : ensureTrailingBlank(parsed)
  }

  const [doc, setDoc] = useState<BlockDoc>(() => seedDoc(value))
  // The last markdown this editor produced (or was seeded from). When the
  // incoming `value` differs, the change came from *outside* the editor — a
  // git pull that updated the open note, or the page transforming the content
  // (frontmatter updates) — so re-parse it into blocks. Internal edits go
  // through `handleChange`, which updates `lastValue` before `onChange`
  // round-trips, so live typing is never re-parsed or lost.
  const [lastValue, setLastValue] = useState(value)
  if (value !== lastValue) {
    setLastValue(value)
    setDoc(seedDoc(value))
  }

  const { collapsed, toggleCollapse } = useCollapseState(noteId, doc)

  const handleChange = (next: BlockDoc) => {
    // While zoomed, the trailing-blank rule is suspended (a root-level blank
    // would be invisible below the zoomed subtree) — see `ensureZoomChild`.
    const withBlank = readOnly ? next : zoomBlockId ? next : ensureTrailingBlank(next)
    setDoc(withBlank)
    const serialized = serialize(withBlank)
    setLastValue(serialized)
    onChange(serialized)
  }

  // Publish the live outline (heading blocks) for the command palette's ⌘P
  // outline mode. The git-backed note content the palette could read on its
  // own goes stale while editing, and its column-0 heading regex misses
  // nested (indented) headings entirely — the live doc is the only correct
  // source. Read-only history views (which can mount several editors at once)
  // never publish.
  const setOutline = useSetAtom(noteOutlineAtom)
  useEffect(() => {
    if (readOnly || !noteId) return
    setOutline({ noteId, items: buildOutline(doc) })
  }, [doc, noteId, readOnly, setOutline])
  // Clear on unmount so a stale outline never outlives its note. (React runs
  // this cleanup before the next note's publish effect, so switching notes is
  // safe.)
  useEffect(() => {
    if (readOnly || !noteId) return
    return () => setOutline(null)
  }, [noteId, readOnly, setOutline])

  // The palette's preview/commit/cancel messages for the outline jump — the
  // editable editor is the only consumer (read-only views ignore them).
  const revealRequest = useAtomValue(blockRevealAtom)

  // "Paste as link": resolve pasted block ids to their live subtree markdown
  // from the note corpus. Read lazily through the jotai store (no
  // subscription — the corpus changes on every autosave of any note, and a
  // paste only needs the value at the moment it runs). The open note's own
  // file is excluded: its live truth is this editor's doc, and the file copy
  // can lag by the autosave debounce (a cut would resurrect pre-cut bytes).
  const jotaiStore = useStore()
  const resolveBlocks = useCallback(
    (ids: string[]) =>
      resolveBlockSubtrees(
        jotaiStore.get(markdownFilesAtom),
        ids,
        noteId !== undefined ? `${noteId}.md` : undefined,
      ),
    [jotaiStore, noteId],
  )

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
    const serialized = serialize(ensured)
    setLastValue(serialized)
    onChange(serialized)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoomBlockId, readOnly])

  return (
    <BlockEditor
      doc={doc}
      onChange={handleChange}
      startEditing={startEditing}
      highlightHeading={highlightHeading}
      collapsed={noteId ? collapsed : undefined}
      onToggleCollapse={noteId ? toggleCollapse : undefined}
      onExitTop={onExitTop}
      focusFirstSignal={focusFirstSignal}
      focusFirstMode={focusFirstMode}
      newRootSignal={newRootSignal}
      refocusSignal={refocusSignal}
      readOnly={readOnly}
      zoomRootId={zoomBlockId}
      onZoomNavigate={onZoomNavigate}
      noteTitle={noteTitle}
      revealRequest={readOnly ? null : revealRequest}
      resolveBlocks={resolveBlocks}
    />
  )
}
