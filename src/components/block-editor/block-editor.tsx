import copy from "copy-to-clipboard"
import { useAtomValue } from "jotai"
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import type React from "react"
import type { ClipboardEvent, FocusEvent, KeyboardEvent, MouseEvent } from "react"
import { newBlockMarkerAtom } from "../../global-state"
import type { Block, BlockDoc } from "../../blocks/types"
import { blockId } from "../../blocks/id"
import { blockLine } from "../../blocks/serialize"
import {
  downloadImage,
  imageFilesOf,
  ImageUploadError,
  type UploadedImage,
} from "../../data/images"
import { ImageLightbox } from "./image-lightbox"
import {
  isHeading,
  leadingMarker,
  toggleType,
  TURN_INTO_KEYS,
  typeOfMarker,
} from "../../blocks/markers"
import {
  runCommand,
  type CaretInput,
  type CommandInput,
  type CommandName,
  type CommandResult,
  type FocusIntent,
  type Mode,
} from "../../blocks/commands"
import { resolveKey, type KeyLike } from "../../blocks/keymap"
import { parse } from "../../blocks/parse"
import {
  ancestorKeys,
  buildRows,
  firstOccurrenceKey,
  hasOccurrence,
  idOfKey,
  isWithin,
  keyOf,
  occurrenceKeys,
  parentKeyOf,
  zoomRootKey,
} from "../../blocks/view"
import {
  duplicateBlocks,
  emptyBlock,
  indentBlock,
  insertBlocksAsFirstChildren,
  insertAfter,
  insertFirstChild,
  moveBlocks,
  outdentBlock,
  remintCollidingIds,
  removeBlock,
  spliceBlocks,
  updateBlock,
  updateType,
} from "../../blocks/ops"
import { htmlToMarkdown } from "../../utils/html-to-markdown"
import type { BlockRevealRequest } from "../../utils/note-outline"
import {
  clipboardBlocksToDoc,
  clipboardBlocksToDocWithIds,
  extractClipboardBlocks,
  richClipboardFormats,
  writeRichClipboard,
  type ClipboardBlock,
} from "../../utils/rich-clipboard"
import { BlockContextMenu, type BlockMenuActions, type BlockMenuTarget } from "./block-context-menu"
import {
  BlockItem,
  type BlockDebugOptions,
  type BlockEditorApi,
  type FocusRequest,
} from "./block-item"
export type { BlockDebugOptions } from "./block-item"
import { useBlockHistory } from "./use-block-history"

/** The row (occurrence key) of the first heading block whose text matches
 * `heading`, in document order, or null. Used to highlight a heading arrived
 * at from the command menu. */
function findHeadingKey(doc: BlockDoc, heading: string): string | null {
  const target = heading.trim()
  for (const key of occurrenceKeys(doc)) {
    const block = doc.blocks[idOfKey(key)]
    if (block && isHeading(block.type) && block.text.trim() === target) return key
  }
  return null
}

/** What a reveal `cancel` puts back: the selected row and every scroll
 * position captured when the outline palette's first preview moved the view. */
type RevealSnapshot = {
  selected: string | null
  scrolls: { el: Element; top: number; left: number }[]
  windowX: number
  windowY: number
}

/** The first row (in document order) of a block present in `restored` but
 * not in `current` — the block an undo brought back, e.g. after a delete. */
function findReappeared(current: BlockDoc, restored: BlockDoc): string | null {
  return occurrenceKeys(restored).find((key) => !(idOfKey(key) in current.blocks)) ?? null
}

/**
 * Build the insertion fragment for a Ruminate-payload paste — "paste as link"
 * (docs/graph-storage.md): within the app, paste means "put this block here",
 * so ids the corpus knows are LINKED (the same node then lives in both
 * places), not duplicated. Per copied root, in order:
 *
 * - **Twin**: its id is already a direct child of the insertion parent — skip
 *   it (no duplicate, no error; it's already there). The DB's
 *   `(source, destination, kind)` primary key backstops this.
 * - **Same-doc**: any of its payload ids exists elsewhere in this doc —
 *   duplicate with fresh ids, exactly the pre-link behavior. Same-note
 *   mirroring is deliberately out of scope until the `((blk_x))` occurrence
 *   form: the markdown bridge re-mints a duplicate `id::` and would fork it.
 * - **Link**: ids unknown here — insert the node itself, original ids
 *   preserved, using its LIVE content from the corpus (`resolveBlocks`), never
 *   the clipboard bytes (a stale clipboard must not clobber the live node on
 *   save). A node that no longer exists anywhere (deleted since copy — the cut
 *   side of cut+paste) falls back to the clipboard content, still under its
 *   original ids, which is what makes cut+paste a true move. If the live
 *   subtree contains the paste target or any of its ancestors, linking would
 *   close a cycle — that block falls back to duplicating (the store's
 *   save-time cycle-drop remains the backstop); any other id the live subtree
 *   shares with this doc is reminted so the doc never holds one id twice.
 *
 * Returns null when every root was a twin (nothing to insert).
 */
function embeddedPasteFragment(
  embedded: ClipboardBlock[],
  doc: BlockDoc,
  /** The row pasted onto: the fragment lands as its block's first children. */
  targetKey: string,
  resolveBlocks?: (ids: string[]) => Record<string, string | null>,
): BlockDoc | null {
  const target = idOfKey(targetKey)
  // Direct children of the insertion parent (the twin check's scope).
  const parentChildren = doc.blocks[target]?.children ?? []
  // The row's own path: linking any of these beneath it would close a cycle.
  const forbidden = new Set([target, ...ancestorKeys(targetKey).map(idOfKey)])

  const payloadIds = (block: ClipboardBlock): string[] => {
    const ids: string[] = []
    const walk = (b: ClipboardBlock) => {
      if (b.id !== undefined) ids.push(b.id)
      b.children.forEach(walk)
    }
    walk(block)
    return ids
  }

  const roots = embedded.filter(
    (block) => !(block.id !== undefined && parentChildren.includes(block.id)),
  )
  if (roots.length === 0) return null

  const linkable = (block: ClipboardBlock) =>
    block.id !== undefined && !payloadIds(block).some((id) => id in doc.blocks)
  const linkableIds = roots.filter(linkable).map((block) => block.id as string)
  const resolved =
    resolveBlocks && linkableIds.length > 0 ? resolveBlocks(linkableIds) : ({} as const)

  let out: BlockDoc = { props: null, rootBlockIds: [], blocks: {} }
  for (const block of roots) {
    let sub: BlockDoc
    if (!linkable(block)) {
      sub = clipboardBlocksToDoc([block])
    } else {
      const live = (resolved as Record<string, string | null>)[block.id as string] ?? null
      sub = live !== null ? parse(live) : clipboardBlocksToDocWithIds([block])
      if (Object.keys(sub.blocks).some((id) => forbidden.has(id))) {
        // Cycle fallback: every id of `sub` collides with itself, so this is
        // a full remint — a plain duplicate of the live fragment's content.
        sub = remintCollidingIds(sub, sub)
      }
      sub = remintCollidingIds(sub, doc)
    }
    // A descendant shared across two pasted roots (multi-parent in the live
    // graph) would put one id in this doc twice; remint the later occurrence.
    sub = remintCollidingIds(sub, out)
    out = {
      props: null,
      rootBlockIds: [...out.rootBlockIds, ...sub.rootBlockIds],
      blocks: { ...out.blocks, ...sub.blocks },
    }
  }
  return out
}

/**
 * A controlled block outliner. `doc` is owned by the caller (which serializes
 * and saves it); this component manages only transient UI state and emits new
 * docs via `onChange`.
 *
 * There are two modes, like Notion:
 * - **select** — a block is highlighted; arrow keys move the highlight and
 *   Enter (or a double-click) starts editing it. This is the default.
 * - **edit** — a textarea is focused inside the block; Escape returns to
 *   select, and arrows at the first/last line move to the adjacent block.
 *
 * Each block's content is raw markdown, rendered per-block and edited in place.
 */
export function BlockEditor({
  doc,
  onChange,
  startEditing = false,
  highlightHeading,
  collapsed: collapsedProp,
  onToggleCollapse,
  onExitTop,
  focusFirstSignal,
  focusFirstMode = "select",
  newRootSignal,
  refocusSignal,
  readOnly = false,
  zoomRootId: zoomRootIdProp = null,
  onZoomNavigate,
  noteTitle,
  revealRequest = null,
  resolveBlocks,
  debug,
  noteId,
  parentCountOf,
  onDeleteEverywhere,
  onImageUpload,
}: {
  doc: BlockDoc
  onChange: (doc: BlockDoc) => void
  /**
   * Upload a pasted/dropped picture and return what the image block should
   * hold (`src/data/images.ts`). Absent = images are switched off here: an
   * image paste or drop is left to the browser and the slash menu offers no
   * "Image".
   */
  onImageUpload?: (file: File) => Promise<UploadedImage>
  /** The note this doc is the page of — what "Copy link to block" links into. */
  noteId?: string
  /** How many places a block appears across the corpus (the context menu's
   * "Delete" / "Remove from here" wording). Absent = only here. */
  parentCountOf?: (id: string) => number
  /** Delete a block from every place it appears (the graph-level delete);
   * absent standalone, where the menu offers only the row's removal. */
  onDeleteEverywhere?: (id: string) => void
  /** Start with the first block in edit mode (e.g. a brand-new note). */
  startEditing?: boolean
  /** Highlight the block for this heading text on mount / when it changes. */
  highlightHeading?: string
  /**
   * Folded occurrence keys (`src/blocks/view.ts`). Optional: when provided
   * (with `onToggleCollapse`), collapse is controlled and persisted by the
   * caller; otherwise it falls back to transient local state (e.g. Storybook /
   * standalone usage).
   */
  collapsed?: Set<string>
  onToggleCollapse?: (key: string) => void
  /** Called when the user navigates up past the first block — lets the caller
   * move focus to whatever sits above the editor (e.g. the note title). */
  onExitTop?: () => void
  /** Bump this (e.g. Down-arrow from the note title) to focus the first block. */
  focusFirstSignal?: number
  /** Whether `focusFirstSignal` opens the first block editing or just highlighted. */
  focusFirstMode?: "edit" | "select"
  /** Bump this (e.g. Cmd+Enter on the note title) to add a new root block. */
  newRootSignal?: number
  /** Bump this (the global `i` shortcut) to refocus the editor, restoring the
   * last selected block (or the first). */
  refocusSignal?: number
  /** Display-only: renders blocks without any editing (e.g. past-day history). */
  readOnly?: boolean
  /**
   * Zoom ("focus mode"): the block whose subtree is the whole view. With
   * `onZoomNavigate` the zoom is controlled by the caller (URL search param);
   * without it, this is just the initial value of transient local zoom state
   * (Storybook / tests).
   */
  zoomRootId?: string | null
  /** Called to change the zoom level (`null` exits). Makes zoom controlled. */
  onZoomNavigate?: (id: string | null) => void
  /** The note's title — the breadcrumb's first crumb while zoomed. */
  noteTitle?: string
  /**
   * Driven by the command palette's outline mode (⌘P): preview highlights +
   * scrolls a block live behind the dialog, commit keeps the selection there,
   * cancel restores what the first preview captured. Messages are consumed by
   * nonce, so a request left over from a previous mount is ignored.
   */
  revealRequest?: BlockRevealRequest | null
  /**
   * Live subtree markdown per block id from the note corpus — the "paste as
   * link" lookup (see `embeddedPasteFragment`). Optional: without it
   * (Storybook, standalone usage) unknown-id pastes fall back to the
   * clipboard-embedded content, ids intact.
   */
  resolveBlocks?: (ids: string[]) => Record<string, string | null>
  /**
   * Developer-mode debug readouts (block ids beside rows, metadata beneath
   * them — `src/hooks/is-developer.ts`). Absent in ordinary use.
   */
  debug?: BlockDebugOptions
}) {
  // ── Zoom state ────────────────────────────────────────────────────────────
  // Controlled by the caller (URL) when `onZoomNavigate` is given; otherwise
  // transient local state so the editor works standalone.
  const [zoomInternal, setZoomInternal] = useState<string | null>(zoomRootIdProp)
  const zoomRootId = onZoomNavigate ? zoomRootIdProp : zoomInternal

  // The zoom NAVIGATION stack: the ids zoomed into, in the order the user took
  // — the breadcrumb and Shift+F follow this path, not the tree ancestry
  // (under the graph model a block can live in several places, so "the path
  // you took" is the only honest trail). Reconciled from zoomRootId so every
  // way of changing zoom (keyboard, bullet click, crumb click, browser back,
  // deep link) keeps it consistent: navigating to an id already on the stack
  // truncates back to it; anything else is a new hop and pushes.
  const [zoomStack, setZoomStack] = useState<string[]>(() => (zoomRootId ? [zoomRootId] : []))
  useEffect(() => {
    setZoomStack((stack) => {
      if (!zoomRootId) return stack.length === 0 ? stack : []
      const at = stack.indexOf(zoomRootId)
      if (at === stack.length - 1 && at !== -1) return stack
      if (at !== -1) return stack.slice(0, at + 1)
      return [...stack, zoomRootId]
    })
  }, [zoomRootId])
  // Where Shift+F returns to: one step back along the path (null exits zoom).
  const zoomBackId = zoomStack.length > 1 ? zoomStack[zoomStack.length - 2] : null
  // What Enter puts in a fresh block — a user preference (Settings → Editor).
  const newBlockMarker = useAtomValue(newBlockMarkerAtom)

  const navigateZoom = (id: string | null) => {
    if (onZoomNavigate) onZoomNavigate(id)
    else setZoomInternal(id)
  }
  const zoomRoot = zoomRootId ? (doc.blocks[zoomRootId] ?? null) : null
  // The zoomed block's row: its first occurrence in the document.
  const zoomKey = useMemo(() => (zoomRoot ? zoomRootKey(doc, zoomRoot.id) : null), [doc, zoomRoot])

  // Everything positional — the selection, its anchor, edit focus — is a row:
  // an occurrence key (`src/blocks/view.ts`), so a block that appears twice
  // in the note is two places to be. The block itself is by id.

  // The first selectable row: while zoomed, the zoom root's first child (the
  // title itself is deliberately not the landing spot — avoids accidental edits).
  const firstKey =
    zoomRoot && zoomKey
      ? zoomRoot.children[0]
        ? keyOf(zoomKey, zoomRoot.children[0])
        : zoomKey
      : (doc.rootBlockIds[0] ?? null)
  const [focus, setFocus] = useState<FocusRequest | null>(() =>
    startEditing && firstKey ? { key: firstKey } : null,
  )
  const [selected, setSelected] = useState<string | null>(() =>
    highlightHeading ? (findHeadingKey(doc, highlightHeading) ?? firstKey) : firstKey,
  )
  const [collapsedInternal, setCollapsedInternal] = useState<Set<string>>(new Set())
  const collapsed = collapsedProp ?? collapsedInternal
  // The other end of a multi-row selection (Shift+Arrow). null = single select.
  const [anchorKey, setAnchorKey] = useState<string | null>(null)
  const history = useBlockHistory(onChange)

  // The view: the rows on screen, in order, indented by depth, folds applied
  // (`buildRows`). Zoomed, the zoomed block leads as the view's editable
  // title (so arrow-up from the first child selects it) and its children
  // always render — the root's own fold is ignored while zoomed.
  const rows = useMemo(
    () => buildRows(doc, { zoomRootId: zoomRoot ? zoomRoot.id : null, folds: collapsed }),
    [doc, collapsed, zoomRoot],
  )
  // The rows' keys in the order they appear on screen — what up/down
  // navigation and a Shift+Arrow range walk.
  const visibleOrder = useMemo(() => rows.map((row) => row.key), [rows])
  // The row a block id is addressed by when something outside names a block
  // (the outline palette, `?heading=`): its first row in the view, else its
  // first occurrence in the document (a block hidden under a fold).
  const keyOfId = (id: string, inDoc: BlockDoc = doc): string => {
    for (const row of rows) if (row.id === id) return row.key
    return firstOccurrenceKey(inDoc, id) ?? id
  }

  // The container is the focusable keyboard target for select mode.
  const containerRef = useRef<HTMLDivElement>(null)

  // ── Keyboard ownership ────────────────────────────────────────────────────
  // Whether the editor owns the keyboard: focus (container or a textarea) is
  // inside the container. While it doesn't — focus moved to the sidebar, a
  // dialog, the ⌘P palette mid-preview — the selection highlight demotes to a
  // quiet neutral (`.block-highlight-inactive`), Finder-style, so "arrows work
  // here" is never claimed falsely. Tracked via the container's focus/blur
  // (they bubble, i.e. focusin/focusout); the blur side settles on a rAF so
  // internal focus moves (container ↔ textarea, the blur-regrab below) never
  // flicker — both the check and any re-grab run before the next paint.
  const [keyboardActive, setKeyboardActive] = useState(false)
  const keyboardIdleRaf = useRef<number | null>(null)
  const cancelKeyboardIdleCheck = () => {
    if (keyboardIdleRaf.current !== null) {
      cancelAnimationFrame(keyboardIdleRaf.current)
      keyboardIdleRaf.current = null
    }
  }
  const handleContainerFocus = () => {
    cancelKeyboardIdleCheck()
    setKeyboardActive(true)
  }
  const scheduleKeyboardIdleCheck = () => {
    cancelKeyboardIdleCheck()
    keyboardIdleRaf.current = requestAnimationFrame(() => {
      keyboardIdleRaf.current = null
      const el = containerRef.current
      if (!el || !el.contains(document.activeElement)) setKeyboardActive(false)
    })
  }
  useEffect(() => cancelKeyboardIdleCheck, [])
  // Set by a Cmd/Ctrl+Shift+V keydown so the paste event that follows knows to
  // paste as plain text (newlines collapsed into one block).
  const plainPasteRef = useRef(false)
  const focusContainer = () => {
    if (!readOnly) containerRef.current?.focus({ preventScroll: true })
  }

  // Re-highlight when the target heading changes (Cmd-K into the open note).
  // Reads the latest doc via a ref so this only runs on heading changes.
  const docRef = useRef(doc)
  docRef.current = doc

  // Graceful zoom exit: if the zoomed block no longer exists (deleted, undo, a
  // stale/bad link), fall back to the un-zoomed view AND clean the URL param —
  // obsidian-zoom's "reset when boundaries violated" principle.
  useEffect(() => {
    if (zoomRootId && !doc.blocks[zoomRootId]) navigateZoom(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoomRootId, doc])

  // Place the selection when the zoom level changes: zooming IN lands on the
  // first child (not the title, avoiding accidental edits of the root);
  // zooming OUT lands on the block you zoomed out FROM (it's visible in the
  // wider view). Covers F/Shift+F, crumb clicks, and the browser back button.
  const prevZoomRef = useRef(zoomRootId)
  useEffect(() => {
    const prev = prevZoomRef.current
    if (prev === zoomRootId) return
    prevZoomRef.current = zoomRootId
    if (readOnly) return
    const current = docRef.current
    setAnchorKey(null)
    setFocus(null)
    if (zoomRootId) {
      const root = current.blocks[zoomRootId]
      if (!root) return // the graceful-exit effect above cleans this up
      const rootKey = zoomRootKey(current, zoomRootId)
      // Zoomed out to an ancestor: the block we came from has a row inside
      // the new view — land there.
      const back =
        prev === null
          ? undefined
          : occurrenceKeys(current).find((key) => isWithin(key, rootKey) && idOfKey(key) === prev)
      if (back) setSelected(back)
      else setSelected(root.children[0] ? keyOf(rootKey, root.children[0]) : rootKey)
    } else if (prev !== null) {
      const back = firstOccurrenceKey(current, prev)
      if (back) setSelected(back)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoomRootId, readOnly])

  useEffect(() => {
    if (!highlightHeading) return
    const key = findHeadingKey(docRef.current, highlightHeading)
    if (key) {
      setFocus(null)
      setSelected(key)
    }
  }, [highlightHeading])

  // ── Reveal requests (⌘P outline palette) ──────────────────────────────────
  // The palette drives the editor through small {type, id, nonce} messages —
  // see `BlockRevealRequest`. All capture/restore state lives here so the
  // palette never has to know the editor's selection or scroll internals.
  const selectedRef = useRef(selected)
  selectedRef.current = selected
  // Survives deselection (Escape, focus loss): the row `refocusSignal`
  // returns the user to.
  const lastSelectedRef = useRef(selected)
  if (selected) lastSelectedRef.current = selected
  // Non-null exactly while a preview sequence is underway. Doubles as the
  // "palette is driving" flag: the focus-grab effect below must not steal
  // focus from the palette's input as previews move the selection.
  const revealSnapshotRef = useRef<RevealSnapshot | null>(null)
  // Consume messages by nonce so a request left over in the atom from a
  // previous mount (or a re-render) never re-fires.
  const lastRevealNonceRef = useRef(revealRequest?.nonce ?? 0)

  // Center a row's content line, same target the select-mode auto-scroll
  // uses. Called directly so a repeat jump to the already-selected row still
  // scrolls (state effects wouldn't re-run — the old `?heading=` param bug).
  const scrollBlockLineIntoView = (key: string) => {
    const row = containerRef.current?.querySelector<HTMLElement>(`[data-occurrence="${key}"]`)
    const line = row?.querySelector<HTMLElement>("[data-block-line]") ?? row
    if (line && typeof line.scrollIntoView === "function") line.scrollIntoView({ block: "center" })
  }

  const captureRevealSnapshot = (): RevealSnapshot => {
    // Record every scrollable ancestor of the editor (plus the window), so the
    // restore is exact no matter which container scrollIntoView actually moved.
    const scrolls: RevealSnapshot["scrolls"] = []
    let node: HTMLElement | null = containerRef.current
    while (node) {
      if (node.scrollHeight > node.clientHeight || node.scrollWidth > node.clientWidth) {
        scrolls.push({ el: node, top: node.scrollTop, left: node.scrollLeft })
      }
      node = node.parentElement
    }
    return {
      selected: selectedRef.current,
      scrolls,
      windowX: window.scrollX,
      windowY: window.scrollY,
    }
  }

  useEffect(() => {
    const request = revealRequest
    if (!request || request.nonce === lastRevealNonceRef.current) return
    lastRevealNonceRef.current = request.nonce
    if (readOnly) return
    const current = docRef.current
    // The palette names a block; the editor lands on its row (the first on
    // screen, or the first the document has).
    if (request.type === "preview") {
      if (!current.blocks[request.id]) return
      const key = keyOfId(request.id, current)
      // The first preview of a sequence captures what cancel must restore.
      if (!revealSnapshotRef.current) revealSnapshotRef.current = captureRevealSnapshot()
      setAnchorKey(null)
      setFocus(null)
      setSelected(key)
      scrollBlockLineIntoView(key)
      return
    }
    const snapshot = revealSnapshotRef.current
    revealSnapshotRef.current = null
    if (request.type === "commit") {
      if (current.blocks[request.id]) {
        const key = keyOfId(request.id, current)
        setAnchorKey(null)
        setFocus(null)
        setSelected(key)
        scrollBlockLineIntoView(key)
      }
      // After the dialog unmounts (and its own focus juggling settles), make
      // the container the keyboard target so arrows work from the landing spot.
      setTimeout(() => focusContainer())
      return
    }
    // cancel — put back exactly what the first preview captured.
    if (!snapshot) return
    setAnchorKey(null)
    setFocus(null)
    setSelected(
      snapshot.selected === null
        ? null
        : hasOccurrence(current, snapshot.selected)
          ? snapshot.selected
          : firstSelectable(current),
    )
    // The palette's close handler refocuses its previously-active element in a
    // timeout queued before this one, so the scroll we restore here is the one
    // that sticks.
    setTimeout(() => {
      for (const { el, top, left } of snapshot.scrolls) {
        el.scrollTop = top
        el.scrollLeft = left
      }
      window.scrollTo(snapshot.windowX, snapshot.windowY)
      focusContainer()
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealRequest, readOnly])

  // The selected rows. Single select is just `[selected]`; a Shift+Arrow
  // range is the contiguous span of `visibleOrder` between anchor and head.
  const selectedKeys: string[] = useMemo(() => {
    if (!selected) return []
    if (!anchorKey || anchorKey === selected) return [selected]
    const a = visibleOrder.indexOf(anchorKey)
    const b = visibleOrder.indexOf(selected)
    if (a === -1 || b === -1) return [selected]
    const [lo, hi] = a < b ? [a, b] : [b, a]
    return visibleOrder.slice(lo, hi + 1)
  }, [selected, anchorKey, visibleOrder])
  const selectedSet = useMemo(() => new Set(selectedKeys), [selectedKeys])

  // Where two selected rows' highlight surfaces touch on screen, the sides
  // between them get the FULL 4px vertical extension and straight corners so
  // the run reads as ONE continuous surface, rounded only at its ends (every
  // other side extends just 2px — to the midpoint of the nested 4px inter-row
  // gap — so differently-painted neighbours, e.g. a hover beside a selection,
  // never overlap; see the runEdges pairs in block-item.tsx). With 4px per
  // touching side, consecutive selected rows always meet (nested 4px gaps
  // overlap 4px, root 6px gaps overlap 2px) — except across a heading's top
  // margin (or the zoom title's bottom margin), which keeps a visible gap;
  // those boundaries stay rounded.
  const selectionRunEdges = useMemo(() => {
    const edges = new Map<string, { top: boolean; bottom: boolean }>()
    if (selectedSet.size < 2) return edges
    const headingAt = (key: string) => isHeading(doc.blocks[idOfKey(key)]?.type ?? "text")
    for (let i = 0; i < visibleOrder.length; i++) {
      const key = visibleOrder[i]
      if (!selectedSet.has(key)) continue
      const prev = i > 0 ? visibleOrder[i - 1] : null
      const next = i + 1 < visibleOrder.length ? visibleOrder[i + 1] : null
      const top = prev !== null && selectedSet.has(prev) && !headingAt(key) && prev !== zoomKey
      const bottom = next !== null && selectedSet.has(next) && !headingAt(next) && key !== zoomKey
      if (top || bottom) edges.set(key, { top, bottom })
    }
    return edges
  }, [selectedSet, visibleOrder, doc, zoomKey])

  const select = (key: string) => {
    setFocus(null)
    setAnchorKey(null)
    setSelected(key)
    // Grab keyboard focus so arrows work immediately, even re-clicking the block
    // that's already highlighted (which wouldn't trigger the focus effect).
    focusContainer()
  }

  // Extend the multi-selection by moving the head one row along, keeping the
  // anchor fixed (starting a range from the current head if there isn't one).
  const extendSelection = (direction: "up" | "down") => {
    if (!selected) return
    const i = visibleOrder.indexOf(selected)
    if (i === -1) return
    const next = direction === "up" ? i - 1 : i + 1
    if (next < 0 || next >= visibleOrder.length) return
    if (!anchorKey) setAnchorKey(selected)
    setFocus(null)
    setSelected(visibleOrder[next])
  }

  // ── Selection ladder (Cmd/Ctrl+A escalation) ──────────────────────────────
  // Repeated Cmd/Ctrl+A grows the selection through structural units — block →
  // its visible subtree → the parent's subtree → each ancestor → the whole
  // page — and Cmd/Ctrl+Shift+A steps back down. The escalation itself is
  // stateless (derived from the current selection each press); only the shrink
  // history lives in a ref, cleared whenever the selection changes by any
  // other means (arrows, click, Escape, structural edits). No timers.
  const ladderRef = useRef<{ selected: string; anchorKey: string | null }[]>([])
  // Set just before a ladder move's own setState so the clear effect below can
  // tell ladder-driven selection changes from everything else.
  const ladderMove = useRef(false)
  // Set by ladder moves so the centre-scroll effect can skip its jump when the
  // selection head is already fully on screen.
  const skipCenterScroll = useRef(false)
  useEffect(() => {
    if (ladderMove.current) {
      ladderMove.current = false
      return
    }
    ladderRef.current = []
  }, [selected, anchorKey, doc])

  // The contiguous run of `visibleOrder` covered by a row's subtree: the row
  // plus its visible descendants (just the row for a leaf or collapsed one).
  // Descendant rows are exactly the keys beneath it.
  const visibleSubtree = (key: string): string[] => {
    const start = visibleOrder.indexOf(key)
    if (start === -1) return []
    let end = start + 1
    while (end < visibleOrder.length && isWithin(visibleOrder[end], key)) end++
    return visibleOrder.slice(start, end)
  }

  // One rung up: grow `keys` (a contiguous run of `visibleOrder`) to the
  // visible subtree of the deepest row strictly containing it — the head row
  // itself when the selection is a strict subset of its own subtree, otherwise
  // the nearest ancestor whose subtree covers it — falling back to the whole
  // page (e.g. a selection spanning multiple roots). `snapshot` is the
  // selection to restore when Cmd/Ctrl+Shift+A steps back down.
  const escalateFrom = (
    keys: string[],
    snapshot: { selected: string; anchorKey: string | null },
  ) => {
    if (keys.length === 0 || visibleOrder.length === 0) return
    const first = keys[0]
    const last = keys[keys.length - 1]
    // `sub` when it strictly contains the selection (both endpoints of a
    // contiguous range inside another contiguous range ⇒ the whole range is).
    const strictSuperset = (rootKey: string): string[] | null => {
      const sub = visibleSubtree(rootKey)
      if (sub.length <= keys.length) return null
      return sub.includes(first) && sub.includes(last) ? sub : null
    }
    let target = strictSuperset(first)
    if (!target) {
      for (const ancestor of ancestorKeys(first)) {
        target = strictSuperset(ancestor)
        if (target) break
      }
    }
    const range = target ?? visibleOrder
    if (range.length <= keys.length) return // already the whole page
    ladderRef.current.push(snapshot)
    ladderMove.current = true
    skipCenterScroll.current = true
    setFocus(null)
    setSelected(range[0])
    setAnchorKey(range[range.length - 1])
  }
  const escalateSelection = () => {
    if (!selected) return
    escalateFrom(selectedKeys, { selected, anchorKey })
  }
  const shrinkSelection = () => {
    const prev = ladderRef.current.pop()
    if (!prev || !hasOccurrence(doc, prev.selected)) return
    ladderMove.current = true
    skipCenterScroll.current = true
    setFocus(null)
    setSelected(prev.selected)
    setAnchorKey(prev.anchorKey && hasOccurrence(doc, prev.anchorKey) ? prev.anchorKey : null)
  }

  // The top-level rows of the selection (those with no selected ancestor), in
  // document order — the roots to act on so a subtree is moved/copied once.
  const selectionRoots = (): string[] => {
    const set = selectedSet
    return selectedKeys.filter((key) => !ancestorKeys(key).some((ancestor) => set.has(ancestor)))
  }

  // Selection roots for *structural* ops. The zoomed title can be part of a
  // selection (e.g. the Cmd+A "page" rung) but must never be moved, indented,
  // outdented, or deleted from inside its own view.
  const structuralRoots = () => selectionRoots().filter((key) => key !== zoomKey)

  // The first selectable row of a given doc, honouring the current zoom.
  const firstSelectable = (d: BlockDoc): string | null => {
    if (zoomRootId && d.blocks[zoomRootId]) {
      const rootKey = zoomRootKey(d, zoomRootId)
      const child = d.blocks[zoomRootId].children[0]
      return child ? keyOf(rootKey, child) : rootKey
    }
    return d.rootBlockIds[0] ?? null
  }

  // A structural move gives the moved rows new keys (a row's key is its
  // path). Carry the selection across: the head and anchor follow whichever
  // moved root they sit under.
  const followMoved = (moved: [from: string, to: string][]) => {
    const follow = (key: string | null) => {
      if (key === null) return key
      const hit = moved.find(([from]) => isWithin(key, from))
      return hit ? hit[1] + key.slice(hit[0].length) : key
    }
    setSelected(follow)
    setAnchorKey(follow)
  }
  const indentSelection = () => {
    let next = doc
    const moved: [string, string][] = []
    // In document order: each row's new previous sibling is the one the group
    // is nesting under, so a contiguous sibling range nests together.
    for (const key of structuralRoots()) {
      const result = indentBlock(next, key)
      if (result.doc !== next) moved.push([key, result.key])
      next = result.doc
    }
    if (next === doc) return
    history.commit(doc, next, { type: "structural" })
    followMoved(moved)
  }
  const outdentSelection = () => {
    let next = doc
    const moved: [string, string][] = []
    // Reverse order keeps siblings in place as each is lifted out. At the zoom
    // boundary, outdenting a direct child would eject it from the view — skip.
    for (const key of [...structuralRoots()].reverse()) {
      if (zoomKey !== null && parentKeyOf(key) === zoomKey) continue
      const result = outdentBlock(next, key)
      if (result.doc !== next) moved.push([key, result.key])
      next = result.doc
    }
    if (next === doc) return
    history.commit(doc, next, { type: "structural" })
    followMoved(moved)
  }
  const removeSelection = () => {
    let next = doc
    for (const key of structuralRoots()) {
      if (!hasOccurrence(next, key)) continue
      next = removeBlock(next, key).doc
    }
    if (next === doc) return
    // Select the row that visually takes the removed range's place: the first
    // surviving row below the range, falling back to the first above
    // (mirroring the single-row deleteBlock command).
    const indices = selectedKeys
      .map((key) => visibleOrder.indexOf(key))
      .filter((index) => index !== -1)
    const lo = indices.length > 0 ? Math.min(...indices) : 0
    const hi = indices.length > 0 ? Math.max(...indices) : -1
    let focusKey: string | null = null
    for (let i = hi + 1; i < visibleOrder.length && !focusKey; i++) {
      if (hasOccurrence(next, visibleOrder[i])) focusKey = visibleOrder[i]
    }
    for (let i = lo - 1; i >= 0 && !focusKey; i--) {
      if (hasOccurrence(next, visibleOrder[i])) focusKey = visibleOrder[i]
    }
    history.commit(doc, next, { type: "structural" })
    setAnchorKey(null)
    setFocus(null)
    // An emptied doc regains a blank block via the editor's trailing-blank rule.
    setSelected(focusKey ?? firstSelectable(next))
  }

  // Serialize the selected subtrees to block markdown (markers + nesting +
  // `id::` lines) so it round-trips through paste. The ids ride only in the
  // embedded clipboard payload — where they make paste-as-link (and cut+paste
  // as a true move) possible; both visible flavors drop them.
  const markdownOfRows = (keys: string[]): string => {
    const lines: string[] = []
    const walk = (id: string, depth: number) => {
      const block = doc.blocks[id]
      if (!block) return
      const indent = "  ".repeat(depth)
      // Markers are export-only: an ordered item is written `1.` here and
      // renumbered wherever it lands (the parse side reads runs by position).
      lines.push(indent + blockLine(block))
      lines.push(`${indent}  id:: ${block.id}`)
      for (const childId of block.children) walk(childId, depth + 1)
    }
    for (const key of keys) walk(idOfKey(key), 0)
    return lines.join("\n")
  }
  // Both flavors: clean display markdown as text/plain, plus text/html with
  // the exact block tree embedded so Ruminate→Ruminate paste round-trips.
  const copyRows = (keys: string[]) =>
    writeRichClipboard(richClipboardFormats(markdownOfRows(keys)))
  const copySelection = () => copyRows(selectionRoots())
  const cutSelection = () => {
    copySelection()
    removeSelection()
  }
  // When the caller bumps `focusFirstSignal` (e.g. Down-arrow from the note
  // title), highlight the first block — moving between the title and the blocks
  // moves the highlight, like moving between blocks.
  useEffect(() => {
    if (!focusFirstSignal || readOnly) return
    const first = firstSelectable(docRef.current)
    if (!first) return
    setAnchorKey(null)
    setSelected(first)
    // Mirror the title's own state: editing the title drops into the first block
    // editing (caret at its start); a highlighted title just highlights it.
    setFocus(focusFirstMode === "edit" ? { key: first, atStart: true } : null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusFirstSignal])

  // When the caller bumps `refocusSignal` (the global `i` shortcut), give the
  // editor keyboard focus back and restore the LAST selected row — "put me
  // back where I was" — falling back to the first selectable row.
  useEffect(() => {
    if (!refocusSignal || readOnly) return
    const last = lastSelectedRef.current
    const target =
      last && hasOccurrence(docRef.current, last) ? last : firstSelectable(docRef.current)
    if (!target) return
    setAnchorKey(null)
    setSelected(target)
    setFocus(null)
    containerRef.current?.focus({ preventScroll: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refocusSignal])

  // When the caller bumps `newRootSignal` (e.g. Cmd+Enter on the note title),
  // add a fresh root block at the top and edit it.
  useEffect(() => {
    if (!newRootSignal || readOnly) return
    const current = docRef.current
    const fresh = emptyBlock()
    // While zoomed, "a new root" means a new first child of the zoom root —
    // the zoomed subtree is the page.
    const zoomed = zoomRootId && current.blocks[zoomRootId] ? zoomRootId : null
    const next: BlockDoc = zoomed
      ? insertFirstChild(current, zoomed, fresh)
      : {
          ...current,
          rootBlockIds: [fresh.id, ...current.rootBlockIds],
          blocks: { ...current.blocks, [fresh.id]: fresh },
        }
    const key = zoomed ? keyOf(zoomRootKey(current, zoomed), fresh.id) : fresh.id
    history.commit(current, next, { type: "structural" })
    setAnchorKey(null)
    setSelected(key)
    setFocus({ key })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newRootSignal])

  const edit = (key: string, atStart = false) => {
    if (readOnly) return
    setAnchorKey(null)
    setSelected(key)
    setFocus({ key, atStart })
  }

  // After restoring a snapshot, keep editing/selecting the same row if it
  // still exists; otherwise fall back to select mode on a valid row.
  const reconcileToDoc = (restored: BlockDoc) => {
    setAnchorKey(null)
    // If a block reappeared (e.g. undo of a delete), highlight it so the thing
    // you brought back is where your focus lands.
    const reappeared = findReappeared(doc, restored)
    if (reappeared) {
      setFocus(null)
      setSelected(reappeared)
      return
    }
    // The selected row vanished (e.g. undoing its creation): land on its
    // nearest surviving neighbour in the CURRENT visible order — above first
    // (for an undone create that's the block Enter was pressed on), then below
    // — never jumping to the top of the file unless nothing survives.
    const nearestSurvivor = (vanished: string): string | null => {
      const at = visibleOrder.indexOf(vanished)
      if (at === -1) return null
      for (let i = at - 1; i >= 0; i--) {
        if (hasOccurrence(restored, visibleOrder[i])) return visibleOrder[i]
      }
      for (let i = at + 1; i < visibleOrder.length; i++) {
        if (hasOccurrence(restored, visibleOrder[i])) return visibleOrder[i]
      }
      return null
    }
    setFocus((cur) => (cur && hasOccurrence(restored, cur.key) ? cur : null))
    setSelected((cur) => {
      if (cur && hasOccurrence(restored, cur)) return cur
      const survivor = cur ? nearestSurvivor(cur) : null
      return survivor ?? firstSelectable(restored)
    })
  }

  const undo = () => {
    const restored = history.undo(doc)
    if (!restored) return false
    reconcileToDoc(restored)
    return true
  }
  const redo = () => {
    const restored = history.redo(doc)
    if (!restored) return false
    reconcileToDoc(restored)
    return true
  }

  // The occurrence just unfolded, for the render that reveals its rows: those
  // rows mount with their brief entrance (see `animateIn` in block-item.tsx).
  // Cleared right after — the rows keep the class for their lifetime, so the
  // animation is never cut short, and later rows under the same key never
  // replay it.
  const [justOpened, setJustOpened] = useState<string | null>(null)
  useEffect(() => {
    if (justOpened !== null) setJustOpened(null)
  }, [justOpened])

  const toggleCollapse = (key: string) => {
    if (collapsed.has(key)) setJustOpened(key)
    if (onToggleCollapse) {
      onToggleCollapse(key)
      return
    }
    setCollapsedInternal((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  /** Drive collapse to an explicit state (paste lands its subtrees folded).
   * `toggleCollapse` is the only setter either owner of the state exposes, so
   * a row already in the wanted state is left alone rather than flipped. */
  const setCollapsedState = (key: string, shouldCollapse: boolean) => {
    if (collapsed.has(key) !== shouldCollapse) toggleCollapse(key)
  }

  // Interpret a command's result: commit any doc change to history, toggle
  // collapse, and move focus/selection where the command asked.
  const applyFocus = (intent: FocusIntent) => {
    // Any single-target command collapses a multi-row selection.
    setAnchorKey(null)
    if (intent.mode === "select") {
      setFocus(null)
      setSelected(intent.key)
    } else {
      setSelected(intent.key)
      setFocus({ key: intent.key, atStart: intent.atStart, caret: intent.caret })
    }
  }
  const applyResult = (result: CommandResult) => {
    if (result.doc) history.commit(doc, result.doc, result.op ?? { type: "structural" })
    // Commands name rows, and folds are per row.
    if (result.toggleCollapse) toggleCollapse(result.toggleCollapse)
    // `expand` is a demand ("this row must be open"), not a toggle: only act
    // when the row is actually collapsed (commands can't see collapse state).
    if (result.expand) setCollapsedState(result.expand, false)
    // `collapse` is the symmetric demand ("this row must be closed"): only
    // act when the row is actually open.
    if (result.collapse) setCollapsedState(result.collapse, true)
    if (result.focus) applyFocus(result.focus)
    // Zoom changes navigate (URL state); the zoom-change effect then places the
    // selection (first child on zoom-in, the block zoomed out from on zoom-out).
    if (result.zoom !== undefined) navigateZoom(result.zoom.id)
    if (result.exitTop) {
      // Leaving the top clears the block highlight so nothing stays selected
      // below while focus moves up to the title.
      setFocus(null)
      setSelected(null)
      setAnchorKey(null)
      onExitTop?.()
    }
  }

  // The single entry point every keyboard handler funnels through: resolve the
  // event to a command via the keymap and run it. Touch/menu entry points would
  // dispatch the same commands. Returns whether the gesture was consumed.
  const dispatchKey = (mode: Mode, key: string, event: KeyLike, caret?: CaretInput): boolean => {
    if (readOnly) return false
    const input: CommandInput = {
      doc,
      key,
      mode,
      visibleOrder,
      caret,
      zoomRootId,
      zoomBackId,
      newBlockType: typeOfMarker(newBlockMarker),
    }
    const name = resolveKey(mode, event, input)
    if (!name) return false
    const result = runCommand(name, input)
    applyResult(result)
    return result.handled
  }
  // Run a command by name on a row — what the context menu does, so a menu
  // item and its key do exactly the same thing.
  const runOnRow = (name: CommandName, key: string) => {
    if (readOnly) return
    applyResult(
      runCommand(name, {
        doc,
        key,
        mode: "select",
        visibleOrder,
        zoomRootId,
        zoomBackId,
        newBlockType: typeOfMarker(newBlockMarker),
      }),
    )
  }

  // ── The context menu ──────────────────────────────────────────────────────
  // A right-click on a row opens the block menu on that row (and selects it,
  // so the keyboard follows). Empty space beneath the rows gets the browser's
  // own menu: the event is stopped before the menu's trigger sees it.
  const [menuTarget, setMenuTarget] = useState<BlockMenuTarget | null>(null)
  const handleContextMenuCapture = (event: MouseEvent<HTMLDivElement>) => {
    if (readOnly) return
    const rowEl = (event.target as HTMLElement).closest<HTMLElement>("[data-occurrence]")
    const key = rowEl?.dataset.occurrence
    const row = key === undefined ? undefined : rows.find((r) => r.key === key)
    const block = row ? doc.blocks[row.id] : undefined
    if (!row || !block) {
      event.stopPropagation()
      return
    }
    setMenuTarget({
      key: row.key,
      id: row.id,
      type: block.type,
      hasChildren: row.hasChildren,
      collapsed: row.collapsed,
      places: parentCountOf ? Math.max(1, parentCountOf(row.id)) : 1,
    })
    // Editing a different row would otherwise keep its textarea focused
    // under the menu; the menu's row becomes the selection.
    if (!selectedSet.has(row.key)) select(row.key)
  }
  // ── Images ────────────────────────────────────────────────────────────────
  // A pasted, dropped or picked picture is uploaded first and only then
  // becomes a block (a failed upload leaves the doc as it was and says so),
  // landing after the row it was given to — or replacing that row when it is
  // an empty paragraph/bullet, so "/image" on a blank line puts the picture
  // on that line. Several files arrive in order, each its own undo step.
  const [lightbox, setLightbox] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const noticeTimer = useRef<number | null>(null)
  const showNotice = (message: string) => {
    setNotice(message)
    if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current)
    noticeTimer.current = window.setTimeout(() => setNotice(null), 6000)
  }
  useEffect(
    () => () => {
      if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current)
    },
    [],
  )
  const insertImages = async (key: string, files: File[]) => {
    if (!onImageUpload) return
    // Chained locally, so a second picture lands after the first even before
    // the host has re-rendered with the first one in.
    let current = docRef.current
    for (const file of files) {
      try {
        const asset = await onImageUpload(file)
        const targetId = idOfKey(key)
        const target = current.blocks[targetId]
        if (!target) return
        const props = {
          image: asset.id,
          ...(asset.width && asset.height ? { width: asset.width, height: asset.height } : {}),
        }
        const row = rows.find((r) => r.key === key)
        const blank =
          !row?.zoomTitle &&
          (target.type === "text" || target.type === "ul") &&
          target.text === "" &&
          target.children.length === 0
        let next: BlockDoc
        let nextKey: string
        if (blank) {
          next = {
            ...current,
            blocks: { ...current.blocks, [targetId]: { ...target, type: "image", props } },
          }
          nextKey = key
        } else {
          const image: Block = { id: blockId(), type: "image", text: "", props, children: [] }
          if (row?.zoomTitle) {
            next = insertFirstChild(current, targetId, image)
            nextKey = keyOf(key, image.id)
          } else {
            next = insertAfter(current, key, image)
            nextKey = keyOf(parentKeyOf(key), image.id)
          }
        }
        history.commit(current, next, { type: "structural" })
        current = next
        docRef.current = next
        setAnchorKey(null)
        setFocus(null)
        setSelected(nextKey)
        key = nextKey
      } catch (error) {
        showNotice(error instanceof ImageUploadError ? error.message : "Image upload failed")
      }
    }
  }
  const imageInputRef = useRef<HTMLInputElement>(null)
  const imageInputKey = useRef<string | null>(null)
  const requestImage = (key: string) => {
    imageInputKey.current = key
    imageInputRef.current?.click()
  }
  const handleImagePicked = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.currentTarget.files ?? [])
    event.currentTarget.value = ""
    const key = imageInputKey.current
    imageInputKey.current = null
    if (key && files.length > 0) void insertImages(key, files)
  }
  const handleDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    if (!onImageUpload || readOnly) return
    if (Array.from(event.dataTransfer.types).includes("Files")) event.preventDefault()
  }
  const handleDrop = (event: React.DragEvent<HTMLDivElement>) => {
    if (!onImageUpload || readOnly) return
    const files = imageFilesOf(event.dataTransfer)
    if (files.length === 0) return
    event.preventDefault()
    const rowEl = (event.target as HTMLElement).closest<HTMLElement>("[data-occurrence]")
    const key = rowEl?.dataset.occurrence ?? rows[rows.length - 1]?.key
    if (key) void insertImages(key, files)
  }

  const menuActions: BlockMenuActions = {
    edit: (key) => edit(key),
    openImage: (id) => setLightbox(id),
    downloadImage: (id) => {
      const block = doc.blocks[id]
      if (block) void downloadImage(block)
    },
    setType: (id, type) => {
      const next = updateBlock(doc, id, { type })
      if (next !== doc) history.commit(doc, next, { type: "structural" })
    },
    indent: (key) => runOnRow("indent", key),
    outdent: (key) => runOnRow("outdent", key),
    moveUp: (key) => runOnRow("moveBlockUp", key),
    moveDown: (key) => runOnRow("moveBlockDown", key),
    duplicate: (key) => runOnRow("duplicateBelow", key),
    toggleCollapse: (key) => toggleCollapse(key),
    zoomInto: (id) => navigateZoom(id),
    copy: (key) => copyRows([key]),
    copyLink: noteId
      ? (id) => copy(`${window.location.origin}/notes/${noteId}?block=${id}`)
      : undefined,
    remove: (key) => runOnRow("deleteBlock", key),
    deleteEverywhere: onDeleteEverywhere,
  }

  const api: BlockEditorApi = {
    debug,
    onImageFiles:
      onImageUpload && !readOnly ? (key, files) => void insertImages(key, files) : undefined,
    requestImage: onImageUpload && !readOnly ? requestImage : undefined,
    openImage: (id) => setLightbox(id),
    focus,
    selected,
    selectedSet,
    selectionRunEdges,
    readOnly,
    // Read-only views never take keyboard focus, but their highlights are
    // plain display state — never demote them to "inactive".
    keyboardActive: readOnly || keyboardActive,
    select,
    edit,
    toggleCollapse,
    setFocus,
    onBlockChange: (id, patch, op = "text") => {
      const next = updateBlock(doc, id, patch)
      if (next === doc) return
      history.commit(
        doc,
        next,
        op === "structural" ? { type: "structural" } : { type: "text", blockId: id },
      )
    },
    onPaste: (key, before, pasted, after) => {
      // Re-form the block's text with the pasted text spliced in at the caret,
      // then parse (import) the whole thing so markdown markers and blank
      // lines become the right blocks. The current block keeps its type —
      // unless the caret sits at the start and the pasted content opens with
      // its own marker, in which case the paste defines the block type (so
      // pasting "# Title" into a heading is a heading, not a heading whose
      // text starts with a literal "#").
      const pastedFirstLine = pasted.slice(
        0,
        pasted.includes("\n") ? pasted.indexOf("\n") : undefined,
      )
      const pasteDefinesType = before === "" && leadingMarker(pastedFirstLine) !== null
      // Reminting keeps a pasted `id::` from clobbering an existing block.
      let sub = remintCollidingIds(parse(before + pasted + after), doc)
      const currentType = doc.blocks[idOfKey(key)]?.type
      if (!pasteDefinesType && currentType !== undefined && sub.rootBlockIds.length > 0) {
        sub = updateType(sub, sub.rootBlockIds[0], currentType)
      }
      const result = spliceBlocks(doc, key, sub)
      if (!result) return
      history.commit(doc, result.doc, { type: "structural" })
      // Place the caret at the paste boundary — just before the trailing text.
      const last = result.doc.blocks[result.lastId]
      const caret = Math.max(0, last.text.length - after.length)
      // The pasted blocks took the row's place among its siblings.
      const lastKey = keyOf(parentKeyOf(key), result.lastId)
      setSelected(lastKey)
      setFocus({ key: lastKey, caret })
    },
    dispatchKey,
    zoomInto: (id) => {
      if (!readOnly) navigateZoom(id)
    },
    startSelectionLadder: (key) => {
      if (readOnly) return
      // Called from edit mode (Cmd/Ctrl+A with the textarea already fully
      // selected): leave edit mode and take the first ladder rung on the row.
      setFocus(null)
      setSelected(key)
      setAnchorKey(null)
      focusContainer()
      escalateFrom([key], { selected: key, anchorKey: null })
    },
  }

  // The container is the single keyboard target for select mode (see the focus
  // effect below). Edit mode is handled by the focused textarea inside the
  // block; those events also bubble here, so we bail while editing.
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // Cmd/Ctrl+Z undoes, Cmd/Ctrl+Shift+Z (or Ctrl+Y) redoes — at the document
    // level, so a single keystroke can walk back changes across many blocks.
    if (event.metaKey || event.ctrlKey) {
      const key = event.key.toLowerCase()
      if (key === "z" && !event.shiftKey) {
        if (undo()) event.preventDefault()
        return
      }
      if ((key === "z" && event.shiftKey) || key === "y") {
        if (redo()) event.preventDefault()
        return
      }
      // other Cmd combos (Cmd+Enter, Cmd+Arrow, Cmd+C/X) fall through below
    }

    // Nothing focused (after Escape's deselect): arrows re-select the first /
    // last visible block, so the editor stays reachable by keyboard.
    if (!focus && !selected && !event.defaultPrevented) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        const target =
          event.key === "ArrowDown" ? visibleOrder[0] : visibleOrder[visibleOrder.length - 1]
        if (target) {
          event.preventDefault()
          setAnchorKey(null)
          setSelected(target)
        }
      }
      return
    }

    // Edit mode: the textarea's own handler owns the keys; don't double-handle.
    if (focus || !selected || event.defaultPrevented) return
    const key = selected
    const mod = event.metaKey || event.ctrlKey

    // Shift+Arrow grows / shrinks a multi-block selection — but NOT with Cmd/Ctrl
    // (move-block) or Alt (duplicate) also held; those resolve via the keymap.
    if (
      event.shiftKey &&
      !mod &&
      !event.altKey &&
      (event.key === "ArrowUp" || event.key === "ArrowDown")
    ) {
      event.preventDefault()
      extendSelection(event.key === "ArrowUp" ? "up" : "down")
      return
    }
    // Cmd/Ctrl+A grows the selection one structural rung (subtree → parent's
    // subtree → … → page); +Shift steps back down the same ladder.
    if (mod && !event.altKey && event.key.toLowerCase() === "a") {
      event.preventDefault()
      if (event.shiftKey) shrinkSelection()
      else escalateSelection()
      return
    }
    // Copy / cut the current selection — one block or many.
    if (mod && !event.altKey && event.key.toLowerCase() === "c") {
      event.preventDefault()
      copySelection()
      return
    }
    if (mod && !event.altKey && event.key.toLowerCase() === "x") {
      event.preventDefault()
      cutSelection()
      return
    }
    // Cmd/Ctrl+Shift+V pastes as plain text: flag it and let the browser's
    // native paste event fire (the container's onPaste reads the flag). Plain
    // Cmd/Ctrl+V needs nothing here — its paste event fires on its own.
    if (mod && event.shiftKey && event.key.toLowerCase() === "v") {
      plainPasteRef.current = true
      return
    }
    // Actions that only make sense on a multi-row selection.
    if (selectedKeys.length > 1) {
      const isArrow = event.key === "ArrowUp" || event.key === "ArrowDown"
      const direction = event.key === "ArrowUp" ? "up" : "down"
      // Shift+Alt+Arrow duplicates the selection roots as one group and
      // selects the copies.
      if (isArrow && event.altKey && event.shiftKey && !mod) {
        event.preventDefault()
        const result = duplicateBlocks(
          doc,
          structuralRoots(),
          direction === "up" ? "above" : "below",
        )
        if (result) {
          history.commit(doc, result.doc, { type: "structural" })
          setFocus(null)
          setAnchorKey(result.copies[0])
          setSelected(result.copies[result.copies.length - 1])
        }
        return
      }
      // Alt+Arrow / Mod+Shift+Arrow move the whole contiguous selection one
      // position among its shared parent's children (no-op across parents).
      if (
        isArrow &&
        ((event.altKey && !event.shiftKey && !mod) || (mod && event.shiftKey && !event.altKey))
      ) {
        event.preventDefault()
        const next = moveBlocks(doc, structuralRoots(), direction)
        if (next !== doc) history.commit(doc, next, { type: "structural" })
        return
      }
      if (event.key === "Tab") {
        event.preventDefault()
        if (event.shiftKey) outdentSelection()
        else indentSelection()
        return
      }
      if (event.key === "Backspace" || event.key === "Delete") {
        event.preventDefault()
        removeSelection()
        return
      }
      if (event.key === "Escape") {
        event.preventDefault()
        select(key)
        return
      }
      // Marker keys "turn into" across the whole selection: toggle each root
      // to the kind (marker swap only — content and children untouched). One
      // structural commit = one undo step. Shift AND Alt are fine — # and >
      // need Shift on many layouts, and non-US Macs type symbols with Option
      // (UK # is Alt+3). Only Mod combos stay the browser's. The type is the
      // block's, so a block selected in two rows toggles once.
      const target = TURN_INTO_KEYS[event.key]
      if (target && !mod) {
        event.preventDefault()
        let next = doc
        for (const rootId of new Set(selectionRoots().map(idOfKey))) {
          const block = next.blocks[rootId]
          if (block) next = updateType(next, rootId, toggleType(block.type, target))
        }
        if (next !== doc) history.commit(doc, next, { type: "structural" })
        return
      }
    }
    // Single-select: resolve through the keymap.
    if (dispatchKey("select", key, event)) event.preventDefault()
  }

  // Keep the container focused whenever a block is highlighted (select mode), so
  // arrow keys always move the highlight instead of scrolling the page — even
  // after a structural change or after focus drifted to a non-interactive spot.
  // Edit mode is left alone (the textarea owns focus). `preventScroll` stops the
  // focus call from jumping the page around on every doc change.
  useLayoutEffect(() => {
    if (readOnly || focus || !selected) return
    // While the outline palette is previewing, focus stays in its input — the
    // moving highlight must not steal the keyboard mid-typing.
    if (revealSnapshotRef.current) return
    const el = containerRef.current
    if (!el) return
    if (!el.contains(document.activeElement)) el.focus({ preventScroll: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, focus, anchorKey, doc, readOnly])

  // Keep the highlighted block centred as it moves, since focusing the
  // container itself no longer scrolls it into view. Let the browser do the
  // work with a native `scrollIntoView({ block: "center" })` — no manual
  // measuring to misfire and jump, and it correctly walks nested scroll
  // containers. We centre the inner content *line* (`data-block-line`), not the
  // row wrapper: the wrapper carries a heading's top margin, which would
  // otherwise distort where the highlight lands and make headings jump. When
  // the note fits on screen there's nothing to scroll, so this is a no-op.
  useLayoutEffect(() => {
    if (readOnly || focus || !selected) return
    const row = containerRef.current?.querySelector<HTMLElement>(`[data-occurrence="${selected}"]`)
    const line = row?.querySelector<HTMLElement>("[data-block-line]") ?? row
    if (!line || typeof line.scrollIntoView !== "function") return
    skipCenterScroll.current = false
    // Reveal, don't position (the VS Code model): a target already on screen
    // with a comfortable margin never scrolls — so clicks (the block is under
    // the pointer) and ladder moves hold still. A near target (arrowing past
    // the edge) scrolls minimally — `nearest` plus the scroll-margin band on
    // [data-block-line] gives keyboard travel a few lines of context, like
    // scrolloff. Only a far jump (palette, zoom, search — more than a viewport
    // away) recentres for orientation.
    const rect = line.getBoundingClientRect()
    const vh = window.innerHeight || document.documentElement.clientHeight
    const margin = 72
    if (rect.top >= margin && rect.bottom <= vh - margin) return
    const far = rect.bottom < -vh || rect.top > 2 * vh
    line.scrollIntoView({ block: far ? "center" : "nearest" })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, anchorKey, focus, readOnly])

  // When focus falls to nothing (a click on empty page space) while a block is
  // still highlighted, keep the keyboard alive by re-grabbing focus. A click on
  // a real control elsewhere (relatedTarget set) is left to take focus.
  const handleContainerBlur = (event: FocusEvent<HTMLDivElement>) => {
    // Focus is leaving the container (for real controls, or possibly for
    // nothing): settle keyboard ownership on the next frame. If the re-grab
    // below (or anything else) puts focus back first, the check is a no-op.
    scheduleKeyboardIdleCheck()
    if (readOnly || focus || !selected || event.relatedTarget) return
    const el = containerRef.current
    requestAnimationFrame(() => {
      if (el && el.isConnected && !el.contains(document.activeElement)) {
        el.focus({ preventScroll: true })
      }
    })
  }

  // Select-mode paste: parse the clipboard into blocks and insert them after
  // the last block of the current selection — no need to enter edit mode first.
  // (Edit-mode paste is handled by the focused textarea and guarded out here.)
  const handleContainerPaste = (event: ClipboardEvent<HTMLDivElement>) => {
    const plain = plainPasteRef.current
    plainPasteRef.current = false
    if (readOnly || focus || !selected) return
    // The row pasted onto (the last of a range), and its block.
    const target = selectedKeys[selectedKeys.length - 1] ?? selected
    // A pasted picture becomes an image block after the row (images on).
    const files = imageFilesOf(event.clipboardData)
    if (files.length > 0) {
      if (!onImageUpload) return
      event.preventDefault()
      void insertImages(target, files)
      return
    }
    event.preventDefault()
    const text = event.clipboardData?.getData("text/plain") ?? ""
    const normalized = text.replace(/\r\n?/g, "\n")
    const targetId = idOfKey(target)
    // Pasting onto a selected block puts the content INSIDE it — in the graph
    // that is a link from the target down to what you pasted, which is what
    // "paste here" means when a block is the thing selected (a sibling would
    // be "paste next to"). The zoomed title reaches the same place: its body.

    /** Land a pasted fragment under `target`: reveal the target so the paste
     * is visible, and fold each pasted root so a big subtree arrives as one
     * line rather than dumping its whole tree into the view. */
    const settleAfterPaste = (rootIds: string[], nextDoc: BlockDoc) => {
      setCollapsedState(target, false)
      for (const id of rootIds) {
        // Pasted roots land as the target's first children.
        if ((nextDoc.blocks[id]?.children.length ?? 0) > 0)
          setCollapsedState(keyOf(target, id), true)
      }
    }
    if (plain) {
      // Paste-as-plain: one new paragraph block, newlines collapsed to spaces
      // (a block is a single line in the serialized format). Bypasses the html
      // flavor entirely.
      if (normalized.trim() === "") return
      const fresh = emptyBlock("text", normalized.replace(/\s*\n+\s*/g, " ").trim())
      const next = insertFirstChild(doc, targetId, fresh)
      if (next === doc) return
      setCollapsedState(target, false)
      history.commit(doc, next, { type: "structural" })
      setAnchorKey(null)
      setFocus(null)
      setSelected(keyOf(target, fresh.id))
      return
    }
    // Rich paste: prefer the html flavor — our own embedded block payload
    // first (exact rebuild, no markdown parsing), then converted foreign html
    // — and fall back to text/plain parsed as markdown, exactly as before.
    const html = event.clipboardData?.getData("text/html") ?? ""
    let pasted: BlockDoc | null = null
    if (html.trim() !== "") {
      const embedded = extractClipboardBlocks(html)
      if (embedded && embedded.length > 0) {
        // A Ruminate payload: link, duplicate, or skip per block — the
        // fragment arrives with its ids already settled, so it bypasses the
        // remint below (reminting would undo the link).
        const fragment = embeddedPasteFragment(embedded, doc, target, resolveBlocks)
        if (!fragment) return // every pasted block is already a child here
        const linked = insertBlocksAsFirstChildren(doc, targetId, fragment)
        if (!linked) return
        settleAfterPaste(fragment.rootBlockIds, linked.doc)
        history.commit(doc, linked.doc, { type: "structural" })
        setAnchorKey(null)
        setFocus(null)
        setSelected(keyOf(target, linked.lastId))
        return
      }
      const converted = htmlToMarkdown(html)
      if (converted.trim() !== "") pasted = parse(converted)
    }
    if (!pasted) {
      if (normalized.trim() === "") return
      pasted = parse(normalized)
    }
    // Remint any pasted ids that already exist here (e.g. content copied with
    // its `id::` lines) so the paste never clobbers an existing block.
    const sub = remintCollidingIds(pasted, doc)
    const result = insertBlocksAsFirstChildren(doc, targetId, sub)
    if (!result) return
    settleAfterPaste(sub.rootBlockIds, result.doc)
    history.commit(doc, result.doc, { type: "structural" })
    setAnchorKey(null)
    setFocus(null)
    setSelected(keyOf(target, result.lastId))
  }

  // The rows a DOM text selection touches, in view order, each as one block
  // line (content + id line, so a count of entries is a count of rows; the id
  // rides to the embedded payload only). `partial` when the selection covers
  // some row only in part. Rows are what is on screen — a folded subtree's
  // hidden rows are never picked, so a cut never deletes what the user could
  // not see selected.
  const pickSelectedRows = (selection: Selection) => {
    const picked: string[] = []
    const keys: string[] = []
    let partial = false
    for (const row of rows) {
      const block = doc.blocks[row.id]
      const el = containerRef.current?.querySelector(
        `[data-occurrence="${row.key}"] [data-block-id]`,
      )
      if (!block || !el || !selection.containsNode(el, true)) continue
      if (!selection.containsNode(el, false)) partial = true
      // Zoomed, the title's body rows read one level beneath it.
      const depth = row.zoomTitle ? 0 : row.depth + (zoomRoot ? 1 : 0)
      const indent = "  ".repeat(depth)
      picked.push(`${indent}${blockLine(block)}\n${indent}  id:: ${block.id}`)
      keys.push(row.key)
    }
    return { picked, keys, partial }
  }

  // Native cut over a DOM text selection: only when the selection fully covers
  // every row it touches do we take over — copy them as markdown and remove
  // them in one structural step. Partial coverage is a strict no-op, so content
  // the user didn't fully select is never deleted.
  const handleCut = (event: ClipboardEvent<HTMLDivElement>) => {
    if (readOnly || focus) return
    const selection = window.getSelection()
    if (!selection || selection.isCollapsed) return

    const { picked, keys, partial } = pickSelectedRows(selection)
    if (picked.length === 0 || partial) return
    const pickedSet = new Set(keys)
    // Never let a native cut delete the zoomed title out of its own view.
    if (zoomKey !== null && pickedSet.has(zoomKey)) return

    // Removal happens by subtree root; every row a root drags along must
    // itself be covered, or the cut would delete unselected content.
    const roots = keys.filter((key) => !ancestorKeys(key).some((a) => pickedSet.has(a)))
    const covered = (key: string): boolean => {
      if (!pickedSet.has(key)) return false
      return (doc.blocks[idOfKey(key)]?.children ?? []).every((child) => covered(keyOf(key, child)))
    }
    if (!roots.every(covered)) return

    const formats = richClipboardFormats(picked.join("\n"))
    event.clipboardData.setData("text/plain", formats.plain)
    event.clipboardData.setData("text/html", formats.html)
    event.preventDefault()

    let next = doc
    let focusKey: string | null = null
    for (const key of roots) {
      if (!hasOccurrence(next, key)) continue
      const result = removeBlock(next, key)
      next = result.doc
      focusKey = result.focusKey
    }
    if (next === doc) return
    if (focusKey && !hasOccurrence(next, focusKey)) focusKey = null
    history.commit(doc, next, { type: "structural" })
    setAnchorKey(null)
    setFocus(null)
    setSelected(focusKey ?? firstSelectable(next))
  }

  const handleCopy = (event: ClipboardEvent<HTMLDivElement>) => {
    const selection = window.getSelection()
    if (!selection || selection.isCollapsed) return

    const { picked } = pickSelectedRows(selection)

    // Only take over for multi-row selections; a partial single-row copy is
    // better served by the plain selected text.
    if (picked.length < 2) return
    // Route through the same display-markdown path as every other copy action so
    // the result is clean markdown (blank lines between prose, GFM todos) rather
    // than raw block lines with bare `[ ]` markers run together — plus the html
    // flavor carrying the exact block tree for a Ruminate→Ruminate round-trip.
    const formats = richClipboardFormats(picked.join("\n"))
    event.clipboardData.setData("text/plain", formats.plain)
    event.clipboardData.setData("text/html", formats.html)
    event.preventDefault()
  }

  // Breadcrumb while zoomed: the navigation stack minus the current root —
  // the hops the user actually took, in order (levels are never dropped —
  // long labels truncate with CSS instead). Clicking a crumb truncates the
  // stack back to it via the reconciliation effect.
  const crumbIds = useMemo(
    () => (zoomRootId ? zoomStack.slice(0, -1).filter((id) => doc.blocks[id]) : []),
    [doc, zoomRootId, zoomStack],
  )
  const crumbLabel = (id: string): string => {
    const text = (doc.blocks[id]?.text ?? "").trim()
    return text === "" ? "…" : text
  }
  const crumbClass =
    "min-w-0 max-w-48 cursor-pointer truncate rounded-sm px-1 transition-colors duration-150 hover:bg-bg-secondary hover:text-text"

  // ── Guide lines ───────────────────────────────────────────────────────────
  // Every row draws the guide lines of the rows it is indented under (one per
  // level, `guideKeys`), so a parent's line runs continuously beside its
  // subtree. Pointing anywhere in a subtree brightens the lines that trace it
  // — the guides of the row under the pointer and of all its ancestors. That
  // is a class toggled straight on the DOM: the rows themselves never
  // re-render for a hover.
  const hotGuides = useRef<{ key: string | null; els: Element[] }>({ key: null, els: [] })
  const setHotGuides = (key: string | null) => {
    if (hotGuides.current.key === key) return
    for (const el of hotGuides.current.els) el.classList.remove("block-guide-hot")
    hotGuides.current = { key, els: [] }
    const container = containerRef.current
    if (key === null || !container) return
    const segments = key.split("/")
    const selector = segments
      .map((_, i) => `[data-guide="${segments.slice(0, i + 1).join("/")}"]`)
      .join(",")
    const els = Array.from(container.querySelectorAll(selector))
    for (const el of els) el.classList.add("block-guide-hot")
    hotGuides.current.els = els
  }
  const handleMouseOver = (event: MouseEvent<HTMLDivElement>) => {
    const row = (event.target as HTMLElement).closest<HTMLElement>("[data-occurrence]")
    setHotGuides(row?.dataset.occurrence ?? null)
  }

  return (
    <>
      {zoomRoot ? (
        <nav
          aria-label="Zoom path"
          data-testid="zoom-breadcrumb"
          className="mb-3 flex min-w-0 items-center gap-0.5 font-content text-sm text-text-secondary"
        >
          <button type="button" className={crumbClass} onClick={() => navigateZoom(null)}>
            {noteTitle?.trim() || "Note"}
          </button>
          {crumbIds.map((id) => (
            <Fragment key={id}>
              <span aria-hidden className="text-text-tertiary">
                ›
              </span>
              <button type="button" className={crumbClass} onClick={() => navigateZoom(id)}>
                {crumbLabel(id)}
              </button>
            </Fragment>
          ))}
          <span aria-hidden className="text-text-tertiary">
            ›
          </span>
          <span aria-current="page" className="min-w-0 max-w-48 truncate px-1 text-text">
            {crumbLabel(zoomRoot.id)}
          </span>
        </nav>
      ) : null}
      <BlockContextMenu target={readOnly ? null : menuTarget} actions={menuActions}>
        {/* The container holds keyboard focus for select mode (tabIndex -1 =
          focusable only programmatically), so arrows/shortcuts work no matter
          which block is highlighted. outline-none hides the focus ring. */}
        {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions */}
        <div
          className="outline-none"
          ref={containerRef}
          tabIndex={-1}
          onKeyDown={handleKeyDown}
          onFocus={handleContainerFocus}
          onBlur={handleContainerBlur}
          onCopy={handleCopy}
          onPaste={handleContainerPaste}
          onCut={handleCut}
          onMouseOver={handleMouseOver}
          onMouseLeave={() => setHotGuides(null)}
          onContextMenuCapture={handleContextMenuCapture}
          onDragOver={handleDragOver}
          onDrop={handleDrop}
        >
          {/* The view is a flat list: one row per occurrence, indented by its
            depth. Zoomed, the first row is the zoomed block as the view's
            editable title and its children follow at depth 0. */}
          {rows.map((row) => {
            const block = doc.blocks[row.id]
            if (!block) return null
            return (
              <BlockItem
                key={row.key}
                doc={doc}
                block={block}
                occurrence={row}
                api={api}
                animateIn={justOpened !== null && row.guideKeys.includes(justOpened)}
              />
            )
          })}
          {notice ? (
            <div role="status" className="mt-2 px-1 text-sm text-text-danger">
              {notice}
            </div>
          ) : null}
        </div>
      </BlockContextMenu>
      {onImageUpload ? (
        <input
          ref={imageInputRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          data-testid="image-input"
          onChange={handleImagePicked}
        />
      ) : null}
      <ImageLightbox
        block={lightbox ? (doc.blocks[lightbox] ?? null) : null}
        onClose={() => setLightbox(null)}
      />
    </>
  )
}
