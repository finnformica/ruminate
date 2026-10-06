import type React from "react"

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import type { ChangeEvent, ClipboardEvent, CSSProperties, KeyboardEvent } from "react"
import { cx } from "../../utils/cx"
import type { Block, BlockDoc } from "../../blocks/types"
import { linkifyPastedText, linkifyTypedAddress } from "../../blocks/link"
import { leadingMarker } from "../../blocks/markers"
import { defOf } from "../../blocks/registry"
import type { BlockPatch } from "../../blocks/ops"
import type { Occurrence } from "../../blocks/view"
import type { CaretInput, Mode } from "../../blocks/commands"
import type { KeyLike } from "../../blocks/keymap"
import {
  applySlashItem,
  findSlashTrigger,
  slashMenuItems,
  type SlashItem,
  type SlashTrigger,
} from "../../blocks/slash-menu"
import { htmlToMarkdown } from "../../utils/html-to-markdown"
import { clipboardBlocksToMarkdown, extractClipboardBlocks } from "../../utils/rich-clipboard"
import { imageFilesOf } from "../../data/images"
import { blurLeavesWindow } from "../../utils/window-blur"
import { IconButton } from "../ui/icon-button"
import { BlockContent } from "./block-content"
import { LISTED_HEADING_DEPTH, headingScale, kindOf, type RowContext } from "./block-kinds"
import { caretCoordinates, caretLineFlags, caretOffsetAtPoint } from "./caret"
import { BlockKey } from "./block-key"
import { LinkActionsContext, type LinkActions } from "./link-actions"
import { SLASH_MENU_WIDTH, SlashMenu } from "./slash-menu"

/**
 * Drop the focus half of a press, keeping it wherever it already is.
 *
 * The controls in a row's marker slot — the fold chevron, a todo's box — are
 * things you reach for *while* writing, so they must not close the edit they
 * are reached from. A press moves focus by default, the textarea's blur ends
 * the edit, and the row shuts mid-sentence. Preventing the mousedown default
 * stops only the focus (and any text selection); the click, and so the
 * control's own behaviour, is untouched.
 */
const keepEditing = (event: React.MouseEvent) => event.preventDefault()

/** A request to edit a row (an occurrence key — a block twice in the view is
 * two rows, and only the one asked for opens). */
export interface FocusRequest {
  key: string
  atStart?: boolean
  /** Explicit caret offset; overrides `atStart` when set. */
  caret?: number
}

export interface BlockEditorApi {
  focus: FocusRequest | null
  /** The head of the selection in select mode (null while editing/unfocused):
   * a row's occurrence key, as is everything positional below. */
  selected: string | null
  /** All highlighted rows (a Shift+Arrow range, or just the head), by key. */
  selectedSet: Set<string>
  /**
   * For each row in a multi-selection whose highlight surface touches a
   * selected neighbour, which of its corners (top/bottom) should go straight
   * so the run reads as one continuous surface. Empty for single selections.
   */
  selectionRunEdges: Map<string, { top: boolean; bottom: boolean }>
  /** Display-only: no editing, selection, or mutation (collapse still works). */
  readOnly?: boolean
  /**
   * Whether the editor moves through its rows at all (`BlockEditor`): every
   * editable one does, and a read-only one that is browsed. A read-only row
   * of a browsed editor highlights on click, as an editable one does; one of
   * an inert editor does nothing.
   */
  navigable?: boolean
  /**
   * The roots are the view's own — a results list's hits, the Views page's
   * notes — not a parent's children (`BlockEditor.fixedRoots`). A kind may
   * draw a root differently for it (a listed note takes a roomier row).
   */
  fixedRoots?: boolean
  /**
   * Rows kept only to say where a match lives — the unmatched ancestors of
   * a filtered view's matches (`src/data/filter-view.ts`). Drawn dimmed, so
   * the rows the filter actually found are the ones that read as found;
   * they edit, fold and select like any other row. Empty or absent when
   * nothing is filtered.
   */
  context?: ReadonlySet<string>
  /**
   * Whether the editor owns the keyboard: focus is inside its container and
   * the user's last act was not a click on blank space (a key press hands it
   * back). While false, selected rows demote to the quiet inactive-selection
   * ring (`.block-highlight-inactive`) so the highlight never claims a
   * keyboard it doesn't have. Always true in read-only views (their
   * highlight is display state, not a keyboard cursor).
   */
  keyboardActive: boolean
  /**
   * The primary pointer is a finger (docs/mobile.md): a tap on a row edits
   * it where the tap landed (a click selects; a double-click edits), and
   * the whole row is the tap target. The long-press menu is how a row is
   * selected.
   */
  coarsePointer?: boolean
  /** Highlight a row (leaves edit mode, collapses any multi-selection). */
  /** Highlight a row — or, `extend`, the run from the selection to it
   * (Shift+click). */
  select: (key: string, extend?: boolean) => void
  /** Enter edit mode on a row — at the end of its text, its start, or at
   * an explicit caret offset (where a tap landed). */
  edit: (key: string, atStart?: boolean, caret?: number) => void
  /** Fold or unfold a row (by occurrence key — folds are per row). */
  toggleCollapse: (key: string) => void
  setFocus: (focus: FocusRequest | null) => void
  /**
   * Change a block's text and/or type. Text edits coalesce into one undo
   * step; pass `"structural"` for a change that must stand alone (a
   * slash-menu pick, so one undo puts the typed `/phrase` back).
   */
  onBlockChange: (id: string, patch: BlockPatch, op?: "text" | "structural") => void
  /** Replace the row with blocks imported from pasted markdown, placing the caret. */
  onPaste: (key: string, before: string, pasted: string, after: string) => void
  /**
   * Resolve a key event to an editor command (via the keymap) and run it.
   * Every keyboard interaction funnels through here; returns whether the event
   * was consumed (so the caller can `preventDefault`).
   */
  dispatchKey: (mode: Mode, key: string, event: KeyLike, caret?: CaretInput) => boolean
  /** Image files pasted or dropped on a row: upload them and add image blocks
   * there. Absent where images are switched off (the paste is left alone). */
  onImageFiles?: (key: string, files: File[]) => void
  /** Open the file picker for an image to add at this row (the slash menu's
   * "Image"). Absent where images are switched off. */
  requestImage?: (key: string) => void
  /** Expand an image block's picture (the lightbox). */
  openImage?: (id: string) => void
  /** Make a link block of a link in this row's text (docs/links.md): the
   * row itself when its text is nothing but the link, else a new row
   * beneath it. Absent in read-only views. */
  linkToBlock?: (key: string, href: string, title: string) => void
  /** Change a link's display text and/or address in this row's text
   * (docs/links.md): `[title](href)` becomes `[next.title](next.href)`; a
   * bare address is written out as a link. Absent in read-only views. */
  updateLink?: (
    key: string,
    href: string,
    title: string,
    next: { href?: string; title?: string },
  ) => void
  /** A link block back to a paragraph holding its link as text. */
  linkToInline?: (id: string) => void
  /** A link block's title and/or address changed in one step: a new
   * address has its preview fetched afresh. */
  updateLinkBlock?: (id: string, next: { href?: string; title?: string }) => void
  /** Take a link in this row's text off, leaving its text as words. */
  removeLink?: (key: string, href: string, title: string) => void
  /** A link block's Remove link: the row goes, as ⌫ on it would. */
  removeLinkBlock?: (key: string) => void
  /** A link's card the reader asked to open from the menu ("Edit link",
   * for a touch screen): the row and the address. */
  linkCard?: { key: string; href: string } | null
  /** That card closed. */
  closeLinkCard?: () => void
  /**
   * Exit edit mode and take the first selection-ladder rung on this row
   * (Cmd/Ctrl+A pressed with the textarea's text already fully selected).
   */
  startSelectionLadder: (key: string) => void
  /**
   * A read-only row that opens something when clicked (a search result):
   * the body takes the click, and the row shows the hover surface and a
   * pointer. Absent in the editor, where a click selects the row.
   */
  activate?: (key: string) => void
  /** Developer-mode debug readouts; absent in ordinary use. */
  debug?: BlockDebugOptions
}

/**
 * Developer-mode debug readouts (`src/hooks/is-developer.ts`): the block's
 * id beside it and its graph metadata beneath it. Every field is optional so
 * the editor stays standalone (Storybook, tests) without any of them.
 */
export interface BlockDebugOptions {
  /** Show each block's `blk_` id beside its content (click to copy). */
  showIds?: boolean
  /** Show each block's metadata beneath it: type, depth, downstream, upstream. */
  showMetadata?: boolean
  /**
   * The notes upstream of the block — the notes that reach it through child
   * links (a linked block has several; a duplicated one has one, under a
   * fresh id). Absent when no corpus is available; the readout then omits
   * the upstream line.
   */
  upstreamOf?: (id: string) => readonly string[]
}

/** The scale names the stylesheet keys a heading's surface reach off, by
 * outline depth — the same steps as `headingScale`; deeper headings are at
 * body scale and keep the ordinary surface. */
const HEADING_SCALE_NAMES: Record<number, "2xl" | "xl" | "lg"> = { 0: "2xl", 1: "xl", 2: "lg" }

/** Row geometry, in px. A row is the 17px CHEVRON COLUMN, the row's gap, the
 * 15px key slot, the gap again, then the text; the column starts 4px into
 * the content column (the highlight surface's -2px reach + 6px inner
 * padding), so its centre is 12.5px in and the key's centre 24px further on
 * with the 8px gap (4 + 17 + 8 + 7.5 = 36.5). Each level indents by exactly
 * that, so a parent's key stands directly over its children's chevrons: the
 * indent is the column's centre-to-centre distance to the key, which is
 * `INDENT` at the 8px gap and `COARSE_INDENT` at the coarse pointer's 12px
 * (`coarse:gap-3`). The guide line hangs from the parent's chevron: a 1px
 * rule at `GUIDE_X`, covering 12–13px, centred on the column's 12.5. Text
 * starts 52px into the column (56px on a coarse pointer). */
const INDENT = 24
const COARSE_INDENT = 28
const GUIDE_X = 12
/** Root rows sit 2px further apart than nested ones (which meet at their
 * 2px + 2px vertical padding). */
const ROOT_GAP = 2

/** How long a nameless key press (keyCode 229) at the start of a block is
 * given to change the text before it is taken for a Backspace. A keyboard's
 * own input arrives in the same turn as its keydown; the beat is slack for a
 * slow device, not a wait. */
const SILENT_KEY_BEAT = 50

export function BlockItem({
  doc,
  block,
  occurrence,
  api,
}: {
  doc: BlockDoc
  block: Block
  /** This row's place in the view (`src/blocks/view.ts`): its depth, fold,
   * ordered number, guide lines. */
  occurrence: Occurrence
  api: BlockEditorApi
}) {
  const { depth, olNumber, hasChildren, collapsed: isCollapsed } = occurrence
  const readOnly = api.readOnly ?? false
  // Selection and edit focus are per row: this occurrence, not the block.
  const editing = !readOnly && api.focus?.key === occurrence.key
  const selected = api.selectedSet.has(occurrence.key) && !editing
  // Which sides of this row sit MID-RUN in a multi-select (the adjacent
  // visible row is also selected and the surfaces touch) — those sides keep
  // the full 4px vertical extension so the run merges seamlessly; every other
  // side extends only 2px (see the data-block-line classes below).
  const runEdges = selected ? api.selectionRunEdges.get(occurrence.key) : undefined
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const pendingCaret = useRef<number | null>(null)
  // Where a finger actually came down on this row: the pointerdown's point,
  // which the browser never adjusts. The click that follows may be moved —
  // a phone snaps a near miss onto the nearest control (a todo's checkbox
  // above all) — so a tap is judged by where it landed, not by where the
  // click says it did.
  const touchDown = useRef<{ x: number; y: number } | null>(null)
  // Set by a checkbox click that is handed to the text: React raises the
  // box's change from the same click, after it, so the change must be told.
  const tickHandedOff = useRef(false)
  // Set by a Cmd/Ctrl+Shift+V keydown so the paste event that follows inserts
  // plain text at the caret (newlines collapsed, no block splitting).
  const plainPaste = useRef(false)

  // The slash menu: open while the caret sits in a `/phrase` (see
  // `findSlashTrigger`) that matches at least one row. `index` is the
  // highlighted row; Escape remembers the dismissed `/` so the menu stays
  // shut until that slash is gone.
  const [slash, setSlash] = useState<{ trigger: SlashTrigger; index: number } | null>(null)
  const dismissedSlash = useRef<number | null>(null)
  const [slashStyle, setSlashStyle] = useState<CSSProperties>({})
  const slashQuery = slash?.trigger.query
  const slashItems = useMemo(
    () =>
      slashQuery === undefined
        ? []
        : slashMenuItems(slashQuery, new Date(), { images: api.requestImage !== undefined }),
    [slashQuery, api.requestImage],
  )

  const type = block.type
  // The block's text is marker-free by construction: its type is drawn as a
  // real bullet/checkbox/heading style in the marker slot, never as text. This
  // keeps the view and the editor pixel-identical — nothing shifts on click.
  const body = block.text
  // How this type looks (`block-kinds.tsx`): its marker, typography, any
  // panel, and the chrome around the content line.
  const kind = kindOf(type)
  // A results view's row (`fixedRoots`): one among many, so a heading keeps
  // the body's scale and its breathing room.
  const listed = !!api.fixedRoots
  const scaleDepth = listed ? LISTED_HEADING_DEPTH : depth
  // The level's indent: the chevron-to-key distance, which the coarse
  // pointer's wider marker gap stretches (see the geometry above).
  const indent = api.coarsePointer ? COARSE_INDENT : INDENT
  const typo = kind.typography(depth, block, listed)
  // Whether this block owns a collapse toggle at all: parents only. The
  // row that closes a loop keeps its chevron too — the block has children,
  // they are simply above it — greyed and inert, with the reason in its
  // tooltip (focus on it to go round again).
  const looped = !!occurrence.looped
  const hasToggle = hasChildren || looped
  const rowContext: RowContext = { block, occurrence, api, depth, editing }
  // Kept as context by a filter, not found by it (`BlockEditorApi.context`).
  const dimmed = api.context?.has(block.id) ?? false

  // Focus and place the caret when editing starts — and again when the
  // block's TYPE changes mid-edit: a type whose chrome wraps the line (a
  // code block's panel, `BlockKind.wrap`) puts the textarea in a different
  // place in the tree, so React mounts a fresh element and the keyboard
  // would be left on nothing. Typing `\` ` into a paragraph, or `- ` into an
  // empty code block, must keep the caret where it is; the resize effect
  // below, which runs after this one, lands it there (`pendingCaret`).
  useLayoutEffect(() => {
    if (!editing) return
    const el = textareaRef.current
    if (!el) return
    el.focus()
    const pos =
      api.focus?.caret !== undefined
        ? Math.min(api.focus.caret, el.value.length)
        : api.focus?.atStart
          ? 0
          : el.value.length
    el.setSelectionRange(pos, pos)
  }, [editing, api.focus?.atStart, api.focus?.caret, type])

  // Backspace at the very start of the block, from a keyboard that does not
  // say so. A phone's keyboard does not always name the key it pressed:
  // Android's input method reports "Unidentified" (keyCode 229) for every
  // key, and some report a bare keyCode 8 — so the keydown path above never
  // sees a Backspace to strip a marker or merge the block upward, and the
  // block cannot be deleted by the key. Three more ways of hearing it, each
  // only at the very start of the text, where the textarea itself has
  // nothing to delete and the command is the only thing the key can mean:
  //
  // - `beforeinput` names the intent (`deleteContentBackward`) where the
  //   browser raises one for a deletion that would do nothing (Chromium).
  //   WebKit does not: a delete with nothing before the caret returns before
  //   any event is sent.
  // - a keydown with keyCode 8 and no name is the key itself.
  // - a keydown with no name at all (229) that is followed by no change to
  //   the text — no input, no composition — within a beat. A named key, a
  //   letter, a suggestion and a composition all change the text or say
  //   what they are; a delete of nothing is the one that is silent.
  //
  // Native listeners: React's onBeforeInput is synthesised from text entry
  // and never fires for a deletion, and the beat must be measured from the
  // element's own events, before React's.
  const apiRef = useRef(api)
  apiRef.current = api
  useEffect(() => {
    if (!editing) return
    const el = textareaRef.current
    if (!el) return
    const atStart = () => el.selectionStart === 0 && el.selectionEnd === 0
    const backspace = (): boolean => {
      const key: KeyLike = {
        key: "Backspace",
        shiftKey: false,
        metaKey: false,
        ctrlKey: false,
        altKey: false,
      }
      const caret: CaretInput = {
        value: el.value,
        start: 0,
        end: 0,
        atFirstLine: true,
        atLastLine: !el.value.includes("\n"),
      }
      return apiRef.current.dispatchKey("edit", occurrence.key, key, caret)
    }
    // A press being listened for: cleared by any event that says what it was.
    let listening = false
    const heard = () => {
      listening = false
    }
    const onBeforeInput = (event: InputEvent) => {
      heard()
      if (event.inputType !== "deleteContentBackward" || !atStart()) return
      if (backspace()) event.preventDefault()
    }
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.isComposing || !atStart()) return
      const unnamed = event.key === "Unidentified" || event.keyCode === 229
      if (!unnamed) return
      if (event.keyCode === 8) {
        if (backspace()) event.preventDefault()
        return
      }
      const value = el.value
      listening = true
      window.setTimeout(() => {
        if (!listening) return
        listening = false
        if (el.isConnected && el.value === value && atStart()) backspace()
      }, SILENT_KEY_BEAT)
    }
    el.addEventListener("beforeinput", onBeforeInput)
    el.addEventListener("keydown", onKeyDown)
    el.addEventListener("input", heard)
    el.addEventListener("compositionstart", heard)
    return () => {
      el.removeEventListener("beforeinput", onBeforeInput)
      el.removeEventListener("keydown", onKeyDown)
      el.removeEventListener("input", heard)
      el.removeEventListener("compositionstart", heard)
    }
  }, [editing, occurrence.key])

  // Resize on content change, and restore the caret after a marker shortcut
  // reshaped the visible text (e.g. typing `# ` promoted the block to a
  // heading and the `# ` moved out of the textarea).
  useLayoutEffect(() => {
    if (!editing) return
    const el = textareaRef.current
    if (!el) return
    el.style.height = "auto"
    // An empty textarea would size to its ghost placeholder (which could wrap
    // on narrow screens); the empty row is exactly one line (matching the view
    // branch's min-h-[1lh]) — the ghost must never move layout.
    el.style.height = el.value === "" ? "1lh" : `${el.scrollHeight}px`
    if (pendingCaret.current !== null) {
      const pos = pendingCaret.current
      pendingCaret.current = null
      el.setSelectionRange(pos, pos)
    }
  }, [editing, block.text])

  /** Re-read the caret and open / move / close the slash menu accordingly. */
  const syncSlash = (value: string, caret: number) => {
    const trigger = findSlashTrigger(value, caret)
    if (!trigger) {
      dismissedSlash.current = null
      setSlash(null)
      return
    }
    if (dismissedSlash.current === trigger.start) {
      setSlash(null)
      return
    }
    setSlash((prev) =>
      prev && prev.trigger.start === trigger.start && prev.trigger.query === trigger.query
        ? prev
        : { trigger, index: 0 },
    )
  }

  const slashOpen = editing && slash !== null && slashItems.length > 0

  // Leaving edit mode closes the menu.
  useEffect(() => {
    if (!editing) setSlash(null)
  }, [editing])

  // Hang the popup under the `/` (re-measured as the text reflows). The
  // textarea's offsetParent is the block line (`relative`), which the popup
  // is positioned within; the left edge is clamped so the popup never spills
  // past the line's right edge.
  const slashStart = slash?.trigger.start
  useLayoutEffect(() => {
    if (!slashOpen || slashStart === undefined) return
    const el = textareaRef.current
    if (!el) return
    const { top, left, height } = caretCoordinates(el, slashStart)
    const lineWidth = el.offsetParent?.clientWidth ?? Infinity
    setSlashStyle({
      top: el.offsetTop + top + height,
      left: Math.max(0, Math.min(el.offsetLeft + left, lineWidth - SLASH_MENU_WIDTH)),
    })
  }, [slashOpen, slashStart, block.text])

  const pickSlashItem = (item: SlashItem) => {
    const el = textareaRef.current
    if (!el || !slash) return
    const result = applySlashItem(el.value, slash.trigger, item)
    pendingCaret.current = result.caret
    dismissedSlash.current = null
    setSlash(null)
    if (result.type !== undefined && !defOf(result.type).turnInto) {
      // A row that is not a type change (an image asks for a file): the
      // `/phrase` goes, and the picker decides what (if anything) is added.
      api.onBlockChange(block.id, { text: result.text }, "structural")
      api.requestImage?.(occurrence.key)
      return
    }
    // Its own undo step, so Cmd/Ctrl+Z puts the typed `/phrase` back.
    api.onBlockChange(
      block.id,
      result.type !== undefined ? { text: result.text, type: result.type } : { text: result.text },
      "structural",
    )
  }

  const handleTextareaChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    const el = event.currentTarget
    const newBody = el.value
    const caret = el.selectionStart
    // The typing shortcut: a marker typed at the very start of the text
    // switches the block's type, *replacing* the current one (checkbox → `- `
    // becomes a bullet, → `1. ` an ordered item, → `# ` a heading, and so on),
    // and the marker itself is dropped — the feel of markdown, none stored.
    // Otherwise the edit is to the block's text.
    // In a code block a leading `# ` or `- ` is code (a comment, a YAML
    // list), not a marker: only a marker typed on its own, into an empty
    // block, turns it back into that type. And code's own marker (a
    // backtick) never re-types the block it is already in.
    const leading = leadingMarker(newBody)
    const typed =
      leading !== null && (type !== "code" || (leading.text === "" && leading.type !== "code"))
        ? leading
        : null
    // A space typed after a bare address writes it out as a link named for
    // its host (docs/links.md), as a paste is; the caret follows. Not in a
    // code block, where an address is code.
    const linked = typed === null && type !== "code" ? linkifyTypedAddress(newBody, caret) : null
    const text = typed !== null ? typed.text : linked !== null ? linked.text : newBody
    if (typed !== null) {
      // The marker left the visible text; keep the caret relative to it.
      pendingCaret.current = Math.max(0, caret - (newBody.length - text.length))
      api.onBlockChange(block.id, { type: typed.type, text })
    } else if (linked !== null) {
      pendingCaret.current = linked.caret
      api.onBlockChange(block.id, { text }, "structural")
    } else {
      api.onBlockChange(block.id, { text })
    }
    syncSlash(text, pendingCaret.current ?? caret)
  }

  const handleEditKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const el = event.currentTarget
    // While the slash menu is open it owns the navigation keys; everything
    // else falls through to the textarea (typing narrows the menu).
    if (slashOpen && slash && !event.metaKey && !event.ctrlKey && !event.altKey) {
      const count = slashItems.length
      switch (event.key) {
        case "ArrowDown":
          event.preventDefault()
          setSlash({ ...slash, index: (slash.index + 1) % count })
          return
        case "ArrowUp":
          event.preventDefault()
          setSlash({ ...slash, index: (slash.index - 1 + count) % count })
          return
        case "Enter":
        case "Tab":
          event.preventDefault()
          pickSlashItem(slashItems[Math.min(slash.index, count - 1)])
          return
        case "Escape":
          event.preventDefault()
          dismissedSlash.current = slash.trigger.start
          setSlash(null)
          return
      }
    }
    // Cmd/Ctrl+Shift+V: flag paste-as-plain and let the native paste event fire
    // (handlePaste reads the flag). Any other key clears a stale flag.
    plainPaste.current =
      (event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "v"
    if (plainPaste.current) return
    // Cmd/Ctrl+A: the first press is the native textarea select-all. A press
    // with the text already fully selected (or an empty textarea) escalates
    // instead — exit edit mode and start the selection ladder on this block.
    if (
      (event.metaKey || event.ctrlKey) &&
      !event.altKey &&
      !event.shiftKey &&
      event.key.toLowerCase() === "a"
    ) {
      const allSelected =
        el.value.length === 0 || (el.selectionStart === 0 && el.selectionEnd === el.value.length)
      if (allSelected) {
        event.preventDefault()
        api.startSelectionLadder(occurrence.key)
      }
      return
    }
    // Line geometry is only needed to decide whether an arrow leaves the block,
    // and measuring it mirrors the textarea into the DOM — so skip it for every
    // other key.
    const isArrow = event.key === "ArrowUp" || event.key === "ArrowDown"
    const flags = isArrow ? caretLineFlags(el) : { atFirst: false, atLast: false }
    const caret: CaretInput = {
      value: el.value,
      start: el.selectionStart,
      end: el.selectionEnd,
      atFirstLine: flags.atFirst,
      atLastLine: flags.atLast,
    }
    if (api.dispatchKey("edit", occurrence.key, event, caret)) event.preventDefault()
  }

  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const plain = plainPaste.current
    plainPaste.current = false
    // A pasted picture (a screenshot, a copied image) becomes an image block
    // beside this row — where images are on; otherwise the browser keeps the
    // event, which in a textarea means nothing happens.
    const files = imageFilesOf(event.clipboardData)
    if (files.length > 0 && api.onImageFiles) {
      event.preventDefault()
      api.onImageFiles(occurrence.key, files)
      return
    }
    const text = event.clipboardData?.getData("text/plain") ?? ""
    const normalized = text.replace(/\r\n?/g, "\n")
    if (plain) {
      // Paste-as-plain: insert at the caret with newlines collapsed to single
      // spaces (a block is one line in the serialized format) — no splitting.
      // Bypasses the html flavor entirely.
      event.preventDefault()
      const el = event.currentTarget
      const collapsed = normalized.replace(/\s*\n+\s*/g, " ")
      const before = el.value.slice(0, el.selectionStart)
      const after = el.value.slice(el.selectionEnd)
      pendingCaret.current = (before + collapsed).length
      api.onBlockChange(block.id, { text: before + collapsed + after })
      return
    }
    // Rich paste: prefer the html flavor — our own embedded block payload
    // first (exact block markdown, no conversion), then foreign html converted
    // to markdown — falling back to the plain text.
    const html = event.clipboardData?.getData("text/html") ?? ""
    let pasted = normalized
    if (html.trim() !== "") {
      const embedded = extractClipboardBlocks(html)
      if (embedded && embedded.length > 0) {
        pasted = clipboardBlocksToMarkdown(embedded)
      } else {
        const converted = htmlToMarkdown(html)
        if (converted.trim() !== "") pasted = converted
      }
    }
    // A bare address in the paste is written out as a link with its host
    // for display text (docs/links.md), so a pasted URL reads as a name
    // rather than a string of slashes; the address itself is kept whole.
    // Done before the single-line shortcut below: a rewritten line is no
    // longer the plain text, so it is inserted by hand as converted html is.
    pasted = linkifyPastedText(pasted)
    if (!pasted.includes("\n")) {
      // Single-line paste: plain text falls through to the browser's ordinary
      // inline insertion; converted html (e.g. `**bold**`) is inserted manually.
      if (pasted === normalized) return
      event.preventDefault()
      const el = event.currentTarget
      const before = el.value.slice(0, el.selectionStart)
      const after = el.value.slice(el.selectionEnd)
      pendingCaret.current = (before + pasted).length
      api.onBlockChange(block.id, { text: before + pasted + after })
      return
    }
    // Multi-line paste is spread across blocks.
    event.preventDefault()
    const el = event.currentTarget
    const before = el.value.slice(0, el.selectionStart)
    const after = el.value.slice(el.selectionEnd)
    api.onPaste(occurrence.key, before, pasted, after)
  }

  // The chevron: a parent's fold control. It lives in the CHEVRON COLUMN
  // every row carries before its key slot (`chevronColumn`, below) — never
  // in the slot, so no key ever swaps out or fades for it, and a to-do's
  // checkbox keeps the slot and its click like any other key. Always shown
  // on a parent (hidden content is never a secret, and the column makes the
  // control's place plain without a reveal); a leaf's column is empty. One
  // glyph, turned a quarter: down while open, right while closed — the same
  // size and shape in both states. The row that closes a loop keeps its
  // chevron too — the block has children, they are simply above it —
  // greyed and inert, with the reason in its tooltip.
  //
  // It floats out of the flow, centred on the column by its own midpoint
  // (left/top 50% + a half-size translate, NOT `inset-0 m-auto`: the 20px
  // square is wider than the 17px column, and an over-constrained absolute
  // box drops its left margin to zero instead of going negative). Press
  // feedback lives on the control (IconButton supplies the hover surface);
  // the content itself never animates on collapse.
  //
  // The square is 20px: the column's centre sits 14.5px in from the
  // surface's left edge (2px reach + 6px padding + half of 17px) and the
  // surface is 27px tall (a 23px line + 2px each side), so the square is
  // 4.5px inside the left edge and 3.5px inside the top and bottom.
  const toggle = hasToggle ? (
    <IconButton
      aria-label={looped ? "Loop detected" : isCollapsed ? "Expand" : "Collapse"}
      size="small"
      // A real toggle explains itself; the loop's needs the tooltip, so it
      // stays enabled for the pointer (a disabled button gets no hover) and
      // is inert by hand: `aria-disabled`, no-op click, not-allowed cursor.
      disableTooltip={!looped}
      tooltipSide="top"
      aria-disabled={looped || undefined}
      tabIndex={-1}
      // Folding never ends an edit: the press is stopped from taking focus,
      // so the textarea keeps it and the caret stays where it was. Without
      // this the blur below closes the edit, and reaching for a chevron
      // mid-sentence costs you your place. Click still fires — only the
      // focus half of the press default is dropped.
      onMouseDown={keepEditing}
      onClick={looped ? undefined : () => api.toggleCollapse(occurrence.key)}
      className={cx(
        "block-toggle absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 shrink-0 p-0 text-text-tertiary transition-transform duration-150",
        looped
          ? "cursor-not-allowed enabled:hover:bg-transparent enabled:active:bg-transparent"
          : "active:scale-[0.92] motion-reduce:active:scale-100",
        // IconButton's default radius is the 8px base — on a 20px square that
        // reads as a pill. The small radius (4px) keeps it a square.
        "rounded-sm",
        // Coarse pointers get a 32px-tall target instead of IconButton's
        // 40px-tall padded bar (which would overlap neighbouring rows and
        // squeeze the glyph); it reaches a hair past the surface into the
        // gap on either side, where no other control lives. 24px wide: it
        // overhangs the column by 3.5px a side, and the row's wider marker
        // gap on a coarse pointer (12px) keeps it clear of the key — a
        // to-do's checkbox above all.
        "h-5 w-5 coarse:h-8 coarse:w-6 coarse:px-0",
      )}
    >
      <svg
        width="12"
        height="12"
        viewBox="0 0 12 12"
        aria-hidden
        className={cx(
          // A quarter turn, long enough to read as a turn rather than a
          // swap, easing out to rest with no overshoot.
          "transition-transform duration-300 ease-[var(--ease-in-out)] motion-reduce:transition-none",
          // A finger's chevron is drawn a size up, to be read — and aimed
          // at — as the control it is.
          "coarse:size-[14px]",
          isCollapsed || looped ? "-rotate-90" : "rotate-0",
        )}
      >
        {/* An open chevron, round-capped: turned, it is the same glyph. */}
        <path
          d="M3 4.5l3 3 3-3"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </IconButton>
  ) : null
  // The chevron column: 17px, on EVERY row — a leaf's is empty — so the key
  // slot and the text stay in one column whether or not a row can fold. Its
  // width is what puts a parent's key exactly over its children's chevrons
  // (the geometry above), and its centre is where the indent guide hangs
  // (`GUIDE_X`): the thread of a subtree drops straight out of the control
  // that folds it. `h-[1lh]` at the row's first-line scale centres the
  // chevron on that line — a heading's scale on a heading, the body's
  // otherwise. A framed block's first line sits further down, past its
  // frame (and a panel's border and padding), so its column moves down by
  // that much (`BlockKind.firstLineOffset`): the chevron is on the first
  // line of code, the card's title, the top of the picture — on the row's
  // first line, as on every other row.
  const chevronColumn = (
    <span
      data-testid="chevron-column"
      className={cx(
        "relative flex h-[1lh] w-[17px] shrink-0 items-center justify-center",
        kind.slot === "hash" && headingScale(scaleDepth),
      )}
      style={kind.firstLineOffset ? { marginTop: kind.firstLineOffset } : undefined}
    >
      {toggle}
    </span>
  )

  // No marker is a focus target. A bullet once was (Logseq-style: click the
  // dot to make the block the note), but a finger reaching for a row's text
  // landed on the dot often enough that the note kept swapping for one
  // block, and on a desktop nobody meant the click either. Focus stays on
  // F / Cmd+., the block menu and the phone's edit bar (docs/mobile.md);
  // a parent's fold is the chevron column's.
  //
  // Every marker occupies the same 15px slot, so body text starts at one
  // column across every block type and the markers read as one chrome
  // family: dots, the `#` and the narrow glyphs centre in it; numbers
  // right-align to its edge; a figure's slot is simply empty.
  //
  // The key itself is drawn by `BlockKey` (block-key.tsx) — the one glyph
  // a type has wherever it is listed, the sidebar included; the slots here
  // only place it. The bullet's dot: faint, like the chevron — pure chrome;
  // content leads.
  const dotSlot = (
    <span className="flex h-[1lh] w-[15px] shrink-0 items-center justify-center">
      <BlockKey type={type} />
    </span>
  )
  // A static glyph key (the quote's `>`, the paragraph's `¶`, a note's
  // favicon) or none at all (a figure — a picture, a link card, a code
  // block — whose frame or panel is its own mark): faint, like the dot and
  // the `#` — chrome, not content. CENTRED in the slot, like the dot, the
  // `#` and the checkbox, not right-aligned like the numbers: `>` is a
  // narrow glyph, and right-aligned its ink sat 3px right of the dot's
  // centre. Never a focus button (no marker is; focus stays on F / Cmd+.
  // and the edit bar). An empty slot keeps its width so the text stays in
  // the shared column.
  const glyphSlot = (testId: string) => (
    <span
      data-testid={testId}
      className="flex h-[1lh] w-[15px] shrink-0 items-center justify-center"
    >
      <BlockKey type={type} block={block} />
    </span>
  )
  // Whether a finger's tap on the checkbox came down to the right of the
  // box as drawn — in the gap before the text. Only on a coarse pointer, and
  // only for a press (a keyboard's Space clicks with `detail` 0 and no point).
  // The point is spent either way, so a stale one never judges a later click.
  const tapMissedBox = (event: React.MouseEvent<HTMLElement>) => {
    const point = touchDown.current
    touchDown.current = null
    if (!api.coarsePointer || !point || event.detail === 0) return false
    return point.x > event.currentTarget.getBoundingClientRect().right
  }
  // The caret to the very start of the text: into the open edit, or opening
  // one. The box sits on the first line, so a tap beside it means offset 0.
  const caretToStart = () => {
    const textarea = textareaRef.current
    if (editing && textarea) textarea.setSelectionRange(0, 0)
    else api.edit(occurrence.key, true)
  }

  // The key slot, by kind. A figure (`slot: "none"`) has no key but keeps
  // the slot, empty, so its frame starts at the text column like every other
  // row's content.
  const marker =
    kind.slot === "checkbox" ? (
      // The checkbox IS the todo's marker — a control in the key slot, which
      // keeps its own click (the fold is the chevron column's, beside it).
      // On coarse pointers the box grows its own tap area
      // (`.block-checkbox::before`).
      <span className="flex h-[1lh] w-[15px] shrink-0 items-center justify-center">
        <input
          type="checkbox"
          checked={type === "done"}
          disabled={readOnly}
          // Ticking never ends an edit either (see the chevron's `keepEditing`):
          // a box you can only reach by stopping typing is a box you stop
          // typing to reach.
          onMouseDown={keepEditing}
          onClick={(event) => {
            event.stopPropagation()
            // A finger that came down PAST the box — in the gap before the
            // text, where the box's own tap area or the browser's snapping
            // caught it — meant the start of the line, not the box: the
            // tick is cancelled and the caret goes there instead.
            if (tapMissedBox(event)) {
              event.preventDefault()
              tickHandedOff.current = true
              caretToStart()
            }
          }}
          // Checked is a TYPE (docs/graph-schema-v2.md): ticking is `todo` ↔ `done`.
          onChange={() => {
            if (tickHandedOff.current) {
              tickHandedOff.current = false
              return
            }
            api.onBlockChange(block.id, { type: type === "done" ? "todo" : "done" })
          }}
          className={cx("block-checkbox", readOnly ? "cursor-default" : "cursor-pointer")}
        />
      </span>
    ) : kind.slot === "dot" ? (
      dotSlot
    ) : kind.slot === "hash" ? (
      // Headings hang the same grey `#` as the note / focus titles — the shared
      // `Hash`, at the heading's own scale: the slot carries the heading's
      // size + weight (headingScale + bold, no underline — that lives in
      // `typo`) and the glyph inherits it, so the hash always matches the text
      // beside it, at every depth. The slot stays the shared 15px column
      // (heading text aligns with every other marked block) and the hash is
      // CENTRED in it, as the dot and a note's favicon are, so a small hash
      // (a listed heading's, a deep one's) stands on the same centre line
      // as every other key rather than in the slot's right half; a large
      // scale outgrows the slot by a pixel or two a side, into the gaps —
      // the text column never moves. The slot's `h-[1lh]` (resolved at the
      // heading's scale) centres the glyph on the heading's first line. A
      // static glyph, like the note title's — never a focus button (no
      // marker is; focus stays on F / Cmd+. and the edit bar).
      <span
        data-testid="heading-hash"
        className={cx(
          "flex h-[1lh] w-[15px] shrink-0 items-center justify-center font-bold",
          headingScale(scaleDepth),
        )}
      >
        <BlockKey type={type} />
      </span>
    ) : kind.slot === "number" ? (
      // Numbers are read (they carry order), so they sit one step up the ramp
      // from the dot — muted, not faint — and right-align to the slot edge.
      <span className="flex h-[1lh] min-w-[15px] shrink-0 items-center justify-end">
        <BlockKey type={type} olNumber={olNumber} />
      </span>
    ) : kind.slot === "none" ? (
      glyphSlot("figure-slot")
    ) : (
      glyphSlot(kind.slotTestId ?? "paragraph-slot")
    )

  // The wrapper: indented by depth, carrying the guide lines of every row it
  // sits under. A heading's breathing room is a margin, so the highlight
  // surface never grows; the guides reach back up through it (`top`), so a
  // parent's line runs unbroken beside its subtree.
  const marginTop = Math.max(
    kind.topMargin?.(depth, listed) ?? 0,
    depth === 0 && occurrence.index > 0 ? ROOT_GAP : 0,
  )

  // What a link in the rendered text can do to this row: its hover card
  // (`link-hover-card.tsx`) changes its display text and makes a block of
  // it, in an editor that can write the change.
  const linkToBlock = readOnly ? undefined : api.linkToBlock
  const updateLink = readOnly ? undefined : api.updateLink
  const removeLink = readOnly ? undefined : api.removeLink
  const openHref = api.linkCard?.key === occurrence.key ? api.linkCard.href : null
  const closeLinkCard = api.closeLinkCard
  const linkActions = useMemo<LinkActions | null>(
    () =>
      linkToBlock && updateLink && removeLink
        ? {
            toBlock: (href, title) => linkToBlock(occurrence.key, href, title),
            update: (href, title, next) => updateLink(occurrence.key, href, title, next),
            remove: (href, title) => removeLink(occurrence.key, href, title),
            openHref,
            closeCard: () => closeLinkCard?.(),
          }
        : null,
    [linkToBlock, updateLink, removeLink, occurrence.key, openHref, closeLinkCard],
  )

  // The caption/body line: the textarea while editing, the rendered text
  // otherwise (an image row hangs it beneath the picture).
  const content = editing ? (
    <>
      <textarea
        ref={textareaRef}
        value={body}
        rows={1}
        spellCheck
        // A quiet brand prompt in an empty block: a ghost at
        // placeholder rank (tertiary — chrome, not ink) that the
        // browser shows only while the textarea is empty, so it never
        // appears in view mode or over content. The turn-into keys
        // live in the `?` reference, not here.
        placeholder={kind.placeholder ?? "Ruminate…"}
        // Said outright, not left to the browser's default, so a phone's
        // keyboard shifts for a new block's first letter and leaves code
        // alone: no capitals, no autocorrect, in a code block.
        autoCapitalize={type === "code" ? "off" : "sentences"}
        autoCorrect={type === "code" ? "off" : "on"}
        onChange={handleTextareaChange}
        onKeyDown={handleEditKeyDown}
        // Caret moves that aren't edits (arrows, Home/End, a click)
        // still decide whether the caret is inside a `/phrase`.
        onKeyUp={(event) => {
          if (/^(Arrow(Left|Right)|Home|End)$/.test(event.key)) {
            syncSlash(event.currentTarget.value, event.currentTarget.selectionStart)
          }
        }}
        onClick={(event) =>
          syncSlash(event.currentTarget.value, event.currentTarget.selectionStart)
        }
        onPaste={handlePaste}
        // Leaving the field ends the edit — unless it is the window that
        // went (a tab switch, another app): the browser brings focus back
        // to this textarea when it returns, so the edit stays open. On a
        // touch screen the keyboard being put away is a blur too (iOS's
        // Done key), so it ends the edit the same way, and the row stays
        // highlighted for the tap that starts the next one (docs/mobile.md).
        onBlur={(event) => {
          if (blurLeavesWindow(event.relatedTarget)) return
          api.setFocus(null)
        }}
        className={cx(
          // Chrome-free, whatever the type: a panel (a code block's) wraps the
          // line (`BlockKind.wrap`), so the height set above — `1lh` empty,
          // else the scroll height — is the text's alone.
          "min-w-0 flex-1 resize-none overflow-hidden border-none bg-transparent p-0 font-content leading-relaxed text-text outline-none [overflow-wrap:anywhere] placeholder:text-text-tertiary",
          // Its own selection back, under the editor's `select-none` for a
          // finger (block-editor.tsx): the one place a press may select text.
          "coarse:select-text",
          typo,
        )}
      />
      {slashOpen && slash ? (
        <SlashMenu
          items={slashItems}
          activeIndex={Math.min(slash.index, slashItems.length - 1)}
          style={slashStyle}
          onHover={(index) => setSlash({ ...slash, index })}
          onPick={pickSlashItem}
        />
      ) : null}
    </>
  ) : (
    // Keyboard for select mode is handled by the editor container (it
    // holds focus), and the pointer is the row's (`linePointer`, below):
    // this element only draws the text.
    <div
      data-testid="block-body"
      data-block-id={block.id}
      className={cx(
        // A long link or an unbroken word breaks rather than running
        // off a narrow screen (the textarea wraps the same way).
        // pre-wrap: the text shows exactly as stored (newlines, runs
        // of spaces, a leading tab), as the textarea shows it.
        "min-h-[1lh] min-w-0 flex-1 whitespace-pre-wrap outline-none [overflow-wrap:anywhere]",
        // On a touch screen a press-and-hold opens the block's menu, so the
        // row's text must not start a selection under the finger (double-tap
        // still edits, where the textarea's own selection applies).
        !readOnly && "cursor-text coarse:select-none",
        readOnly && api.activate && "cursor-pointer",
        typo,
        kind.bodyClass,
      )}
    >
      <LinkActionsContext.Provider value={linkActions}>
        {kind.body ? kind.body(block) : <BlockContent content={body} />}
      </LinkActionsContext.Provider>
    </div>
  )

  // A finger's tap on the row — anywhere in it that is not a control (the
  // chevron, the checkbox, a link, the focus dot) — edits it, with the caret
  // where the tap landed when the body's text is the stored text as is
  // (`caretOffsetAtPoint`), at the end otherwise. The row, not the body, so
  // the marker gap and the row's padding count too: a short line's tap
  // target is the row's whole width and height, not its few words. A tap on
  // the row already being edited is the textarea's own (a caret move), and
  // a press-and-hold never gets here: the editor withholds its click.
  //
  // A tap LEFT of the text — in the marker gap, or on an empty marker slot —
  // is read at the text's own left edge, so it opens the edit at the start
  // of the line it was level with (the first line's start is the text's),
  // never at the end.
  const handleRowTap = (event: React.MouseEvent<HTMLDivElement>) => {
    if (editing) return
    const target = event.target instanceof Element ? event.target : null
    if (target?.closest("button, input, a, textarea, [role='menu']")) return
    const bodyEl = event.currentTarget.querySelector<HTMLElement>("[data-block-id]")
    const point = touchDown.current ?? { x: event.clientX, y: event.clientY }
    touchDown.current = null
    const left = bodyEl?.getBoundingClientRect().left
    const beforeText = left !== undefined && point.x < left
    const caret =
      bodyEl && !kind.body
        ? caretOffsetAtPoint(bodyEl, body, beforeText ? left + 1 : point.x, point.y)
        : null
    if (caret === null && beforeText) api.edit(occurrence.key, true)
    else api.edit(occurrence.key, false, caret ?? undefined)
  }
  const rowTap =
    !readOnly && api.coarsePointer
      ? {
          onClick: handleRowTap,
          onPointerDown: (event: React.PointerEvent) => {
            touchDown.current = { x: event.clientX, y: event.clientY }
          },
        }
      : {}

  // The mouse on the row's SURFACE — anywhere on the highlight surface that
  // is not a control: the chevron column (and its empty space on a leaf),
  // the key slot (a dot, a `#`, a `¶`), the row's padding, a figure's frame
  // and the text itself. A click selects the row (Shift+click extends the
  // selection); a double-click edits it, with the caret at the start of the
  // line when the click fell left of the text, in the gutter, and at the
  // end otherwise. Read-only, a click opens the row (a result) or selects
  // it (a browsed list). Controls keep their own clicks — the chevron, the
  // checkbox, a link, a card's tools, the textarea being edited — so a
  // click on one never doubles as a selection. (The handlers once sat on
  // the text alone, so a click on the dot or beside the chevron did
  // nothing, which read as a row that would not select.) A finger's tap is
  // the row wrapper's (`handleRowTap`, above).
  const isControl = (target: EventTarget | null) =>
    target instanceof Element &&
    target.closest("button, input, a, textarea, [role='menu']") !== null
  const linePointer: Pick<React.HTMLAttributes<HTMLElement>, "onClick" | "onDoubleClick"> = readOnly
    ? api.activate
      ? {
          onClick: (event) => {
            if (!isControl(event.target)) api.activate?.(occurrence.key)
          },
        }
      : api.navigable
        ? {
            onClick: (event) => {
              if (!isControl(event.target)) api.select(occurrence.key)
            },
          }
        : {}
    : api.coarsePointer
      ? {}
      : {
          onClick: (event) => {
            if (!isControl(event.target)) api.select(occurrence.key, event.shiftKey)
          },
          onDoubleClick: (event) => {
            if (isControl(event.target)) return
            const bodyEl = event.currentTarget.querySelector<HTMLElement>("[data-block-id]")
            const left = bodyEl?.getBoundingClientRect().left
            api.edit(occurrence.key, left !== undefined && event.clientX < left)
          },
        }

  return (
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events
    <div
      data-block-row={block.id}
      data-occurrence={occurrence.key}
      className="relative"
      style={{ paddingLeft: depth * indent, marginTop }}
      {...rowTap}
    >
      {occurrence.guideKeys.map((guideKey, level) => (
        <span
          key={guideKey}
          aria-hidden
          data-guide={guideKey}
          className="block-guide pointer-events-none absolute bottom-0 w-px bg-border-secondary transition-colors duration-200"
          style={{ left: GUIDE_X + level * indent, top: -marginTop }}
        />
      ))}
      <div className="relative min-w-0 py-0.5 font-content leading-relaxed">
        <div
          // The visible content line (carries the highlight). Scroll-into-view
          // targets this, not the row wrapper, so a heading's top margin can't
          // distort where the highlight lands.
          data-block-line
          // A heading's surface reaches further left at the larger scales
          // (`[data-heading-scale]` in block-editor.css), so its chevron and
          // `#` sit as far from the left edge as from the top and bottom.
          data-heading-scale={kind.slot === "hash" ? HEADING_SCALE_NAMES[scaleDepth] : undefined}
          {...linePointer}
          className={cx(
            // Negative margin + padding pairs grow the highlight surface
            // while the text (and every marker) stays exactly where it was —
            // the background extends outward instead of pushing content.
            // Horizontally: symmetric — the surface extends 2px each side
            // (-mx-0.5) and gives the text 6px of inner breathing room
            // (pl-1.5 pr-1.5), so the left edge nets to the same text column
            // as before (-2+6 = +4). 2px, not more, so the key slot's centre
            // (13.5px in) matches the surface's vertical centre and the
            // collapse chevron's square sits evenly inside it (see `toggle`).
            // Vertically the extension is CONDITIONAL, per side (see the
            // runEdges pairs below): 2px by default — the midpoint of the
            // nested 4px inter-row gap, so two adjacent surfaces painted in
            // DIFFERENT colors (a hover next to a selection) can at most
            // abut edge-to-edge, never overlap — and the full 4px only on a
            // side that sits mid-run in a multi-select, where the neighbour
            // is the same solid accent and the overlap is what merges the
            // run into one continuous surface. Either way the negative
            // margin equals the padding, so the text never moves a pixel
            // and the block rhythm gains nothing.
            // The marker gap widens on a coarse pointer, so a finger aiming
            // for the start of the line lands on the line, not the marker
            // (a todo's checkbox above all).
            "relative flex items-start gap-2 rounded coarse:gap-3",
            "-ml-0.5 -mr-0.5 pl-1.5 pr-1.5",
            // Per-side vertical pairs. Mid-run sides also square their
            // corners and drop that edge of the selection ring
            // (`.block-run-*`, block-editor.css) so the run reads as ONE
            // outlined surface, rounded and closed only at its ends (the
            // editor computes which neighbours actually touch — heading top
            // margins break a run). Nested rows sit 4px apart: 4+4 overlaps
            // seamlessly (same solid fill, same solid side lines); root rows
            // sit 6px apart: 4+4 still overlaps 2px, so runs merge at every
            // level.
            runEdges?.top ? "-mt-1 pt-1 rounded-t-none block-run-top" : "-mt-0.5 pt-0.5",
            runEdges?.bottom ? "-mb-1 pb-1 rounded-b-none block-run-bottom" : "-mb-0.5 pb-0.5",
            // bg-bg-secondary is the structural "selected" hook (tests query
            // it); .block-highlight draws the accent ring and faint wash over
            // it so selection reads as selected, not hovered.
            selected && "bg-bg-secondary block-highlight",
            // When the editor doesn't own the keyboard (focus is in the
            // sidebar, a dialog, the ⌘K palette), the selection
            // demotes to a quiet neutral — additive class only, so the
            // structural hooks above are untouched.
            selected && !api.keyboardActive && "block-highlight-inactive",
            // A quiet neutral hover marks the row as interactive (see
            // .block-hoverable); never while inert (a read-only row that
            // neither opens something — `api.activate` — nor is browsed) or
            // already editing, and selection (accent) always wins because
            // the class is simply absent on selected rows.
            (!readOnly || api.navigable) && !editing && !selected && "block-hoverable",
            // An unmatched ancestor in a filtered view: quietened so the
            // matches stand out, never hidden — it is what says where the
            // match lives. Additive only, and dropped while the row is
            // edited or selected, so working on it is never done through a
            // veil.
            dimmed && !editing && !selected && "opacity-55",
          )}
        >
          {chevronColumn}
          {marker}
          {kind.before?.(rowContext)}
          {kind.wrap ? kind.wrap(content, rowContext) : content}
          {api.debug?.showIds ? <BlockIdBadge id={block.id} /> : null}
        </div>
        {api.debug?.showMetadata ? (
          <BlockDebugMeta
            block={block}
            depth={depth}
            upstream={api.debug.upstreamOf ? api.debug.upstreamOf(block.id) : null}
          />
        ) : null}
      </div>
    </div>
  )
}

// ── Developer-mode readouts ───────────────────────────────────────────────

/** The block's id, in the row's far right. Clicking copies it; the mousedown
 * is swallowed so a click never blurs a textarea being edited beside it. */
function BlockIdBadge({ id }: { id: string }) {
  return (
    <button
      type="button"
      data-testid="block-debug-id"
      title="Copy block id"
      tabIndex={-1}
      onMouseDown={(event) => event.preventDefault()}
      onClick={(event) => {
        event.stopPropagation()
        void navigator.clipboard?.writeText(id).catch(() => {})
      }}
      className="ml-auto shrink-0 select-none self-start rounded px-1 font-mono text-[11px] leading-relaxed text-text-tertiary hover:bg-bg-hover hover:text-text-secondary"
    >
      {id}
    </button>
  )
}

/**
 * The block's graph metadata: its derived type, outline depth, how many
 * blocks are downstream (direct children), and — when the corpus lookup is
 * wired — the notes upstream of it. `upstream 2` is the tell that a paste
 * really linked the node rather than duplicating its text; nothing upstream
 * means the block has not been saved yet (the corpus file lags the editor by
 * the autosave debounce).
 */
function BlockDebugMeta({
  block,
  depth,
  upstream,
}: {
  block: Block
  depth: number
  upstream: readonly string[] | null
}) {
  const kind = block.type
  let upstreamLabel: string | null = null
  if (upstream !== null) {
    if (upstream.length === 0) upstreamLabel = "upstream 0 · not saved yet"
    else upstreamLabel = `upstream ${upstream.length} · ${upstream.join(", ")}`
  }
  return (
    <div
      data-testid="block-debug-meta"
      className="mb-1 flex select-none flex-wrap gap-x-3 pl-1 font-mono text-[11px] leading-4 text-text-tertiary"
    >
      <span>{kind}</span>
      <span>depth {depth}</span>
      <span>downstream {block.children.length}</span>
      {upstreamLabel !== null ? (
        <span className={upstream && upstream.length > 1 ? "text-text-secondary" : undefined}>
          {upstreamLabel}
        </span>
      ) : null}
    </div>
  )
}
