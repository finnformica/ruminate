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
  collapsed: Set<string>
  /** Display-only: no editing, selection, or mutation (collapse still works). */
  readOnly?: boolean
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
          return "text-2xl font-bold leading-tight tracking-[-0.015em]"
        case 1:
          return "text-xl font-bold leading-tight tracking-[-0.01em]"
        case 2:
          return "text-lg font-bold leading-snug"
        default:
          // Floors at body size; a soft offset underline keeps it reading as a
          // heading without the weight of a full text-color rule.
          return "text-base font-bold leading-relaxed underline decoration-[color:var(--neutral-a6)] decoration-2 underline-offset-4"
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
  // The zoomed title is visually promoted to the top of the heading scale.
  const typo = zoomTitle
    ? typographyFor({ kind: "heading", level: 1 }, 0)
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
    el.style.height = `${el.scrollHeight}px`
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
  const marker =
    type.kind === "todo" ? (
      <span className="flex h-[1lh] shrink-0 items-center">
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
      <span className="flex h-[1lh] shrink-0 items-center">
        {zoomable ? (
          <button
            type="button"
            aria-label="Zoom into block"
            tabIndex={-1}
            onClick={() => api.zoomInto(block.id)}
            className="-m-1.5 flex cursor-pointer items-center justify-center rounded-full p-1.5 transition-colors duration-150 hover:bg-bg-secondary"
          >
            <span
              aria-hidden
              className={cx(
                "size-1.5 rounded-full bg-text-secondary",
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
              "size-1.5 rounded-full bg-text-secondary",
              isCollapsed && hasChildren && "ring-[3px] ring-[color:var(--neutral-a4)]",
            )}
          />
        )}
      </span>
    ) : type.kind === "ordered" && !zoomTitle ? (
      <span className="flex h-[1lh] shrink-0 items-center tabular-nums text-text-secondary">
        {zoomable ? (
          <button
            type="button"
            aria-label="Zoom into block"
            tabIndex={-1}
            onClick={() => api.zoomInto(block.id)}
            className="-mx-0.5 cursor-pointer rounded-sm px-0.5 transition-colors duration-150 hover:bg-bg-secondary"
          >
            {type.number}.
          </button>
        ) : (
          <span aria-hidden>{type.number}.</span>
        )}
      </span>
    ) : null

  // Blocks without a clickable list marker get a subtle hover affordance in
  // the gutter, floated left of the collapse chevron so nothing shifts.
  const showZoomButton = zoomable && type.kind !== "bullet" && type.kind !== "ordered"

  return (
    <div
      data-block-row={block.id}
      className={cx("group/subtree", zoomTitle ? "mb-3" : headingTopMargin(type, depth))}
    >
      <div className="group relative flex items-start gap-1">
        {/* The toggle stays a fixed square; the wrapper mirrors the content
            cell's padding + line-height (via `typo`) and centres the square on
            the block's first line, so it aligns whatever the heading size. */}
        <div className={cx("relative flex shrink-0 py-0.5 font-content leading-relaxed", typo)}>
          {showZoomButton ? (
            // Floated left of the chevron (outside the flow) so the gutter
            // keeps its width and nothing shifts; appears on row hover.
            <span className="absolute right-full top-0.5 flex h-[1lh] items-center">
              <IconButton
                aria-label="Zoom into block"
                size="small"
                disableTooltip
                tabIndex={-1}
                onClick={() => api.zoomInto(block.id)}
                className="size-6 shrink-0 p-0 text-text-tertiary opacity-0 transition-opacity duration-150 focus-visible:opacity-100 group-hover:opacity-100"
              >
                <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
                  <circle
                    cx="4"
                    cy="4"
                    r="2.75"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                  />
                  <path d="M6.2 6.2l2.6 2.6" stroke="currentColor" strokeWidth="1.5" />
                </svg>
              </IconButton>
            </span>
          ) : null}
          <span className="flex h-[1lh] items-center">
            <IconButton
              aria-label={isCollapsed ? "Expand" : "Collapse"}
              size="small"
              disableTooltip
              tabIndex={-1}
              onClick={() => api.toggleCollapse(block.id)}
              className={cx(
                "size-6 shrink-0 p-0 text-text-tertiary transition-opacity duration-150",
                zoomTitle || !hasChildren
                  ? "pointer-events-none opacity-0"
                  : // Quiet chrome: the toggle appears on row hover (its space is
                    // always reserved, so nothing shifts) — except a collapsed
                    // block, which keeps it visible so hidden content shows.
                    !isCollapsed && "opacity-0 focus-visible:opacity-100 group-hover:opacity-100",
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
              // The negative margin + padding pair widens the highlight surface
              // to 8px of horizontal breathing room while the text (and every
              // marker) stays exactly where it was — the background extends
              // into the 4px gutter gap instead of pushing content.
              "-mx-1 flex items-start gap-2 rounded-md px-2",
              // bg-bg-secondary is the structural "selected" hook (tests query
              // it); .block-highlight paints the accent tint over it so
              // selection reads as selected, not hovered.
              selected && "bg-bg-secondary block-highlight",
              // Square left corners so the quote bar stays a straight rule
              // instead of curving with the highlight radius.
              type.kind === "quote" && "rounded-l-none border-l-2 border-border pl-3",
            )}
          >
            {marker}
            {editing ? (
              <textarea
                ref={textareaRef}
                value={body}
                rows={1}
                spellCheck
                onChange={handleTextareaChange}
                onKeyDown={handleEditKeyDown}
                onPaste={handlePaste}
                onBlur={() => api.setFocus(null)}
                className={cx(
                  "min-w-0 flex-1 resize-none border-none bg-transparent p-0 font-content leading-relaxed text-text outline-none",
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
