import { useEffect, useLayoutEffect, useRef } from "react"
import type { ChangeEvent, ClipboardEvent, KeyboardEvent } from "react"
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
import { htmlToMarkdown } from "../../utils/html-to-markdown"
import { clipboardBlocksToMarkdown, extractClipboardBlocks } from "../../utils/rich-clipboard"
import { IconButton } from "../icon-button"
import { BlockContent } from "./block-content"
import { caretLineFlags } from "./caret"
import { Hash } from "./hash"

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
  onContentChange: (id: string, content: string) => void
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
  /** Render as the zoomed view's title: promoted typography, no marker or
   * chevron, and no children (the editor renders those itself at depth 0). */
  zoomTitle?: boolean
}) {
  const readOnly = api.readOnly ?? false
  const editing = !readOnly && api.focus?.id === block.id
  const selected = api.selectedSet.has(block.id) && !editing
  const hasChildren = block.children.length > 0
  const isCollapsed = api.collapsed.has(block.id)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const pendingCaret = useRef<number | null>(null)
  // Set by a Cmd/Ctrl+Shift+V keydown so the paste event that follows inserts
  // plain text at the caret (newlines collapsed, no block splitting).
  const plainPaste = useRef(false)

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
  // The zoomed block *is* the page, so its title uses the note-title scale
  // (matching note-title.tsx) — a full step above the depth-0 headings of its
  // children, which re-derive their sizes from the zoom root. The promotion
  // changes scale, not type: a quote keeps its bar and secondary ink, a todo
  // its checkbox (both render on the line independently of the typography).
  const typo = zoomTitle
    ? cx(
        "text-3xl font-bold leading-tight tracking-[-0.02em]",
        type.kind === "quote" && "text-text-secondary",
      )
    : typographyFor(type, depth)

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
    // An empty textarea would size to its teaching placeholder (which can wrap
    // on narrow screens); the empty row is exactly one line (matching the view
    // branch's min-h-[1lh]) — the ghost must never move layout.
    el.style.height = el.value === "" ? "1lh" : `${el.scrollHeight}px`
    if (pendingCaret.current !== null) {
      const pos = pendingCaret.current
      pendingCaret.current = null
      el.setSelectionRange(pos, pos)
    }
  }, [editing, block.content])

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
  }

  const handleEditKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const el = event.currentTarget
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

  // List markers double as zoom targets (Logseq-style: click the bullet to
  // make this block the page). The negative-margin padding enlarges the hit
  // area without shifting the marker's layout size.
  const zoomable = !readOnly && !zoomTitle
  // Every marker occupies the same 15px slot (the checkbox's width), so body
  // text starts at one column across bullet / todo / numbered blocks and the
  // markers read as one chrome family.
  const marker =
    type.kind === "todo" ? (
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
    ) : type.kind === "bullet" && !zoomTitle ? (
      <span className="flex h-[1lh] w-[15px] shrink-0 items-center justify-center">
        {zoomable ? (
          <button
            type="button"
            aria-label="Zoom into block"
            tabIndex={-1}
            onClick={() => api.zoomInto(block.id)}
            className="-m-1.5 flex cursor-pointer items-center justify-center rounded-full p-1.5 transition-[background-color,transform] duration-150 hover:bg-bg-secondary active:scale-90 motion-reduce:active:scale-100"
          >
            <span
              aria-hidden
              className={cx(
                // Faint, like the chevron — pure chrome; content leads.
                "size-1.5 rounded-full bg-text-tertiary",
                // A halo marks a bullet whose children are hidden (Logseq-style),
                // so collapsed content is never a secret.
                isCollapsed && hasChildren && "ring-[3px] ring-[color:var(--neutral-a4)]",
              )}
            />
          </button>
        ) : (
          <span
            aria-hidden
            className={cx(
              "size-1.5 rounded-full bg-text-tertiary",
              isCollapsed && hasChildren && "ring-[3px] ring-[color:var(--neutral-a4)]",
            )}
          />
        )}
      </span>
    ) : type.kind === "heading" && !zoomTitle ? (
      // Headings hang the same grey `#` as the note / zoom titles — the shared
      // `Hash`, at the heading's own scale: the slot carries the heading's
      // size + weight (headingScale + bold, no underline — that lives in
      // `typo`) and the glyph inherits it, so the hash always matches the text
      // beside it, at every depth. The slot stays the shared 15px column
      // (heading text aligns with every other marked block); the hash
      // right-aligns in it and, when a large scale outgrows the slot,
      // overflows LEFT toward the gutter — the text column never moves. The
      // slot's `h-[1lh]` (resolved at the heading's scale) centres the glyph
      // on the heading's first line. Click-to-zoom, like bullets.
      <span
        data-testid="heading-hash"
        className={cx(
          "flex h-[1lh] w-[15px] shrink-0 items-center justify-end font-bold",
          headingScale(depth),
        )}
      >
        {zoomable ? (
          <button
            type="button"
            aria-label="Zoom into block"
            tabIndex={-1}
            onClick={() => api.zoomInto(block.id)}
            className="-m-1 flex cursor-pointer items-center justify-center rounded-sm p-1 transition-[background-color,transform] duration-150 hover:bg-bg-secondary active:scale-90 motion-reduce:active:scale-100"
          >
            <Hash />
          </button>
        ) : (
          <Hash />
        )}
      </span>
    ) : type.kind === "ordered" && !zoomTitle ? (
      // Numbers are read (they carry order), so they sit one step up the ramp
      // from the dot — muted, not faint — and right-align to the slot edge.
      <span className="flex h-[1lh] min-w-[15px] shrink-0 items-center justify-end tabular-nums text-text-secondary">
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
          <span aria-hidden>{type.number}.</span>
        )}
      </span>
    ) : null

  return (
    <div
      data-block-row={block.id}
      className={cx("group/subtree", zoomTitle ? "mb-3" : headingTopMargin(type, depth))}
    >
      {/* gap-1.5 (6px) between the collapse gutter and the content column: the
          highlight surface reaches 4px left of the text column, so the wider
          gap keeps 2px of daylight between the surface and the chevron's
          hover square. */}
      <div className="group relative flex items-start gap-1.5">
        {/* The toggle stays a fixed square; the wrapper mirrors the content
            cell's padding + line-height (via `typo`) and centres the square on
            the block's first line, so it aligns whatever the heading size. */}
        <div className={cx("relative flex shrink-0 py-0.5 font-content leading-relaxed", typo)}>
          <span className="flex h-[1lh] items-center">
            <IconButton
              aria-label={isCollapsed ? "Expand" : "Collapse"}
              size="small"
              disableTooltip
              tabIndex={-1}
              onClick={() => api.toggleCollapse(block.id)}
              className={cx(
                // Press feedback on the control (IconButton supplies the hover
                // surface); the content itself never animates on collapse.
                "size-6 shrink-0 p-0 text-text-tertiary transition-[opacity,transform] duration-150 active:scale-[0.92] motion-reduce:active:scale-100",
                // Always visible for blocks with children — expanded sections
                // keep their toggle (hover-reveal read as it disappearing).
                (zoomTitle || !hasChildren) && "pointer-events-none opacity-0",
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
                <path d="M2 1l4 3-4 3z" fill="currentColor" />
              </svg>
            </IconButton>
          </span>
        </div>

        <div className="min-w-0 flex-1 py-0.5 font-content leading-relaxed">
          <div
            // The visible content line (carries the highlight). Scroll-into-view
            // targets this, not the row wrapper, so a heading's top margin can't
            // distort where the highlight lands.
            data-block-line
            className={cx(
              // Negative margin + padding pairs grow the highlight surface
              // while the text (and every marker) stays exactly where it was —
              // the background extends outward instead of pushing content.
              // Horizontally: symmetric — the surface extends 4px each side
              // (-mx-1) and gives the text 8px of inner breathing room
              // (pl-2 pr-2), so the left edge nets to the same text column as
              // before (-4+8 = +4).
              // Vertically: 4px above and below (-my-1 py-1), reaching into
              // the inter-row space so the surface breathes without adding a
              // pixel to the block rhythm. Vertically adjacent selected
              // surfaces meet (and slightly overlap), which is what lets a
              // multi-select run read as one continuous solid surface.
              "relative -my-1 -ml-1 -mr-1 flex items-start gap-2 rounded py-1 pl-2 pr-2",
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
              // Inside a multi-select run the corners where two selected
              // surfaces meet go straight, so the run reads as ONE surface
              // rounded only at its top and bottom (the editor computes which
              // neighbours actually touch — heading top margins break a run).
              selected && api.selectionRunEdges.get(block.id)?.top && "rounded-t-none",
              selected && api.selectionRunEdges.get(block.id)?.bottom && "rounded-b-none",
              // Square left corners so the quote bar stays a straight rule
              // instead of curving with the highlight radius. The wider pl
              // holds the quote text at its usual column: the bar rides the
              // surface's left edge (-4), so border (2) + pl (14) nets +12.
              // (14px is arbitrary-valued — the spacing scale has no 3.5 step.)
              type.kind === "quote" && "rounded-l-none border-l-2 border-border pl-[14px]",
            )}
          >
            {zoomTitle && type.kind === "heading" ? (
              // A zoomed section is a page, and pages hang a # to the left of
              // their title (matching note-title.tsx). It sits in the gutter,
              // where the chevron is hidden for the title anyway.
              <span
                data-testid="zoom-title-hash"
                // The wrapper carries the title's own typography (`typo`) so
                // the `Hash` inside inherits it — like the note title's
                // hanging #, which inherits from its h1 — sitting large on
                // the same baseline instead of shrinking to body scale.
                // top-1 re-aligns with the text after the line's 4px vertical
                // highlight padding (absolute offsets are from the padding box).
                // pr-1 keeps the glyph itself where it was when the surface
                // edge moved 2px left (right-full tracks the edge: -4-4 = -2-6).
                className={cx(typo, "pointer-events-none absolute right-full top-1 pr-1")}
              >
                <Hash />
              </span>
            ) : null}
            {marker}
            {editing ? (
              <textarea
                ref={textareaRef}
                value={body}
                rows={1}
                spellCheck
                // Teach the turn-into keys the first time someone sits in an
                // empty block: a ghost at placeholder rank (tertiary — chrome,
                // not ink) that the browser shows only while the textarea is
                // empty, so it never appears in view mode or over content.
                // The zoom title is a page title, not a block — no ghost.
                placeholder={zoomTitle ? undefined : "Type, or press # heading · - list · [ todo"}
                onChange={handleTextareaChange}
                onKeyDown={handleEditKeyDown}
                onPaste={handlePaste}
                onBlur={() => api.setFocus(null)}
                className={cx(
                  "min-w-0 flex-1 resize-none overflow-hidden border-none bg-transparent p-0 font-content leading-relaxed text-text outline-none placeholder:text-text-tertiary",
                  typo,
                )}
              />
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
          </div>
        </div>
      </div>

      {hasChildren && !isCollapsed && !zoomTitle ? (
        // Left margin puts the guide line under the toggle's centre (w-6 → 12px).
        // The guide brightens while the pointer is anywhere in the subtree
        // (group/subtree is the block's outer wrapper), tracing the structure.
        <div
          className={cx(
            "ml-3 border-l border-border-secondary pl-3 transition-colors duration-200 group-hover/subtree:border-[color:var(--neutral-a6)]",
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
