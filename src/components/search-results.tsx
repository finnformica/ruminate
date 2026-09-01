import { Command } from "cmdk"
import React from "react"
import type { ResultRow } from "../hooks/block-result-tree"
import type { BlockHit, BlockSearchType } from "../utils/block-search"
import { cx } from "../utils/cx"
import { BlockContent } from "./block-editor/block-content"
import { Hash } from "./block-editor/hash"
import { IconButton } from "./icon-button"
import { NoteFavicon } from "./note-favicon"

/**
 * The block-results list, shared by the ⌘K palette and the full results view
 * (`/?query=…`). One component, two chromes: `palette` renders cmdk items
 * (cmdk owns the highlight and Enter), `page` renders a keyboard-navigable
 * list drawn in the editor's selection tokens. Everything else — how a block
 * renders for its type, the breadcrumb, the expand affordance, the indent
 * guides — is identical by construction, so the two can't drift.
 *
 * Rows come from `useBlockResultTree`, which asks the data source for a row's
 * children only when it is expanded (see `BlockSearchSource`). This component
 * never touches the source itself — it renders rows and reports intent.
 */

/** Heading types, which render bold behind a `#` like the editor's headings. */
const HEADING_TYPES = new Set<BlockSearchType>(["h1", "h2", "h3", "h4", "h5", "h6"])

/** The cmdk item value for a row (cmdk lowercases these — see the palette's
 * value → row map). */
export function resultRowValue(row: ResultRow): string {
  return `block:${row.key}`
}

/** Where a hit opens: its note, zoomed into the block (the `?block=` param the
 * editor already reads). Shared so every Enter lands in the same place. */
export function blockHitNavigation(hit: BlockHit) {
  return {
    to: "/notes/$" as const,
    params: { _splat: hit.noteId },
    search: { query: undefined, block: hit.blockId },
  }
}

/**
 * A block's marker, in the editor's vocabulary and its 15px marker column:
 * a checkbox for todos, a dot for list items, a `#` for headings. Plain
 * paragraphs, quotes and code have no marker in the editor either — their
 * type reads from the row's own styling instead.
 */
function BlockMarker({ type }: { type: BlockSearchType }) {
  if (type === "todo" || type === "done") {
    return (
      <span className="flex h-[1lh] w-[15px] shrink-0 items-center justify-center">
        <input
          type="checkbox"
          checked={type === "done"}
          readOnly
          disabled
          tabIndex={-1}
          aria-hidden
          className="block-checkbox cursor-default"
        />
      </span>
    )
  }
  if (HEADING_TYPES.has(type)) {
    return (
      <span className="flex h-[1lh] w-[15px] shrink-0 items-center justify-end font-bold">
        <Hash />
      </span>
    )
  }
  if (type === "bullet" || type === "ordered") {
    return (
      <span className="flex h-[1lh] w-[15px] shrink-0 items-center justify-center">
        <span aria-hidden className="size-1.5 rounded-full bg-text-tertiary" />
      </span>
    )
  }
  return null
}

/** The type's own text treatment — the editor's, minus the outline-depth type
 * scale (a result row has no outline depth to be sized by). */
function typographyFor(type: BlockSearchType): string {
  if (HEADING_TYPES.has(type)) return "font-bold"
  if (type === "done") return "text-text-secondary line-through"
  if (type === "quote") return "text-text-secondary"
  if (type === "code") return "font-mono text-[0.9em]"
  return ""
}

/** `Note name › Ancestor › Ancestor` — where this block lives. */
function Breadcrumb({ hit, compact }: { hit: BlockHit; compact: boolean }) {
  return (
    <div
      className={cx(
        "flex min-w-0 items-center gap-1.5 text-text-secondary",
        compact ? "text-xs" : "text-sm",
      )}
    >
      <NoteFavicon note={hit.note} className="shrink-0" />
      <span className="truncate">
        {hit.note.displayName}
        {hit.ancestors.map((ancestor) => (
          <React.Fragment key={ancestor.id}>
            <span className="px-1 text-text-tertiary">›</span>
            {ancestor.text}
          </React.Fragment>
        ))}
      </span>
    </div>
  )
}

/** The expand chevron — drawn only when the block has something downstream
 * (`childCount`), which is the whole point of carrying that flag on the hit. */
function ExpandToggle({ row, onToggle }: { row: ResultRow; onToggle: (row: ResultRow) => void }) {
  return (
    <span className="flex h-[1lh] shrink-0 items-center">
      <IconButton
        aria-label={row.expanded ? "Collapse" : "Expand"}
        size="small"
        disableTooltip
        tabIndex={-1}
        onClick={(event) => {
          // In the palette this button lives inside a cmdk item, which would
          // otherwise treat the click as "select this result".
          event.preventDefault()
          event.stopPropagation()
          onToggle(row)
        }}
        className={cx(
          "size-6 shrink-0 p-0 text-text-tertiary transition-[opacity,transform] duration-150 active:scale-[0.92] motion-reduce:active:scale-100",
          !row.hasChildren && "pointer-events-none opacity-0",
        )}
      >
        <svg
          width="8"
          height="8"
          viewBox="0 0 8 8"
          aria-hidden
          className={cx(
            "transition-transform duration-200 ease-[var(--ease-out-strong)] motion-reduce:transition-none",
            row.expanded ? "rotate-90" : "rotate-0",
          )}
        >
          <path d="M2 1l4 3-4 3z" fill="currentColor" />
        </svg>
      </IconButton>
    </span>
  )
}

/**
 * The row's gutter: one indent guide per level of revealed depth (matching the
 * editor's subtree rule, so an expanded result reads like the outline it came
 * from) and the expand chevron. Sits OUTSIDE the row's own surface, exactly as
 * the editor's collapse gutter sits outside the block's highlight.
 */
function ResultRowGutter({
  row,
  onToggle,
}: {
  row: ResultRow
  onToggle: (row: ResultRow) => void
}) {
  return (
    <>
      {Array.from({ length: row.depth }, (_, level) => (
        <span
          key={level}
          aria-hidden
          className="w-3 shrink-0 self-stretch border-l border-border-secondary"
        />
      ))}
      <ExpandToggle row={row} onToggle={onToggle} />
    </>
  )
}

/**
 * The block itself: its marker and text in its own type's style, plus (for a
 * matched hit) the breadcrumb saying where it lives. Identical in both
 * variants — only the density differs.
 */
function ResultRowBody({ row, compact }: { row: ResultRow; compact: boolean }) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-0.5 text-left leading-relaxed">
      <div className="flex min-w-0 items-start gap-2">
        <BlockMarker type={row.hit.type} />
        <div
          data-testid="result-block"
          className={cx(
            "min-w-0 flex-1 font-content",
            compact ? "line-clamp-1" : "line-clamp-2",
            typographyFor(row.hit.type),
            // The editor's quote rule, on the text rather than the whole row
            // (the row's surface belongs to the selection, not to the block).
            row.hit.type === "quote" && "border-l-2 border-border pl-2",
          )}
        >
          <BlockContent content={row.hit.text} />
        </div>
      </div>
      {row.depth === 0 ? <Breadcrumb hit={row.hit} compact={compact} /> : null}
    </div>
  )
}

export interface SearchResultsProps {
  rows: ResultRow[]
  /** `palette` = cmdk items inside ⌘K; `page` = the full results view. */
  variant: "palette" | "page"
  onActivate: (hit: BlockHit) => void
  onToggle: (row: ResultRow) => void
  /** `page` only: the roving keyboard highlight (an index into `rows`). */
  activeIndex?: number | null
}

export function SearchResults({
  rows,
  variant,
  onActivate,
  onToggle,
  activeIndex = null,
}: SearchResultsProps) {
  const compact = variant === "palette"

  if (variant === "palette") {
    return (
      <>
        {rows.map((row) => (
          <Command.Item
            key={row.key}
            value={resultRowValue(row)}
            onSelect={() => onActivate(row.hit)}
            className="leading-normal!"
          >
            <div className="flex min-w-0 items-start gap-1.5">
              <ResultRowGutter row={row} onToggle={onToggle} />
              <ResultRowBody row={row} compact={compact} />
            </div>
          </Command.Item>
        ))}
      </>
    )
  }

  return (
    // No vertical gap: rows sit flush so the indent guides of an expanded
    // result join into one continuous rule, as they do in the editor.
    <ul className="flex flex-col">
      {rows.map((row, index) => (
        <li key={row.key} data-list-index={index} className="flex items-start gap-1.5">
          <ResultRowGutter row={row} onToggle={onToggle} />
          <button
            type="button"
            data-block-line
            data-active={activeIndex === index ? "true" : undefined}
            onClick={() => onActivate(row.hit)}
            className={cx(
              // -ml-1/pl-2 mirrors the editor: the surface reaches 4px left of
              // the text column without moving the text.
              "focus-ring -ml-1 flex min-w-0 flex-1 cursor-default rounded py-1 pl-2 pr-2",
              activeIndex === index ? "bg-bg-secondary list-highlight" : "block-hoverable",
            )}
          >
            <ResultRowBody row={row} compact={compact} />
          </button>
        </li>
      ))}
    </ul>
  )
}
