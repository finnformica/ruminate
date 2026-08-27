import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import type { ClipboardEvent, FocusEvent, KeyboardEvent } from "react"
import type { BlockDoc } from "../../blocks/types"
import { getBlockType, stripMarker } from "../../blocks/block-type"
import {
  runCommand,
  type CaretInput,
  type CommandInput,
  type CommandResult,
  type FocusIntent,
  type Mode,
} from "../../blocks/commands"
import { resolveKey, type KeyLike } from "../../blocks/keymap"
import { parse } from "../../blocks/parse"
import { toDisplayMarkdown } from "../../blocks/to-display-markdown"
import {
  ancestorsOf,
  duplicateBlocks,
  emptyBlock,
  indentBlock,
  insertAfter,
  insertBlocksAfter,
  moveBlocks,
  outdentBlock,
  remintCollidingIds,
  removeBlock,
  siblingsOf,
  spliceBlocks,
  subtreeIds,
  updateContent,
} from "../../blocks/ops"
import { copyAsMarkdown } from "../../utils/copy-markdown"
import { BlockItem, type BlockEditorApi, type FocusRequest } from "./block-item"
import { useBlockHistory } from "./use-block-history"

/** The id of the first heading block whose text matches `heading`, in document
 * order, or null. Used to highlight a heading arrived at from the command menu. */
function findHeadingBlockId(doc: BlockDoc, heading: string): string | null {
  const target = heading.trim()
  let found: string | null = null
  const walk = (ids: string[]) => {
    for (const id of ids) {
      if (found) return
      const block = doc.blocks[id]
      if (!block) continue
      if (
        getBlockType(block.content).kind === "heading" &&
        stripMarker(block.content).trim() === target
      ) {
        found = id
        return
      }
      walk(block.children)
    }
  }
  walk(doc.rootBlockIds)
  return found
}

/** The first block (in document order) present in `restored` but not in
 * `current` — the block an undo brought back, e.g. after a delete. */
function findReappeared(current: BlockDoc, restored: BlockDoc): string | null {
  let found: string | null = null
  const walk = (ids: string[]) => {
    for (const id of ids) {
      if (found) return
      if (!(id in current.blocks)) {
        found = id
        return
      }
      const block = restored.blocks[id]
      if (block) walk(block.children)
    }
  }
  walk(restored.rootBlockIds)
  return found
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
  readOnly = false,
}: {
  doc: BlockDoc
  onChange: (doc: BlockDoc) => void
  /** Start with the first block in edit mode (e.g. a brand-new note). */
  startEditing?: boolean
  /** Highlight the block for this heading text on mount / when it changes. */
  highlightHeading?: string
  /**
   * Collapsed block ids. Optional: when provided (with `onToggleCollapse`),
   * collapse is controlled and persisted by the caller; otherwise it falls back
   * to transient local state (e.g. Storybook / standalone usage).
   */
  collapsed?: Set<string>
  onToggleCollapse?: (id: string) => void
  /** Called when the user navigates up past the first block — lets the caller
   * move focus to whatever sits above the editor (e.g. the note title). */
  onExitTop?: () => void
  /** Bump this (e.g. Down-arrow from the note title) to focus the first block. */
  focusFirstSignal?: number
  /** Whether `focusFirstSignal` opens the first block editing or just highlighted. */
  focusFirstMode?: "edit" | "select"
  /** Bump this (e.g. Cmd+Enter on the note title) to add a new root block. */
  newRootSignal?: number
  /** Display-only: renders blocks without any editing (e.g. past-day history). */
  readOnly?: boolean
}) {
  const firstBlockId = doc.rootBlockIds[0] ?? null
  const [focus, setFocus] = useState<FocusRequest | null>(() =>
    startEditing && firstBlockId ? { id: firstBlockId } : null,
  )
  const [selected, setSelected] = useState<string | null>(() =>
    highlightHeading ? (findHeadingBlockId(doc, highlightHeading) ?? firstBlockId) : firstBlockId,
  )
  const [collapsedInternal, setCollapsedInternal] = useState<Set<string>>(new Set())
  const collapsed = collapsedProp ?? collapsedInternal
  // The other end of a multi-block selection (Shift+Arrow). null = single select.
  const [anchorId, setAnchorId] = useState<string | null>(null)
  const history = useBlockHistory(onChange)

  // The container is the focusable keyboard target for select mode.
  const containerRef = useRef<HTMLDivElement>(null)
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
  useEffect(() => {
    if (!highlightHeading) return
    const id = findHeadingBlockId(docRef.current, highlightHeading)
    if (id) {
      setFocus(null)
      setSelected(id)
    }
  }, [highlightHeading])

  // Blocks in the order they appear on screen (depth-first, skipping the
  // children of collapsed blocks). Used for up/down navigation.
  const visibleOrder = useMemo(() => {
    const order: string[] = []
    const walk = (ids: string[]) => {
      for (const id of ids) {
        const block = doc.blocks[id]
        if (!block) continue
        order.push(id)
        if (!collapsed.has(id)) walk(block.children)
      }
    }
    walk(doc.rootBlockIds)
    return order
  }, [doc, collapsed])

  // The selected block ids. Single select is just `[selected]`; a Shift+Arrow
  // range is the contiguous span of `visibleOrder` between anchor and head.
  const selectedIds: string[] = useMemo(() => {
    if (!selected) return []
    if (!anchorId || anchorId === selected) return [selected]
    const a = visibleOrder.indexOf(anchorId)
    const b = visibleOrder.indexOf(selected)
    if (a === -1 || b === -1) return [selected]
    const [lo, hi] = a < b ? [a, b] : [b, a]
    return visibleOrder.slice(lo, hi + 1)
  }, [selected, anchorId, visibleOrder])
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds])

  const select = (id: string) => {
    setFocus(null)
    setAnchorId(null)
    setSelected(id)
    // Grab keyboard focus so arrows work immediately, even re-clicking the block
    // that's already highlighted (which wouldn't trigger the focus effect).
    focusContainer()
  }

  // Extend the multi-selection by moving the head one block along, keeping the
  // anchor fixed (starting a range from the current head if there isn't one).
  const extendSelection = (direction: "up" | "down") => {
    if (!selected) return
    const i = visibleOrder.indexOf(selected)
    if (i === -1) return
    const next = direction === "up" ? i - 1 : i + 1
    if (next < 0 || next >= visibleOrder.length) return
    if (!anchorId) setAnchorId(selected)
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
  const ladderRef = useRef<{ selected: string; anchorId: string | null }[]>([])
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
  }, [selected, anchorId, doc])

  // The contiguous run of `visibleOrder` covered by `id`'s subtree: the block
  // plus its visible descendants (just the block for a leaf or collapsed one).
  const visibleSubtree = (id: string): string[] => {
    const start = visibleOrder.indexOf(id)
    if (start === -1) return []
    const sub = new Set(subtreeIds(doc, id))
    let end = start + 1
    while (end < visibleOrder.length && sub.has(visibleOrder[end])) end++
    return visibleOrder.slice(start, end)
  }

  // One rung up: grow `ids` (a contiguous run of `visibleOrder`) to the visible
  // subtree of the deepest block strictly containing it — the head block itself
  // when the selection is a strict subset of its own subtree, otherwise the
  // nearest ancestor whose subtree covers it — falling back to the whole page
  // (e.g. a selection spanning multiple roots). `snapshot` is the selection to
  // restore when Cmd/Ctrl+Shift+A steps back down.
  const escalateFrom = (ids: string[], snapshot: { selected: string; anchorId: string | null }) => {
    if (ids.length === 0 || visibleOrder.length === 0) return
    const first = ids[0]
    const last = ids[ids.length - 1]
    // `sub` when it strictly contains the selection (both endpoints of a
    // contiguous range inside another contiguous range ⇒ the whole range is).
    const strictSuperset = (rootId: string): string[] | null => {
      const sub = visibleSubtree(rootId)
      if (sub.length <= ids.length) return null
      return sub.includes(first) && sub.includes(last) ? sub : null
    }
    let target = strictSuperset(first)
    if (!target) {
      for (const ancestor of ancestorsOf(doc, first)) {
        target = strictSuperset(ancestor)
        if (target) break
      }
    }
    const range = target ?? visibleOrder
    if (range.length <= ids.length) return // already the whole page
    ladderRef.current.push(snapshot)
    ladderMove.current = true
    skipCenterScroll.current = true
    setFocus(null)
    setSelected(range[0])
    setAnchorId(range[range.length - 1])
  }
  const escalateSelection = () => {
    if (!selected) return
    escalateFrom(selectedIds, { selected, anchorId })
  }
  const shrinkSelection = () => {
    const prev = ladderRef.current.pop()
    if (!prev || !doc.blocks[prev.selected]) return
    ladderMove.current = true
    skipCenterScroll.current = true
    setFocus(null)
    setSelected(prev.selected)
    setAnchorId(prev.anchorId && doc.blocks[prev.anchorId] ? prev.anchorId : null)
  }

  // The top-level blocks of the selection (those with no selected ancestor), in
  // document order — the roots to act on so a subtree is moved/copied once.
  const selectionRoots = (): string[] => {
    const set = selectedSet
    return selectedIds.filter((id) => {
      let parent = siblingsOf(doc, id)?.parentId ?? null
      while (parent) {
        if (set.has(parent)) return false
        parent = siblingsOf(doc, parent)?.parentId ?? null
      }
      return true
    })
  }

  const indentSelection = () => {
    let next = doc
    // In document order: each block's new previous sibling is the one the group
    // is nesting under, so a contiguous sibling range nests together.
    for (const id of selectionRoots()) next = indentBlock(next, id)
    if (next !== doc) history.commit(doc, next, { type: "structural" })
  }
  const outdentSelection = () => {
    let next = doc
    // Reverse order keeps siblings in place as each is lifted out.
    for (const id of [...selectionRoots()].reverse()) next = outdentBlock(next, id)
    if (next !== doc) history.commit(doc, next, { type: "structural" })
  }
  const removeSelection = () => {
    let next = doc
    let focusId: string | null = null
    for (const id of selectionRoots()) {
      if (!next.blocks[id]) continue
      const result = removeBlock(next, id)
      next = result.doc
      focusId = result.focusId
    }
    if (next === doc) return
    // The focus target may itself have been part of the selection.
    if (focusId && !next.blocks[focusId]) focusId = null
    history.commit(doc, next, { type: "structural" })
    setAnchorId(null)
    setFocus(null)
    // An emptied doc regains a blank block via the editor's trailing-blank rule.
    setSelected(focusId ?? next.rootBlockIds[0] ?? null)
  }

  // Serialize the selected subtrees to block markdown (markers + nesting) so it
  // round-trips through paste.
  const selectionMarkdown = (): string => {
    const lines: string[] = []
    const walk = (id: string, depth: number) => {
      const block = doc.blocks[id]
      if (!block) return
      lines.push("  ".repeat(depth) + block.content)
      for (const childId of block.children) walk(childId, depth + 1)
    }
    for (const id of selectionRoots()) walk(id, 0)
    return lines.join("\n")
  }
  const copySelection = () => {
    // Route through the shared copy path so it's clean display markdown.
    copyAsMarkdown(selectionMarkdown())
  }
  const cutSelection = () => {
    copySelection()
    removeSelection()
  }
  // When the caller bumps `focusFirstSignal` (e.g. Down-arrow from the note
  // title), highlight the first block — moving between the title and the blocks
  // moves the highlight, like moving between blocks.
  useEffect(() => {
    if (!focusFirstSignal || readOnly) return
    const first = docRef.current.rootBlockIds[0]
    if (!first) return
    setAnchorId(null)
    setSelected(first)
    // Mirror the title's own state: editing the title drops into the first block
    // editing (caret at its start); a highlighted title just highlights it.
    setFocus(focusFirstMode === "edit" ? { id: first, atStart: true } : null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusFirstSignal])

  // When the caller bumps `newRootSignal` (e.g. Cmd+Enter on the note title),
  // add a fresh root block at the top and edit it.
  useEffect(() => {
    if (!newRootSignal || readOnly) return
    const current = docRef.current
    const fresh = emptyBlock()
    const next: BlockDoc = {
      ...current,
      rootBlockIds: [fresh.id, ...current.rootBlockIds],
      blocks: { ...current.blocks, [fresh.id]: fresh },
    }
    history.commit(current, next, { type: "structural" })
    setAnchorId(null)
    setSelected(fresh.id)
    setFocus({ id: fresh.id })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newRootSignal])

  const edit = (id: string, atStart = false) => {
    if (readOnly) return
    setAnchorId(null)
    setSelected(id)
    setFocus({ id, atStart })
  }

  // After restoring a snapshot, keep editing/selecting the same block if it
  // still exists; otherwise fall back to select mode on a valid block.
  const reconcileToDoc = (restored: BlockDoc) => {
    setAnchorId(null)
    // If a block reappeared (e.g. undo of a delete), highlight it so the thing
    // you brought back is where your focus lands.
    const reappeared = findReappeared(doc, restored)
    if (reappeared) {
      setFocus(null)
      setSelected(reappeared)
      return
    }
    setFocus((cur) => (cur && restored.blocks[cur.id] ? cur : null))
    setSelected((cur) => (cur && restored.blocks[cur] ? cur : (restored.rootBlockIds[0] ?? null)))
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

  const toggleCollapse = (id: string) => {
    if (onToggleCollapse) {
      onToggleCollapse(id)
      return
    }
    setCollapsedInternal((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // Interpret a command's result: commit any doc change to history, toggle
  // collapse, and move focus/selection where the command asked.
  const applyFocus = (intent: FocusIntent) => {
    // Any single-target command collapses a multi-block selection.
    setAnchorId(null)
    if (intent.mode === "select") {
      setFocus(null)
      setSelected(intent.id)
    } else {
      setSelected(intent.id)
      setFocus({ id: intent.id, atStart: intent.atStart, caret: intent.caret })
    }
  }
  const applyResult = (result: CommandResult) => {
    if (result.doc) history.commit(doc, result.doc, result.op ?? { type: "structural" })
    if (result.toggleCollapse) toggleCollapse(result.toggleCollapse)
    if (result.focus) applyFocus(result.focus)
    if (result.exitTop) {
      // Leaving the top clears the block highlight so nothing stays selected
      // below while focus moves up to the title.
      setFocus(null)
      setSelected(null)
      setAnchorId(null)
      onExitTop?.()
    }
  }

  // The single entry point every keyboard handler funnels through: resolve the
  // event to a command via the keymap and run it. Touch/menu entry points would
  // dispatch the same commands. Returns whether the gesture was consumed.
  const dispatchKey = (mode: Mode, id: string, event: KeyLike, caret?: CaretInput): boolean => {
    if (readOnly) return false
    const input: CommandInput = { doc, id, mode, visibleOrder, caret }
    const name = resolveKey(mode, event, input)
    if (!name) return false
    const result = runCommand(name, input)
    applyResult(result)
    return result.handled
  }

  const api: BlockEditorApi = {
    focus,
    selected,
    selectedSet,
    collapsed,
    readOnly,
    select,
    edit,
    toggleCollapse,
    setFocus,
    onContentChange: (id, content) =>
      history.commit(doc, updateContent(doc, id, content), { type: "text", blockId: id }),
    onPaste: (id, prefix, before, pasted, after) => {
      // Re-form the block's line with the pasted text spliced in at the caret,
      // then parse the whole thing so markdown prefixes and blank lines become
      // the right blocks. The current block's marker stays on the first line.
      // Reminting keeps a pasted `id::` from clobbering an existing block.
      const sub = remintCollidingIds(parse(prefix + before + pasted + after), doc)
      const result = spliceBlocks(doc, id, sub)
      if (!result) return
      history.commit(doc, result.doc, { type: "structural" })
      // Place the caret at the paste boundary — just before the trailing text.
      const last = result.doc.blocks[result.lastId]
      const caret = Math.max(0, stripMarker(last.content).length - after.length)
      setSelected(result.lastId)
      setFocus({ id: result.lastId, caret })
    },
    dispatchKey,
    startSelectionLadder: (id) => {
      if (readOnly) return
      // Called from edit mode (Cmd/Ctrl+A with the textarea already fully
      // selected): leave edit mode and take the first ladder rung on the block.
      setFocus(null)
      setSelected(id)
      setAnchorId(null)
      focusContainer()
      escalateFrom([id], { selected: id, anchorId: null })
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
          setAnchorId(null)
          setSelected(target)
        }
      }
      return
    }

    // Edit mode: the textarea's own handler owns the keys; don't double-handle.
    if (focus || !selected || event.defaultPrevented) return
    const id = selected
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
    // Actions that only make sense on a multi-block selection.
    if (selectedIds.length > 1) {
      const isArrow = event.key === "ArrowUp" || event.key === "ArrowDown"
      const direction = event.key === "ArrowUp" ? "up" : "down"
      // Shift+Alt+Arrow duplicates the selection roots as one group and
      // selects the copies.
      if (isArrow && event.altKey && event.shiftKey && !mod) {
        event.preventDefault()
        const result = duplicateBlocks(
          doc,
          selectionRoots(),
          direction === "up" ? "above" : "below",
        )
        if (result) {
          history.commit(doc, result.doc, { type: "structural" })
          setFocus(null)
          setAnchorId(result.copies[0])
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
        const next = moveBlocks(doc, selectionRoots(), direction)
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
        select(id)
        return
      }
    }
    // Single-select: resolve through the keymap.
    if (dispatchKey("select", id, event)) event.preventDefault()
  }

  // Keep the container focused whenever a block is highlighted (select mode), so
  // arrow keys always move the highlight instead of scrolling the page — even
  // after a structural change or after focus drifted to a non-interactive spot.
  // Edit mode is left alone (the textarea owns focus). `preventScroll` stops the
  // focus call from jumping the page around on every doc change.
  useLayoutEffect(() => {
    if (readOnly || focus || !selected) return
    const el = containerRef.current
    if (!el) return
    if (!el.contains(document.activeElement)) el.focus({ preventScroll: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, focus, anchorId, doc, readOnly])

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
    const row = containerRef.current?.querySelector<HTMLElement>(`[data-block-row="${selected}"]`)
    const line = row?.querySelector<HTMLElement>("[data-block-line]") ?? row
    if (!line || typeof line.scrollIntoView !== "function") return
    // A ladder move keeps the head where the user's eyes already are — skip the
    // centring jump when it's still fully on screen.
    if (skipCenterScroll.current) {
      skipCenterScroll.current = false
      const rect = line.getBoundingClientRect()
      const viewportHeight = window.innerHeight || document.documentElement.clientHeight
      if (rect.top >= 0 && rect.bottom <= viewportHeight) return
    }
    line.scrollIntoView({ block: "center" })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, anchorId, focus, readOnly])

  // When focus falls to nothing (a click on empty page space) while a block is
  // still highlighted, keep the keyboard alive by re-grabbing focus. A click on
  // a real control elsewhere (relatedTarget set) is left to take focus.
  const handleContainerBlur = (event: FocusEvent<HTMLDivElement>) => {
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
    event.preventDefault()
    const text = event.clipboardData?.getData("text/plain") ?? ""
    const normalized = text.replace(/\r\n?/g, "\n")
    if (normalized.trim() === "") return
    const target = selectedIds[selectedIds.length - 1] ?? selected
    if (plain) {
      // Paste-as-plain: one new paragraph block, newlines collapsed to spaces
      // (a block is a single line in the serialized format).
      const fresh = emptyBlock(normalized.replace(/\s*\n+\s*/g, " ").trim())
      const next = insertAfter(doc, target, fresh)
      if (next === doc) return
      history.commit(doc, next, { type: "structural" })
      setAnchorId(null)
      setFocus(null)
      setSelected(fresh.id)
      return
    }
    // Remint any pasted ids that already exist here (e.g. content copied with
    // its `id::` lines) so the paste never clobbers an existing block.
    const sub = remintCollidingIds(parse(normalized), doc)
    const result = insertBlocksAfter(doc, target, sub)
    if (!result) return
    history.commit(doc, result.doc, { type: "structural" })
    setAnchorId(null)
    setFocus(null)
    setSelected(result.lastId)
  }

  // Native cut over a DOM text selection: only when the selection fully covers
  // every block it touches do we take over — copy them as markdown and remove
  // them in one structural step. Partial coverage is a strict no-op, so content
  // the user didn't fully select is never deleted.
  const handleCut = (event: ClipboardEvent<HTMLDivElement>) => {
    if (readOnly || focus) return
    const selection = window.getSelection()
    if (!selection || selection.isCollapsed) return

    const picked: string[] = []
    const pickedSet = new Set<string>()
    let partial = false
    const walk = (ids: string[], depth: number) => {
      for (const bid of ids) {
        const block = doc.blocks[bid]
        if (!block) continue
        const el = containerRef.current?.querySelector(`[data-block-id="${bid}"]`)
        if (el && selection.containsNode(el, true)) {
          if (!selection.containsNode(el, false)) partial = true
          picked.push("  ".repeat(depth) + block.content)
          pickedSet.add(bid)
        }
        walk(block.children, depth + 1)
      }
    }
    walk(doc.rootBlockIds, 0)
    if (picked.length === 0 || partial) return

    // Removal happens by subtree root; every block a root drags along must
    // itself be covered, or the cut would delete unselected content.
    const roots = [...pickedSet].filter((bid) => {
      let parent = siblingsOf(doc, bid)?.parentId ?? null
      while (parent) {
        if (pickedSet.has(parent)) return false
        parent = siblingsOf(doc, parent)?.parentId ?? null
      }
      return true
    })
    const covered = (bid: string): boolean => {
      if (!pickedSet.has(bid)) return false
      return (doc.blocks[bid]?.children ?? []).every(covered)
    }
    if (!roots.every(covered)) return

    event.clipboardData.setData("text/plain", toDisplayMarkdown(picked.join("\n")))
    event.preventDefault()

    let next = doc
    let focusId: string | null = null
    for (const bid of roots) {
      if (!next.blocks[bid]) continue
      const result = removeBlock(next, bid)
      next = result.doc
      focusId = result.focusId
    }
    if (next === doc) return
    if (focusId && !next.blocks[focusId]) focusId = null
    history.commit(doc, next, { type: "structural" })
    setAnchorId(null)
    setFocus(null)
    setSelected(focusId ?? next.rootBlockIds[0] ?? null)
  }

  const handleCopy = (event: ClipboardEvent<HTMLDivElement>) => {
    const selection = window.getSelection()
    if (!selection || selection.isCollapsed) return

    const picked: string[] = []
    const walk = (ids: string[], depth: number) => {
      for (const id of ids) {
        const block = doc.blocks[id]
        if (!block) continue
        const el = containerRef.current?.querySelector(`[data-block-id="${id}"]`)
        if (el && selection.containsNode(el, true)) {
          picked.push("  ".repeat(depth) + block.content)
        }
        walk(block.children, depth + 1)
      }
    }
    walk(doc.rootBlockIds, 0)

    // Only take over for multi-block selections; a partial single-block copy
    // is better served by the plain selected text.
    if (picked.length < 2) return
    // Route through the same display-markdown path as every other copy action so
    // the result is clean markdown (blank lines between prose, GFM todos) rather
    // than raw block lines with bare `[ ]` markers run together.
    event.clipboardData.setData("text/plain", toDisplayMarkdown(picked.join("\n")))
    event.preventDefault()
  }

  return (
    // The container holds keyboard focus for select mode (tabIndex -1 = focusable
    // only programmatically), so arrows/shortcuts work no matter which block is
    // highlighted. outline-none hides the focus ring on the wrapper itself.
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions
    <div
      className="space-y-0.5 outline-none"
      ref={containerRef}
      tabIndex={-1}
      onKeyDown={handleKeyDown}
      onBlur={handleContainerBlur}
      onCopy={handleCopy}
      onPaste={handleContainerPaste}
      onCut={handleCut}
    >
      {doc.rootBlockIds.map((id) => {
        const block = doc.blocks[id]
        if (!block) return null
        return <BlockItem key={id} doc={doc} block={block} depth={0} api={api} />
      })}
    </div>
  )
}
