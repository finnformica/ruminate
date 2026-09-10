import { Command } from "cmdk"
import React from "react"
import type { Block, BlockDoc } from "../blocks/types"
import type { Occurrence } from "../blocks/view"
import type { ResultRow } from "../hooks/block-result-tree"
import type { BlockHit } from "../utils/block-search"
import { cx } from "../utils/cx"
import { BlockItem, type BlockEditorApi } from "./block-editor/block-item"
import { NoteFavicon } from "./note-favicon"

/**
 * The block-results list, shared by the ⌘K palette and the full results view
 * (`/?query=…`). The results are a VIEW in the editor's sense: its roots are
 * the matching blocks, each row is an occurrence, and every row is drawn by
 * the editor's own row component (`BlockItem`, read-only) — the same marker
 * slot, type scale, quote bar, checkbox, collapse chevron and guide lines as
 * the block has in its note. The one addition is the breadcrumb under a
 * matched row saying where it lives.
 *
 * One component, two chromes: `palette` renders cmdk items (cmdk owns the
 * highlight and Enter), `page` renders a keyboard-navigable list whose
 * highlight is the editor's own selection surface. Rows come from
 * `useBlockResultTree`, which asks the data source for a row's children only
 * when it is expanded (see `BlockSearchSource`). This component never touches
 * the source itself — it renders rows and reports intent.
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

/** The rows carry everything a row needs; the doc is only the editor's
 * signature. */
const NO_DOC: BlockDoc = { props: null, rootBlockIds: [], blocks: {} }

/** A result row as the editor sees it: the occurrence the tree put it at. */
function occurrenceOf(row: ResultRow): Occurrence {
  return {
    key: row.key,
    id: row.hit.blockId,
    parentKey: row.parentKey,
    depth: row.depth,
    index: row.index,
    olNumber: row.hit.olNumber,
    hasChildren: row.hasChildren,
    collapsed: row.hasChildren && !row.expanded,
    guideKeys: row.guideKeys,
    zoomTitle: false,
  }
}

/** The block a row shows. Children are not embedded in a hit (they are
 * resolved on expand); the occurrence's `hasChildren` is what the row reads. */
function blockOf(row: ResultRow): Block {
  return { id: row.hit.blockId, type: row.hit.type, text: row.hit.text, children: [] }
}

const noop = () => {}

/**
 * The editor api a results list hands its rows: read-only, with the fold
 * toggle routed to the tree and (on the page) a click opening the result.
 * The page's keyboard highlight is the editor's selection: one selected row.
 */
function useResultsApi({
  rows,
  activeKey,
  onToggle,
  onActivate,
}: {
  rows: ResultRow[]
  activeKey: string | null
  onToggle: (row: ResultRow) => void
  /** Absent in the palette, where cmdk's item owns the click. */
  onActivate?: (hit: BlockHit) => void
}): BlockEditorApi {
  return React.useMemo(() => {
    const byKey = new Map(rows.map((row) => [row.key, row]))
    return {
      focus: null,
      selected: activeKey,
      selectedSet: activeKey === null ? new Set<string>() : new Set([activeKey]),
      selectionRunEdges: new Map(),
      readOnly: true,
      keyboardActive: true,
      select: noop,
      edit: noop,
      setFocus: noop,
      onBlockChange: noop,
      onPaste: noop,
      dispatchKey: () => false,
      zoomInto: noop,
      startSelectionLadder: noop,
      toggleCollapse: (key) => {
        const row = byKey.get(key)
        if (row) onToggle(row)
      },
      activate: onActivate
        ? (key) => {
            const row = byKey.get(key)
            if (row) onActivate(row.hit)
          }
        : undefined,
    }
  }, [rows, activeKey, onToggle, onActivate])
}

/** `Note name › Ancestor › Ancestor` — where this block lives. Sits under
 * the row's text column (the marker slot and its gaps to the left). */
function Breadcrumb({ hit, compact }: { hit: BlockHit; compact: boolean }) {
  return (
    <div
      data-testid="result-breadcrumb"
      className={cx(
        "flex min-w-0 items-center gap-1.5 pl-[31px] text-text-secondary",
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

/** One row: the block as the editor draws it, plus (for a matched hit) the
 * breadcrumb. Revealed children are already positioned under their parent;
 * repeating the note and ancestry there would be noise. */
function ResultBlock({
  row,
  api,
  compact,
}: {
  row: ResultRow
  api: BlockEditorApi
  compact: boolean
}) {
  return (
    <>
      <BlockItem doc={NO_DOC} block={blockOf(row)} occurrence={occurrenceOf(row)} api={api} />
      {row.depth === 0 ? <Breadcrumb hit={row.hit} compact={compact} /> : null}
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
  const activeKey = activeIndex === null ? null : (rows[activeIndex]?.key ?? null)
  const api = useResultsApi({
    rows,
    activeKey,
    onToggle,
    onActivate: variant === "page" ? onActivate : undefined,
  })

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
            {/* A click on the row's own controls (the fold chevron) must not
                read as "select this result" to cmdk's item. */}
            {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions */}
            <div
              className="min-w-0 flex-1"
              onClick={(event) => {
                if ((event.target as HTMLElement).closest("button, input")) {
                  event.stopPropagation()
                }
              }}
            >
              <ResultBlock row={row} api={api} compact={compact} />
            </div>
          </Command.Item>
        ))}
      </>
    )
  }

  return (
    // No vertical gap: rows sit flush so the guide lines of an expanded
    // result join into one continuous rule, as they do in the editor.
    <ul className="flex flex-col">
      {rows.map((row, index) => (
        <li
          key={row.key}
          data-list-index={index}
          data-active={activeIndex === index ? "true" : undefined}
        >
          <ResultBlock row={row} api={api} compact={compact} />
        </li>
      ))}
    </ul>
  )
}
