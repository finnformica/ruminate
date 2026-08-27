import { useLayoutEffect, useRef } from "react"
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
}

/** Extra space above a heading, proportional to its size (i.e. its outline
 * depth), so sections breathe. Applied to the block's outer wrapper (shared by
 * view and edit) so switching modes never shifts the text. */
function headingTopMargin(type: BlockType, depth: number): string {
  if (type.kind !== "heading") return ""
  switch (depth) {
    case 0:
      return "mt-3"
    case 1:
      return "mt-2"
    case 2:
      return "mt-1.5"
    default:
      return "mt-1"
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
      switch (depth) {
        case 0:
          return "text-2xl font-bold"
        case 1:
          return "text-xl font-bold"
        case 2:
          return "text-lg font-bold"
        default:
          return "text-base font-bold underline"
      }
    case "quote":
      return "italic text-text-secondary"
    default:
      return "text-base"
  }
}

export function BlockItem({
  doc,
  block,
  depth,
  api,
}: {
  doc: BlockDoc
  block: Block
  depth: number
  api: BlockEditorApi
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

  const type = getBlockType(block.content)
  // The block is edited and rendered *without* its marker (the `- `, `# `,
  // `[ ] `, `> `), which is shown as a real bullet/checkbox/heading style. This
  // keeps the view and the editor pixel-identical — nothing shifts on click.
  const body = stripMarker(block.content)
  const prefix = block.content.slice(0, block.content.length - body.length)
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
      event.preventDefault()
      const el = event.currentTarget
      const collapsed = normalized.replace(/\s*\n+\s*/g, " ")
      const before = el.value.slice(0, el.selectionStart)
      const after = el.value.slice(el.selectionEnd)
      pendingCaret.current = (before + collapsed).length
      api.onContentChange(block.id, prefix + before + collapsed + after)
      return
    }
    // Single-line paste is ordinary inline insertion; only multi-line paste
    // needs to be spread across blocks.
    if (!normalized.includes("\n")) return
    event.preventDefault()
    const el = event.currentTarget
    const before = el.value.slice(0, el.selectionStart)
    const after = el.value.slice(el.selectionEnd)
    api.onPaste(block.id, prefix, before, normalized, after)
  }

  const marker =
    type.kind === "todo" ? (
      <span className="flex h-[1lh] shrink-0 items-center">
        <input
          type="checkbox"
          checked={type.checked}
          disabled={readOnly}
          onClick={(event) => event.stopPropagation()}
          onChange={() => api.onContentChange(block.id, toggleTodo(block.content))}
          className={cx("size-4 accent-text", readOnly ? "cursor-default" : "cursor-pointer")}
        />
      </span>
    ) : type.kind === "bullet" ? (
      <span className="flex h-[1lh] shrink-0 items-center">
        <span aria-hidden className="size-1.5 rounded-full bg-text-secondary" />
      </span>
    ) : type.kind === "ordered" ? (
      <span
        aria-hidden
        className="flex h-[1lh] shrink-0 items-center tabular-nums text-text-secondary"
      >
        {type.number}.
      </span>
    ) : null

  return (
    <div data-block-row={block.id} className={cx(headingTopMargin(type, depth))}>
      <div className="group relative flex items-start gap-1">
        {/* The toggle stays a fixed square; the wrapper mirrors the content
            cell's padding + line-height (via `typo`) and centres the square on
            the block's first line, so it aligns whatever the heading size. */}
        <div className={cx("flex shrink-0 py-0.5 font-content leading-relaxed", typo)}>
          <span className="flex h-[1lh] items-center">
            <IconButton
              aria-label={isCollapsed ? "Expand" : "Collapse"}
              size="small"
              disableTooltip
              tabIndex={-1}
              onClick={() => api.toggleCollapse(block.id)}
              className={cx(
                "size-6 shrink-0 p-0 text-text-tertiary",
                !hasChildren && "pointer-events-none opacity-0",
              )}
            >
              <svg
                width="8"
                height="8"
                viewBox="0 0 8 8"
                aria-hidden
                className={cx("transition-transform", isCollapsed ? "rotate-0" : "rotate-90")}
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
              "flex items-start gap-2 rounded-sm px-1",
              selected && "bg-bg-secondary",
              type.kind === "quote" && "border-l-2 border-border-secondary pl-2",
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

      {hasChildren && !isCollapsed ? (
        // Left margin puts the guide line under the toggle's centre (w-6 → 12px).
        <div className="ml-3 border-l border-border-secondary pl-3">
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
