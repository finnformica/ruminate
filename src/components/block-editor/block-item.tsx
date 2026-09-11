import type React from "react"
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import type { ChangeEvent, ClipboardEvent, CSSProperties, KeyboardEvent } from "react"
import { cx } from "../../utils/cx"
import type { Block, BlockDoc } from "../../blocks/types"
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
import { IconButton } from "../icon-button"
import { BlockContent } from "./block-content"
import { headingScale, kindOf, type RowContext } from "./block-kinds"
import { caretCoordinates, caretLineFlags } from "./caret"
import { Hash } from "./hash"
import { SLASH_MENU_WIDTH, SlashMenu } from "./slash-menu"

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
   * Whether the editor owns the keyboard (focus is inside its container).
   * While false, selected rows demote to the quiet inactive-selection surface
   * (`.block-highlight-inactive`) so the highlight never claims a keyboard it
   * doesn't have. Always true in read-only views (their highlight is display
   * state, not a keyboard cursor).
   */
  keyboardActive: boolean
  /** Highlight a row (leaves edit mode, collapses any multi-selection). */
  select: (key: string) => void
  /** Enter edit mode on a row. */
  edit: (key: string, atStart?: boolean) => void
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
  /** Zoom into a block: its subtree becomes the whole editor view. */
  zoomInto: (id: string) => void
  /** Image files pasted or dropped on a row: upload them and add image blocks
   * there. Absent where images are switched off (the paste is left alone). */
  onImageFiles?: (key: string, files: File[]) => void
  /** Open the file picker for an image to add at this row (the slash menu's
   * "Image"). Absent where images are switched off. */
  requestImage?: (key: string) => void
  /** Expand an image block's picture (the lightbox). */
  openImage?: (id: string) => void
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
   * The notes upstream of the block — the pages that reach it through child
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

/** Row geometry, in px. Each level indents by `INDENT`: the guide line hangs
 * from the parent's key — a 1px rule under the centre of the 15px marker
 * slot, which starts 4px into the content column (the highlight surface's
 * -2px reach + 6px inner padding) — so the rule sits at `GUIDE_X`, and the
 * child's content starts `INDENT` in (rule + 12px of padding). */
const INDENT = 24
const GUIDE_X = 11
/** Root rows sit 2px further apart than nested ones (which meet at their
 * 2px + 2px vertical padding). */
const ROOT_GAP = 2

export function BlockItem({
  doc,
  block,
  occurrence,
  api,
  animateIn = false,
  folding = false,
}: {
  doc: BlockDoc
  block: Block
  /** This row's place in the view (`src/blocks/view.ts`): its depth, fold,
   * ordered number, guide lines — and whether it is the zoomed view's title
   * (promoted typography, no toggle; its children follow it at depth 0). */
  occurrence: Occurrence
  api: BlockEditorApi
  /** Mounting as a just-revealed row: unfold beneath the parent. */
  animateIn?: boolean
  /** A row on its way out — its parent just folded — kept for the length
   * of the fold animation only. Inert: no selection, no pointer, no row
   * identity (`data-block-row` / `data-occurrence`), so nothing addresses
   * it as a live row. */
  folding?: boolean
}) {
  const { depth, zoomTitle, olNumber, hasChildren, collapsed: isCollapsed } = occurrence
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

  // A row revealed by unfolding its parent unfolds beneath it. Captured at
  // mount so the class stays for the row's lifetime — an animation that is
  // never cut short by a re-render, and never replayed. A fold the other way
  // (`folding`) takes precedence: a row can be sent away mid-unfold.
  const [entrance] = useState(animateIn)

  const type = block.type
  // The block's text is marker-free by construction: its type is drawn as a
  // real bullet/checkbox/heading style in the marker slot, never as text. This
  // keeps the view and the editor pixel-identical — nothing shifts on click.
  const body = block.text
  // The zoomed block leads the view but renders as ITSELF — same typography,
  // same marker as anywhere else in the outline (a bullet stays a bullet, a
  // heading a heading). Focus mode changes what is visible, never what a
  // block looks like.
  // How this type looks (`block-kinds.tsx`): its marker, typography, any
  // panel, and the chrome around the content line.
  const kind = kindOf(type)
  const typo = kind.typography(depth, block)
  // A panel (a code block's) carries the same classes on the rendered view
  // and the textarea, so editing never moves a character.
  const panel = kind.panel ?? null
  const rowContext: RowContext = { block, occurrence, api, depth, editing }

  // Focus and place the caret when editing starts.
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
  }, [editing, api.focus?.atStart, api.focus?.caret])

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
    const typed = leadingMarker(newBody)
    const text = typed !== null ? typed.text : newBody
    if (typed !== null) {
      // The marker left the visible text; keep the caret relative to it.
      pendingCaret.current = Math.max(0, caret - (newBody.length - text.length))
      api.onBlockChange(block.id, { type: typed.type, text })
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

  // Whether this block owns a collapse toggle at all: parents only, and never
  // the zoom title (the editor renders its children itself, at depth 0). The
  // row that closes a loop keeps its chevron too — the block has children,
  // they are simply above it — pinned, greyed and inert, with the reason in
  // its tooltip (zoom in to go round again).
  const looped = !!occurrence.looped
  const hasToggle = (hasChildren || looped) && !zoomTitle
  const pinned = isCollapsed || looped
  // Every block type but an image owns the 15px marker slot. Most carry a KEY there — a
  // bullet dot, heading `#`, number, quote `>` — and the key is pure chrome,
  // so on a parent it SWAPS for the chevron: hover the slot and the key fades
  // out while the chevron fades in, in the same slot — nothing moves. A
  // paragraph's slot is empty (its text still starts in the shared column).
  // A todo's slot holds its checkbox — a control, which never swaps out (that
  // would leave a parent todo un-tickable) — so a parent todo's chevron sits
  // BESIDE the slot instead, in the gutter just outside the highlight
  // surface: same reveal (hover its own square), same pin while collapsed.
  const toggleBeside = hasToggle && !!kind.toggleBeside

  // The chevron. `.block-toggle` (block-editor.css) keeps it invisible until
  // its own square — the key slot, or the gutter square beside a todo; never
  // the whole row — is hovered (or, on a device with nothing to hover with,
  // always) —
  // except on a COLLAPSED block, which pins it visible so hidden content is
  // never a secret. It floats out of the flow, centred on whatever slot holds
  // it, so the reveal never shifts the text. Centred by its own midpoint
  // (left/top 50% + a half-size translate), NOT by `inset-0 m-auto`: the
  // 20px square is wider than the 15px slot, and an over-constrained absolute
  // box drops its left margin to zero instead of going negative — which
  // left-aligned the square and put the chevron 4.5px right of the guide.
  // Press feedback lives on the control (IconButton supplies the hover
  // surface); the content itself never animates on collapse.
  //
  // The square is 20px everywhere so it sits an even ~3.5px inside the
  // highlight surface on every side it touches: the surface is 27px tall
  // (a 23px line + 2px each side) and the key slot's centre is 13.5px in
  // from its left edge (2px reach + 6px padding + half of 15px) — the same
  // distance as the surface's vertical centre, so the square inset matches
  // horizontally and vertically. Beside a todo the same square straddles the
  // surface's left edge, its glyph tucked just outside it.
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
      onClick={looped ? undefined : () => api.toggleCollapse(occurrence.key)}
      className={cx(
        "block-toggle absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 shrink-0 p-0 text-text-tertiary transition-[opacity,transform] duration-150",
        looped
          ? "cursor-not-allowed enabled:hover:bg-transparent enabled:active:bg-transparent"
          : "active:scale-[0.92] motion-reduce:active:scale-100",
        // IconButton's default radius is the 8px base — on a 20px square that
        // reads as a pill. The small radius (4px) keeps it a square.
        "rounded-sm",
        // Coarse pointers get a 28px square to tap instead of IconButton's
        // 40px-tall padded bar (which would overlap neighbouring rows and
        // squeeze the glyph); it still sits inside the surface.
        "h-5 w-5 coarse:h-7 coarse:w-7 coarse:px-0",
        // Beside a todo the square is a hit area only — no hover surface, so
        // it never clashes with the checkbox or the highlight it straddles;
        // the chevron's own fade-in is the whole reveal. It stays 20px wide
        // on coarse pointers too: 28px would reach the checkbox.
        toggleBeside && "enabled:hover:bg-transparent enabled:active:bg-transparent coarse:w-5",
        pinned && "block-toggle-pinned",
      )}
    >
      <svg
        width="8"
        height="8"
        viewBox="0 0 8 8"
        aria-hidden
        className={cx(
          // A quarter turn with a small overshoot that settles — the spring
          // (variables.css) — long enough to read as a turn, not a swap.
          "transition-transform duration-300 ease-[var(--ease-spring)] motion-reduce:transition-none",
          isCollapsed || looped ? "rotate-0" : "rotate-90",
        )}
      >
        {/* A filled triangle with softened corners: the fill plus a round-
            joined stroke of the same ink, which rounds the three points. */}
        <path
          d="M2.6 1.6l3.2 2.4-3.2 2.4z"
          fill="currentColor"
          stroke="currentColor"
          strokeWidth="1.2"
          strokeLinejoin="round"
        />
      </svg>
    </IconButton>
  ) : null
  // The key of a swapping parent: fades out as the chevron fades in, and is
  // hidden outright while collapsed (the pinned chevron stands in for it).
  const keyClass = hasToggle ? cx("block-key", pinned && "block-key-hidden") : undefined
  // The slot of a swapping parent is the chevron's hover area (see
  // `.block-toggle-slot` in block-editor.css). Not a todo's: its chevron is
  // beside, and hovering the checkbox must mean the checkbox.
  const slotClass = hasToggle && !toggleBeside ? "block-toggle-slot" : undefined

  // List markers double as zoom targets (Logseq-style: click the bullet to
  // make this block the page) — on leaves. A parent's key is its collapse
  // toggle, so zoom stays on F / Cmd+. there. The negative-margin padding
  // enlarges the hit area without shifting the marker's layout size.
  const zoomable = !readOnly && !zoomTitle && !hasToggle
  // Every marker occupies the same 15px slot, so body text starts at one
  // column across every block type and the markers read as one chrome
  // family: dots centre in it; text glyphs (`#`, number, `>`) right-align
  // to its edge; a paragraph's slot is simply empty. Each slot is `relative`
  // so a swapped-in chevron centres on it, and carries `slotClass` so
  // hovering it reveals the chevron.
  //
  // The bullet's dot: on a leaf it zooms; on a parent it is the key that
  // swaps for the chevron.
  const dotSlot = (
    <span
      className={cx(
        "relative flex h-[1lh] w-[15px] shrink-0 items-center justify-center",
        slotClass,
      )}
    >
      {zoomable ? (
        <button
          type="button"
          aria-label="Zoom into block"
          tabIndex={-1}
          onClick={() => api.zoomInto(block.id)}
          className="-m-1.5 flex cursor-pointer items-center justify-center rounded-full p-1.5 transition-[background-color,transform] duration-150 hover:bg-bg-secondary active:scale-90 motion-reduce:active:scale-100"
        >
          {/* Faint, like the chevron — pure chrome; content leads. */}
          <span aria-hidden className="block-glyph-fill size-1.5 rounded-full bg-text-tertiary" />
        </button>
      ) : (
        <span
          aria-hidden
          className={cx("block-glyph-fill size-1.5 rounded-full bg-text-tertiary", keyClass)}
        />
      )}
      {toggle}
    </span>
  )
  // A static text glyph key (the quote's `>`) or none at all (a paragraph):
  // faint, like the dot and the `#` — chrome, not content. CENTRED in the
  // slot, like the dot and the checkbox, not right-aligned like `#` and the
  // numbers: `>` is a narrow glyph, and right-aligned its ink sat 3px right
  // of the dot's centre (and of the guide line that hangs from it). Never a
  // zoom button (zoom stays on F / Cmd+. and bullet/number clicks); on a
  // parent it swaps for the collapse chevron. The empty paragraph slot keeps
  // its width so the text stays in the shared column, and still hosts a
  // parent's chevron.
  const glyphSlot = (glyph: string | null, testId: string) => (
    <span
      data-testid={testId}
      className={cx(
        "relative flex h-[1lh] w-[15px] shrink-0 items-center justify-center",
        slotClass,
      )}
    >
      {glyph ? (
        <span aria-hidden className={cx("block-glyph select-none text-text-tertiary", keyClass)}>
          {glyph}
        </span>
      ) : null}
      {toggle}
    </span>
  )
  // An image (`slot: "none"`) has no slot at all: the row's content starts at
  // its edge. A parent still needs somewhere to put its chevron, so it falls
  // through to the empty glyph slot.
  const marker =
    kind.slot === "none" && !hasToggle ? null : kind.slot === "checkbox" ? (
      // The checkbox IS the todo's marker — a control in the key slot, which
      // is why a parent todo's chevron sits beside it (see `toggleBeside`).
      // Hovering the box also reveals that chevron (`.block-toggle-hint`,
      // block-editor.css) — the marker is where people look for the fold
      // control — without the box ever giving up its own click. On coarse
      // pointers the box grows its own tap area (`.block-checkbox::before`).
      <span
        className={cx(
          "flex h-[1lh] w-[15px] shrink-0 items-center justify-center",
          toggleBeside && "block-toggle-hint",
        )}
      >
        <input
          type="checkbox"
          checked={type === "done"}
          disabled={readOnly}
          onClick={(event) => event.stopPropagation()}
          // Checked is a TYPE (docs/graph-schema-v2.md): ticking is `todo` ↔ `done`.
          onChange={() => api.onBlockChange(block.id, { type: type === "done" ? "todo" : "done" })}
          className={cx("block-checkbox", readOnly ? "cursor-default" : "cursor-pointer")}
        />
      </span>
    ) : kind.slot === "dot" ? (
      dotSlot
    ) : kind.slot === "hash" ? (
      // Headings hang the same grey `#` as the note / zoom titles — the shared
      // `Hash`, at the heading's own scale: the slot carries the heading's
      // size + weight (headingScale + bold, no underline — that lives in
      // `typo`) and the glyph inherits it, so the hash always matches the text
      // beside it, at every depth. The slot stays the shared 15px column
      // (heading text aligns with every other marked block); the hash
      // right-aligns in it and, when a large scale outgrows the slot,
      // overflows LEFT, past the surface's edge — the text column never
      // moves. The slot's `h-[1lh]` (resolved at the heading's scale) centres
      // the glyph on the heading's first line. A static glyph, like the note
      // title's — never a zoom button (zoom stays on F / Cmd+. and
      // bullet/number clicks); on a parent it swaps for the collapse chevron.
      <span
        data-testid="heading-hash"
        className={cx(
          "relative flex h-[1lh] w-[15px] shrink-0 items-center justify-end font-bold",
          headingScale(depth),
          slotClass,
        )}
      >
        <Hash className={keyClass} />
        {toggle}
      </span>
    ) : kind.slot === "number" ? (
      // Numbers are read (they carry order), so they sit one step up the ramp
      // from the dot — muted, not faint — and right-align to the slot edge.
      <span
        className={cx(
          "block-glyph relative flex h-[1lh] min-w-[15px] shrink-0 items-center justify-end tabular-nums text-text-secondary",
          slotClass,
        )}
      >
        {zoomable ? (
          <button
            type="button"
            aria-label="Zoom into block"
            tabIndex={-1}
            onClick={() => api.zoomInto(block.id)}
            className="-mx-0.5 cursor-pointer rounded-sm px-0.5 transition-[background-color,transform] duration-150 hover:bg-bg-secondary active:scale-95 motion-reduce:active:scale-100"
          >
            {olNumber}.
          </button>
        ) : (
          <span aria-hidden className={keyClass}>
            {olNumber}.
          </span>
        )}
        {toggle}
      </span>
    ) : (
      glyphSlot(kind.glyph ?? null, kind.slotTestId ?? "paragraph-slot")
    )

  // The wrapper: indented by depth, carrying the guide lines of every row it
  // sits under. A heading's breathing room is a margin, so the highlight
  // surface never grows; the guides reach back up through it (`top`), so a
  // parent's line runs unbroken beside its subtree.
  const marginTop = zoomTitle
    ? 0
    : Math.max(kind.topMargin?.(depth) ?? 0, depth === 0 && occurrence.index > 0 ? ROOT_GAP : 0)

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
        // The zoom title is a page title, not a block — no ghost.
        placeholder={zoomTitle ? undefined : (kind.placeholder ?? "Ruminate…")}
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
        onBlur={() => api.setFocus(null)}
        className={cx(
          "min-w-0 flex-1 resize-none overflow-hidden font-content leading-relaxed text-text outline-none [overflow-wrap:anywhere] placeholder:text-text-tertiary",
          // The panel supplies a code block's surface and padding.
          panel ?? "border-none bg-transparent p-0",
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
    // holds focus); this element only needs the pointer interactions.
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions
    <div
      data-testid="block-body"
      data-block-id={block.id}
      className={cx(
        // A long link or an unbroken word breaks rather than running
        // off a narrow screen (the textarea wraps the same way).
        // pre-wrap: the text shows exactly as stored (newlines, runs
        // of spaces, a leading tab), as the textarea shows it.
        "min-h-[1lh] min-w-0 flex-1 whitespace-pre-wrap outline-none [overflow-wrap:anywhere]",
        !readOnly && "cursor-text",
        readOnly && api.activate && "cursor-pointer",
        typo,
        panel,
        kind.bodyClass,
      )}
      {...(readOnly
        ? api.activate
          ? { onClick: () => api.activate?.(occurrence.key) }
          : {}
        : {
            onClick: () => api.select(occurrence.key),
            onDoubleClick: () => api.edit(occurrence.key),
          })}
    >
      {kind.verbatim ? body : <BlockContent content={body} />}
    </div>
  )

  return (
    <div
      data-block-row={folding ? undefined : block.id}
      data-occurrence={folding ? undefined : occurrence.key}
      data-folding={folding || undefined}
      aria-hidden={folding || undefined}
      className={cx(
        "relative",
        zoomTitle && "mb-3",
        // The fold (block-editor.css): the row's own height runs 0 ↔ full.
        folding ? "block-fold-close" : entrance && "block-fold-open",
      )}
      style={{ paddingLeft: depth * INDENT, marginTop }}
    >
      {occurrence.guideKeys.map((guideKey, level) => (
        <span
          key={guideKey}
          aria-hidden
          data-guide={guideKey}
          className="block-guide pointer-events-none absolute bottom-0 w-px bg-border-secondary transition-colors duration-200"
          style={{ left: GUIDE_X + level * INDENT, top: -marginTop }}
        />
      ))}
      <div className="block-row-body relative min-w-0 py-0.5 font-content leading-relaxed">
        <div
          // The visible content line (carries the highlight). Scroll-into-view
          // targets this, not the row wrapper, so a heading's top margin can't
          // distort where the highlight lands.
          data-block-line
          // A heading's surface reaches further left at the larger scales
          // (`[data-heading-scale]` in block-editor.css), so its chevron and
          // `#` sit as far from the left edge as from the top and bottom.
          data-heading-scale={kind.slot === "hash" ? HEADING_SCALE_NAMES[depth] : undefined}
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
            "relative -ml-0.5 -mr-0.5 flex items-start gap-2 rounded pl-1.5 pr-1.5",
            // Per-side vertical pairs. Mid-run sides also square their
            // corners so the run reads as ONE surface rounded only at its
            // ends (the editor computes which neighbours actually touch —
            // heading top margins break a run). Nested rows sit 4px apart:
            // 4+4 overlaps seamlessly (same solid); root rows sit 6px
            // apart: 4+4 still overlaps 2px, so runs merge at every level.
            runEdges?.top ? "-mt-1 pt-1 rounded-t-none" : "-mt-0.5 pt-0.5",
            runEdges?.bottom ? "-mb-1 pb-1 rounded-b-none" : "-mb-0.5 pb-0.5",
            // bg-bg-secondary is the structural "selected" hook (tests query
            // it); .block-highlight paints the solid accent surface over it
            // so selection reads as selected, not hovered.
            selected && "bg-bg-secondary block-highlight",
            // When the editor doesn't own the keyboard (focus is in the
            // sidebar, a dialog, the ⌘P palette mid-preview), the selection
            // demotes to a quiet neutral — additive class only, so the
            // structural hooks above are untouched.
            selected && !api.keyboardActive && "block-highlight-inactive",
            // A quiet neutral hover marks the row as interactive (see
            // .block-hoverable); never while read-only (unless the row opens
            // something — `api.activate`) or already editing, and selection
            // (accent) always wins because the class is simply absent on
            // selected rows.
            (!readOnly || api.activate) && !editing && !selected && "block-hoverable",
          )}
        >
          {marker}
          {toggleBeside ? (
            // The beside toggle: a 20px slot (the chevron's square) centred
            // 5px OUTSIDE the surface's left edge, on the block's first line,
            // so the glyph hugs the block: its ink sits ~3px off the edge and
            // stops short of the checkbox (the slot ends 1px before it).
            // Nested, that keeps it clear of the parent's guide line, which
            // runs 11px outside the edge — the glyph's ink ends ≥2.5px right
            // of it, so the two never touch. `typo` + h-[1lh] size the slot
            // to that line whatever the scale; the top offset mirrors the
            // line's own vertical padding. It FOLLOWS the marker in the DOM
            // (position is absolute, so order is invisible) so the checkbox
            // slot's hover can reach it with a sibling selector.
            <span
              className={cx(
                "block-toggle-beside absolute -left-[15px] h-[1lh] w-5",
                runEdges?.top ? "top-1" : "top-0.5",
                typo,
              )}
            >
              {toggle}
            </span>
          ) : null}
          {kind.before?.(rowContext)}
          {kind.wrap ? kind.wrap(content, rowContext) : content}
          {kind.after?.(rowContext)}
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
      className="ml-auto shrink-0 select-none self-start rounded px-1 font-mono text-[11px] leading-relaxed text-text-tertiary hover:bg-bg-secondary hover:text-text-secondary"
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
