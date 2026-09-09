import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import type { ChangeEvent, ClipboardEvent, CSSProperties, KeyboardEvent } from "react"
import { cx } from "../../utils/cx"
import type { Block, BlockDoc } from "../../blocks/types"
import {
  getBlockType,
  leadingMarker,
  stripMarker,
  toggleTodo,
  type BlockType,
} from "../../blocks/block-type"
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
import { IconButton } from "../icon-button"
import { BlockContent } from "./block-content"
import { caretCoordinates, caretLineFlags } from "./caret"
import { Hash } from "./hash"
import { SLASH_MENU_WIDTH, SlashMenu } from "./slash-menu"

export interface FocusRequest {
  id: string
  atStart?: boolean
  /** Explicit caret offset; overrides `atStart` when set. */
  caret?: number
}

export interface BlockEditorApi {
  focus: FocusRequest | null
  /** The head of the selection in select mode (null while editing/unfocused). */
  selected: string | null
  /** All highlighted block ids (a Shift+Arrow range, or just the head). */
  selectedSet: Set<string>
  /**
   * For each block in a multi-selection whose highlight surface touches a
   * selected neighbour, which of its corners (top/bottom) should go straight
   * so the run reads as one continuous surface. Empty for single selections.
   */
  selectionRunEdges: Map<string, { top: boolean; bottom: boolean }>
  collapsed: Set<string>
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
  /** Highlight a block (leaves edit mode, collapses any multi-selection). */
  select: (id: string) => void
  /** Enter edit mode for a block. */
  edit: (id: string, atStart?: boolean) => void
  toggleCollapse: (id: string) => void
  setFocus: (focus: FocusRequest | null) => void
  /**
   * Replace a block's content. Text edits coalesce into one undo step; pass
   * `"structural"` for a change that must stand alone (a slash-menu pick, so
   * one undo puts the typed `/phrase` back).
   */
  onContentChange: (id: string, content: string, op?: "text" | "structural") => void
  /** Replace `id` with blocks parsed from pasted markdown, placing the caret. */
  onPaste: (id: string, prefix: string, before: string, pasted: string, after: string) => void
  /**
   * Resolve a key event to an editor command (via the keymap) and run it.
   * Every keyboard interaction funnels through here; returns whether the event
   * was consumed (so the caller can `preventDefault`).
   */
  dispatchKey: (mode: Mode, id: string, event: KeyLike, caret?: CaretInput) => boolean
  /** Zoom into a block: its subtree becomes the whole editor view. */
  zoomInto: (id: string) => void
  /**
   * Exit edit mode and take the first selection-ladder rung on this block
   * (Cmd/Ctrl+A pressed with the textarea's text already fully selected).
   */
  startSelectionLadder: (id: string) => void
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

/** Extra space above a heading, proportional to its size (i.e. its outline
 * depth), so sections breathe. Applied to the block's outer wrapper (shared by
 * view and edit) so switching modes never shifts the text. */
function headingTopMargin(type: BlockType, depth: number): string {
  if (type.kind !== "heading") return ""
  switch (depth) {
    case 0:
      return "mt-5"
    case 1:
      return "mt-4"
    case 2:
      return "mt-2.5"
    default:
      return "mt-1.5"
  }
}

/** A heading's font size + line-height by outline depth. Shared by the full
 * typography (`typographyFor`) and the heading's `#` marker slot, whose
 * `h-[1lh]` must resolve against the same first-line height to centre on it. */
function headingScale(depth: number): string {
  switch (depth) {
    case 0:
      return "text-2xl leading-tight"
    case 1:
      return "text-xl leading-tight"
    case 2:
      return "text-lg leading-snug"
    default:
      return "text-base leading-relaxed"
  }
}

/**
 * Typography shared by a block's rendered view and its edit textarea, so
 * switching between them never changes the text's size or weight.
 *
 * Headings are sized by how deeply they're nested in the outline — not by how
 * many `#`s were typed (the marker is normalised to a single `#` on save). The
 * deepest level floors at body size, kept bold and underlined so it still reads
 * as a heading rather than a paragraph.
 */
function typographyFor(type: BlockType, depth: number): string {
  switch (type.kind) {
    case "heading":
      // Headings tighten as they grow: large display sizes get a snugger
      // line-height and slightly negative tracking (see the type scale in
      // docs/design-principles.md).
      switch (depth) {
        case 0:
          return cx(headingScale(0), "font-bold tracking-[-0.015em]")
        case 1:
          return cx(headingScale(1), "font-bold tracking-[-0.01em]")
        case 2:
          return cx(headingScale(2), "font-bold")
        default:
          // Floors at body size; a soft offset underline keeps it reading as a
          // heading without the weight of a full text-color rule.
          return cx(
            headingScale(depth),
            "font-bold underline decoration-[color:var(--neutral-a6)] decoration-2 underline-offset-4",
          )
      }
    case "quote":
      return "text-base leading-relaxed text-text-secondary"
    default:
      return "text-base leading-relaxed"
  }
}

export function BlockItem({
  doc,
  block,
  depth,
  api,
  zoomTitle = false,
}: {
  doc: BlockDoc
  block: Block
  depth: number
  api: BlockEditorApi
  /** Render as the zoomed view's title: promoted typography, no collapse
   * toggle, and no children (the editor renders those itself at depth 0). */
  zoomTitle?: boolean
}) {
  const readOnly = api.readOnly ?? false
  const editing = !readOnly && api.focus?.id === block.id
  const selected = api.selectedSet.has(block.id) && !editing
  // Which sides of this row sit MID-RUN in a multi-select (the adjacent
  // visible row is also selected and the surfaces touch) — those sides keep
  // the full 4px vertical extension so the run merges seamlessly; every other
  // side extends only 2px (see the data-block-line classes below).
  const runEdges = selected ? api.selectionRunEdges.get(block.id) : undefined
  const hasChildren = block.children.length > 0
  const isCollapsed = api.collapsed.has(block.id)
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
    () => (slashQuery === undefined ? [] : slashMenuItems(slashQuery, new Date())),
    [slashQuery],
  )

  // True only on the render where the block goes collapsed → open, so the
  // revealed children play their brief entrance (never on initial mount).
  const prevCollapsedRef = useRef(isCollapsed)
  const justExpanded = prevCollapsedRef.current && !isCollapsed
  useEffect(() => {
    prevCollapsedRef.current = isCollapsed
  }, [isCollapsed])

  const type = getBlockType(block.content)
  // The block is edited and rendered *without* its marker (the `- `, `# `,
  // `[ ] `, `> `), which is shown as a real bullet/checkbox/heading style. This
  // keeps the view and the editor pixel-identical — nothing shifts on click.
  const body = stripMarker(block.content)
  const prefix = block.content.slice(0, block.content.length - body.length)
  // The zoomed block leads the view but renders as ITSELF — same typography,
  // same marker as anywhere else in the outline (a bullet stays a bullet, a
  // heading a heading). Focus mode changes what is visible, never what a
  // block looks like.
  const typo = typographyFor(type, depth)

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
  }, [editing, block.content])

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
  }, [slashOpen, slashStart, block.content])

  const pickSlashItem = (item: SlashItem) => {
    const el = textareaRef.current
    if (!el || !slash) return
    const result = applySlashItem(block.content, el.value, slash.trigger, item)
    pendingCaret.current = result.caret
    dismissedSlash.current = null
    setSlash(null)
    // Its own undo step, so Cmd/Ctrl+Z puts the typed `/phrase` back.
    api.onContentChange(block.id, result.content, "structural")
  }

  const handleTextareaChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    const el = event.currentTarget
    const newBody = el.value
    const caret = el.selectionStart
    // A marker typed at the very start of the body switches the block's type,
    // *replacing* any current marker (checkbox → `- ` becomes a bullet, → `1. `
    // an ordered item, → `# ` a heading, and so on). Otherwise the block keeps
    // its existing marker and the edit is to its text.
    const typed = leadingMarker(newBody)
    const newContent = typed !== null ? newBody : prefix + newBody
    const derivedBody = stripMarker(newContent)
    if (derivedBody.length !== newBody.length) {
      // A marker moved into (or out of) the prefix; keep the caret relative to
      // the visible text.
      pendingCaret.current = Math.max(0, caret - (newBody.length - derivedBody.length))
    }
    api.onContentChange(block.id, newContent)
    syncSlash(derivedBody, pendingCaret.current ?? caret)
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
        api.startSelectionLadder(block.id)
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
    if (api.dispatchKey("edit", block.id, event, caret)) event.preventDefault()
  }

  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const plain = plainPaste.current
    plainPaste.current = false
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
      api.onContentChange(block.id, prefix + before + collapsed + after)
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
      api.onContentChange(block.id, prefix + before + pasted + after)
      return
    }
    // Multi-line paste is spread across blocks.
    event.preventDefault()
    const el = event.currentTarget
    const before = el.value.slice(0, el.selectionStart)
    const after = el.value.slice(el.selectionEnd)
    api.onPaste(block.id, prefix, before, pasted, after)
  }

  // Whether this block owns a collapse toggle at all: parents only, and never
  // the zoom title (the editor renders its children itself, at depth 0).
  const hasToggle = hasChildren && !zoomTitle
  // Every block type owns the 15px marker slot. Most carry a KEY there — a
  // bullet dot, heading `#`, number, quote `>` — and the key is pure chrome,
  // so on a parent it SWAPS for the chevron: hover the slot and the key fades
  // out while the chevron fades in, in the same slot — nothing moves. A
  // paragraph's slot is empty (its text still starts in the shared column).
  // A todo's slot holds its checkbox — a control, which never swaps out (that
  // would leave a parent todo un-tickable) — so a parent todo's chevron sits
  // BESIDE the slot instead, in the gutter just outside the highlight
  // surface: same reveal (hover its own square), same pin while collapsed.
  const toggleBeside = hasToggle && type.kind === "todo"

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
  // horizontally and vertically. Beside a todo the same square hangs outside
  // the surface, its right edge on the surface's left edge.
  const toggle = hasToggle ? (
    <IconButton
      aria-label={isCollapsed ? "Expand" : "Collapse"}
      size="small"
      disableTooltip
      tabIndex={-1}
      onClick={() => api.toggleCollapse(block.id)}
      className={cx(
        "block-toggle absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 shrink-0 p-0 text-text-tertiary transition-[opacity,transform] duration-150 active:scale-[0.92] motion-reduce:active:scale-100",
        // IconButton's default radius is the 8px base — on a 20px square that
        // reads as a pill. The small radius (4px) keeps it a square.
        "rounded-sm",
        // Coarse pointers get a 28px square to tap instead of IconButton's
        // 40px-tall padded bar (which would overlap neighbouring rows and
        // squeeze the glyph); it still sits inside the surface.
        "h-5 w-5 coarse:h-7 coarse:w-7 coarse:px-0",
        // Beside a todo the square is a hit area only — no hover surface, so
        // it never clashes with the checkbox, the highlight or a guide line
        // it sits on; the chevron's own fade-in is the whole reveal.
        toggleBeside && "enabled:hover:bg-transparent enabled:active:bg-transparent",
        isCollapsed && "block-toggle-pinned",
      )}
    >
      <svg
        width="8"
        height="8"
        viewBox="0 0 8 8"
        aria-hidden
        className={cx(
          "transition-transform duration-200 ease-[var(--ease-out-strong)] motion-reduce:transition-none",
          isCollapsed ? "rotate-0" : "rotate-90",
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
  const keyClass = hasToggle ? cx("block-key", isCollapsed && "block-key-hidden") : undefined
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
          <span aria-hidden className="size-1.5 rounded-full bg-text-tertiary" />
        </button>
      ) : (
        <span aria-hidden className={cx("size-1.5 rounded-full bg-text-tertiary", keyClass)} />
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
        <span aria-hidden className={cx("select-none text-text-tertiary", keyClass)}>
          {glyph}
        </span>
      ) : null}
      {toggle}
    </span>
  )
  const marker =
    type.kind === "todo" ? (
      // The checkbox IS the todo's marker — a control in the key slot, which
      // is why a parent todo's chevron sits beside it (see `toggleBeside`).
      // On coarse pointers the box grows its own tap area
      // (`.block-checkbox::before`, block-editor.css).
      <span className="flex h-[1lh] w-[15px] shrink-0 items-center justify-center">
        <input
          type="checkbox"
          checked={type.checked}
          disabled={readOnly}
          onClick={(event) => event.stopPropagation()}
          onChange={() => api.onContentChange(block.id, toggleTodo(block.content))}
          className={cx("block-checkbox", readOnly ? "cursor-default" : "cursor-pointer")}
        />
      </span>
    ) : type.kind === "bullet" ? (
      dotSlot
    ) : type.kind === "heading" ? (
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
    ) : type.kind === "ordered" ? (
      // Numbers are read (they carry order), so they sit one step up the ramp
      // from the dot — muted, not faint — and right-align to the slot edge.
      <span
        className={cx(
          "relative flex h-[1lh] min-w-[15px] shrink-0 items-center justify-end tabular-nums text-text-secondary",
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
            {type.number}.
          </button>
        ) : (
          <span aria-hidden className={keyClass}>
            {type.number}.
          </span>
        )}
        {toggle}
      </span>
    ) : type.kind === "quote" ? (
      glyphSlot(">", "quote-glyph")
    ) : (
      glyphSlot(null, "paragraph-slot")
    )

  return (
    <div
      data-block-row={block.id}
      className={cx("group/subtree", zoomTitle ? "mb-3" : headingTopMargin(type, depth))}
    >
      <div className="relative min-w-0 py-0.5 font-content leading-relaxed">
        <div
          // The visible content line (carries the highlight). Scroll-into-view
          // targets this, not the row wrapper, so a heading's top margin can't
          // distort where the highlight lands.
          data-block-line
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
            // .block-hoverable); never while read-only or already editing,
            // and selection (accent) always wins because the class is
            // simply absent on selected rows.
            !readOnly && !editing && !selected && "block-hoverable",
          )}
        >
          {marker}
          {toggleBeside ? (
            // The beside toggle: a 20px slot (the chevron's square) hung
            // fully OUTSIDE the surface, its right edge on the surface's left
            // edge, on the block's first line — 6px clear of the checkbox.
            // `typo` + h-[1lh] size the slot to that line whatever the scale;
            // the top offset mirrors the line's own vertical padding. Nested,
            // it sits on the parent's guide line; with no hover surface the
            // chevron simply reads as a node on it.
            <span
              className={cx(
                "absolute -left-5 h-[1lh] w-5",
                runEdges?.top ? "top-1" : "top-0.5",
                typo,
              )}
            >
              {toggle}
            </span>
          ) : null}
          {type.kind === "quote" ? (
            // The quote's bar stands at the text column — where every other
            // block's text begins — and pushes the quote's text 10px in (bar
            // 2px + the 8px gap): a quote is set in from the rest, the way it
            // is on the page. Rounded ends and the glyph ink (tertiary), so
            // it reads as chrome of the same family as the `>` beside it. It
            // stretches the line's full height so a wrapped quote reads as
            // one block.
            <span
              aria-hidden
              className="w-0.5 shrink-0 self-stretch rounded-full bg-text-tertiary"
            />
          ) : null}
          {editing ? (
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
                placeholder={zoomTitle ? undefined : "Ruminate…"}
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
                  "min-w-0 flex-1 resize-none overflow-hidden border-none bg-transparent p-0 font-content leading-relaxed text-text outline-none placeholder:text-text-tertiary",
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
                "min-h-[1lh] min-w-0 flex-1 outline-none",
                !readOnly && "cursor-text",
                typo,
                // Checking a todo mutes its text; the fade marks the state
                // change without delaying it.
                type.kind === "todo" && "transition-colors duration-200",
                type.kind === "todo" && type.checked && "text-text-secondary line-through",
              )}
              {...(readOnly
                ? {}
                : {
                    onClick: () => api.select(block.id),
                    onDoubleClick: () => api.edit(block.id),
                  })}
            >
              <BlockContent content={body} doc={doc} />
            </div>
          )}
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

      {hasChildren && !isCollapsed && !zoomTitle ? (
        // The guide hangs from the block's key: a 1px rule under the centre of
        // the 15px marker slot (every block type has one), which starts 4px
        // into the content column (the surface's -2px reach + 6px inner
        // padding) — centre 11.5px, so the rule sits at 11px. Children start
        // 24px in (margin + rule + padding).
        // The guide brightens while the pointer is anywhere in the subtree
        // (group/subtree is the block's outer wrapper), tracing the structure.
        <div
          className={cx(
            "ml-[11px] pl-3",
            "border-l border-border-secondary transition-colors duration-200 group-hover/subtree:border-[color:var(--neutral-a6)]",
            justExpanded && "block-expand",
          )}
        >
          {block.children.map((childId) => {
            const child = doc.blocks[childId]
            if (!child) return null
            return <BlockItem key={childId} doc={doc} block={child} depth={depth + 1} api={api} />
          })}
        </div>
      ) : null}
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
  const kind = getBlockType(block.content).kind
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
