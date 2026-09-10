import { Command } from "cmdk"
import React from "react"
import { getBlockType, stripMarker } from "../blocks/block-type"
import type { ResultRow } from "../hooks/block-result-tree"
import type { BlockHit } from "../utils/block-search"
import { cx } from "../utils/cx"
import { BlockContent } from "./block-editor/block-content"
import {
  BlockMarker,
  BlockToggle,
  BlockToggleBeside,
  QuoteBar,
  headingTopMargin,
  typographyFor,
} from "./block-editor/block-marker"
import { NoteFavicon } from "./note-favicon"

/**
 * The block-results list, shared by the ⌘K palette and the full results view
 * (`/?query=…`). One component, two chromes: `palette` renders cmdk items
 * (cmdk owns the highlight and Enter), `page` renders a keyboard-navigable
 * list drawn in the editor's selection tokens.
 *
 * A result IS the block, drawn as the editor draws it. Each row is built from
 * the editor's own pieces (`block-editor/block-marker.tsx`): the block's type
 * is read from its raw `content` by the same rule (`getBlockType`), its marker
 * sits in the same 15px slot, headings take the same scale for their depth,
 * a quote gets its bar, a parent's collapse chevron swaps into its marker
 * slot (beside a todo's checkbox) exactly as in the note, and revealed
 * children hang from the same 24px guide. What a result adds is only where
 * it lives — the breadcrumb under a matched hit — and what it does (open the
 * note, zoomed to the block).
 *
 * Rows come from `useBlockResultTree`, which asks the data source for a row's
 * children only when it is expanded (see `BlockSearchSource`). This component
 * never touches the source itself — it renders rows and reports intent.
 */

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
 * The editor's heading breathing room, as padding rather than margin: a
 * result row's indent guides stretch over its own box, so the gap must sit
 * inside it to keep the rule continuous (in the editor the margin sits
 * inside the parent's guide container, which does the same job).
 */
function headingTopPadding(type: ReturnType<typeof getBlockType>, depth: number): string {
  switch (headingTopMargin(type, depth)) {
    case "mt-5":
      return "pt-5"
    case "mt-4":
      return "pt-4"
    case "mt-2.5":
      return "pt-2.5"
    case "mt-1.5":
      return "pt-1.5"
    default:
      return ""
  }
}

/** `Note name › Ancestor › Ancestor` — where this block lives. Set like the
 * editor's zoom breadcrumb (font-content, secondary ink, `›` separators). */
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

/**
 * The block itself — marker, quote bar, text in its type's style — plus (for
 * a matched hit) the breadcrumb saying where it lives. The chevron of a
 * result with something downstream lives in its marker slot, pinned while
 * the result is closed, precisely as a folded block's is in the editor.
 */
function ResultBlock({
  row,
  compact,
  onToggle,
}: {
  row: ResultRow
  compact: boolean
  onToggle: (row: ResultRow) => void
}) {
  const type = getBlockType(row.hit.content)
  const body = stripMarker(row.hit.content)
  const typo = typographyFor(type, row.depth)
  // A closed result is a folded block: its chevron stays visible.
  const collapsed = row.hasChildren && !row.expanded
  const toggleBeside = row.hasChildren && type.kind === "todo"
  const toggle = row.hasChildren ? (
    <BlockToggle collapsed={collapsed} beside={toggleBeside} onToggle={() => onToggle(row)} />
  ) : null

  return (
    <>
      <BlockMarker
        type={type}
        depth={row.depth}
        collapsed={collapsed}
        toggle={toggle}
        toggleBeside={toggleBeside}
        readOnly
      />
      {toggleBeside ? (
        <BlockToggleBeside className={cx("top-0.5", typo)}>{toggle}</BlockToggleBeside>
      ) : null}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5 text-left">
        <div className="flex min-w-0 items-start gap-2">
          {type.kind === "quote" ? <QuoteBar /> : null}
          <div
            data-testid="result-block"
            className={cx(
              "min-h-[1lh] min-w-0 flex-1",
              typo,
              type.kind === "todo" && type.checked && "text-text-secondary line-through",
              // The palette is a popup: long blocks clip to keep it scannable.
              // The full results view shows the block whole, like the note.
              compact && "line-clamp-2",
            )}
          >
            <BlockContent content={body} />
          </div>
        </div>
        {row.depth === 0 ? <Breadcrumb hit={row.hit} compact={compact} /> : null}
      </div>
    </>
  )
}

/**
 * One indent guide per level of revealed depth — the editor's own geometry
 * (11px in, a 1px rule, 12px of padding: children start 24px in), so an
 * expanded result reads like the outline it came from. Rows sit flush, so
 * the segments join into one continuous rule.
 */
function IndentGuides({ depth }: { depth: number }) {
  return (
    <>
      {Array.from({ length: depth }, (_, level) => (
        <span
          key={level}
          aria-hidden
          className="ml-[11px] shrink-0 self-stretch border-l border-border-secondary pl-3"
        />
      ))}
    </>
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
            <div className="flex min-w-0 items-stretch font-content leading-relaxed">
              <IndentGuides depth={row.depth} />
              <div className="relative flex min-w-0 flex-1 items-start gap-2">
                <ResultBlock row={row} compact={compact} onToggle={onToggle} />
              </div>
            </div>
          </Command.Item>
        ))}
      </>
    )
  }

  return (
    // No vertical gap between nested rows: they sit flush so the indent
    // guides of an expanded result join into one continuous rule, as they do
    // in the editor. Matched hits (depth 0) keep the editor's root spacing.
    <ul className="flex flex-col">
      {rows.map((row, index) => {
        const active = activeIndex === index
        return (
          <li
            key={row.key}
            data-list-index={index}
            className={cx(
              "flex items-stretch",
              row.depth === 0 && index > 0 && "mt-0.5",
              // Inside a revealed outline a heading breathes as it does in the
              // note; matched hits are a list, spaced evenly.
              row.depth > 0 && headingTopPadding(getBlockType(row.hit.content), row.depth),
            )}
          >
            <IndentGuides depth={row.depth} />
            <div className="relative min-w-0 flex-1 py-0.5 font-content leading-relaxed">
              {/* The editor's line surface (`data-block-line`, see block-item.tsx):
                  the highlight reaches 2px past the text on every side while the
                  text and every marker stay in the shared column. A div, not a
                  button: the chevron and checkbox inside are controls of their
                  own. */}
              {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions */}
              <div
                role="button"
                tabIndex={0}
                data-block-line
                data-active={active ? "true" : undefined}
                onClick={() => onActivate(row.hit)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault()
                    onActivate(row.hit)
                  }
                }}
                className={cx(
                  "focus-ring relative -mx-0.5 -my-0.5 flex cursor-default items-start gap-2 rounded px-1.5 py-0.5",
                  active ? "bg-bg-secondary list-highlight" : "block-hoverable",
                )}
              >
                <ResultBlock row={row} compact={compact} onToggle={onToggle} />
              </div>
            </div>
          </li>
        )
      })}
    </ul>
  )
}
