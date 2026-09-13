import { Command } from "cmdk"
import React from "react"
import type { Block, BlockDoc } from "../blocks/types"
import type { Occurrence } from "../blocks/view"
import type { ResultRow } from "../hooks/block-result-tree"
import type { BlockHit } from "../utils/block-search"
import { isNoteHit } from "../utils/block-search-source"
import { BlockItem, type BlockEditorApi } from "./block-editor/block-item"

/**
 * The ⌘K palette's results. The results are a VIEW in the editor's sense:
 * its roots are whatever matched, each row is an occurrence, and every row
 * is drawn by the editor's own row component (`BlockItem`, read-only) — the
 * same marker slot, type scale, quote bar, checkbox, collapse chevron and
 * guide lines the block has in its note. (The full results view and the
 * notes list go further and run the editor itself — `ResultsEditor` — but
 * cmdk owns the palette's highlight and Enter, so here the rows are drawn
 * one by one as cmdk items.)
 *
 * **Notes and blocks are the same kind of row.** A note is a node whose type
 * is `note` and whose children are its blocks (docs/graph-schema-v2.md), so a
 * note result is a root row that expands to reveal what is in it, exactly as
 * a block result does. Rows come from `useBlockResultTree`, which asks the
 * data source for a row's children only when it is expanded (see
 * `BlockSearchSource`). This component never touches the source itself — it
 * renders rows and reports intent.
 */

/** The cmdk item value for a row (cmdk lowercases these — see the palette's
 * value → row map). */
export function resultRowValue(row: ResultRow): string {
  return `block:${row.key}`
}

/** Where a hit opens: its note, zoomed into the block (the `?block=` param the
 * editor already reads) — or, for a note row, that note whole. Shared so every
 * Enter lands in the same place. */
export function blockHitNavigation(hit: BlockHit) {
  return {
    to: "/notes/$" as const,
    params: { _splat: hit.noteId },
    search: { query: undefined, block: isNoteHit(hit) ? undefined : hit.blockId },
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
 * resolved on expand); the occurrence's `hasChildren` is what the row reads.
 * A note row's block is the note NODE, props and all — the row draws its
 * favicon and its pinned state from them, as the editor does for a note
 * block walked out of the graph. */
function blockOf(row: ResultRow): Block {
  const { hit } = row
  const base = { id: hit.blockId, type: hit.type, text: hit.text, children: [] }
  return isNoteHit(hit) ? { ...base, props: hit.note.props } : base
}

const noop = () => {}

/**
 * The editor api the palette hands its rows: read-only, with the fold toggle
 * routed to the tree; cmdk's item owns the highlight and the click.
 */
function useResultsApi({
  rows,
  onToggle,
}: {
  rows: ResultRow[]
  onToggle: (row: ResultRow) => void
}): BlockEditorApi {
  return React.useMemo(() => {
    const byKey = new Map(rows.map((row) => [row.key, row]))
    return {
      focus: null,
      selected: null,
      selectedSet: new Set<string>(),
      selectionRunEdges: new Map(),
      readOnly: true,
      // The roots are the query's (a listed note takes its roomier row).
      fixedRoots: true,
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
    }
  }, [rows, onToggle])
}

/**
 * `Note name › Ancestor › Ancestor` — where this block lives. Sits under the
 * row's text column (the marker slot and its gaps to the left).
 *
 * It carries only what ORIENTS, never what repeats. The note's name leads it
 * only while the results span more than one note (`withNote`): scoped to one
 * — an `in:blk_…` query, the palette's in-note scope — the same name under
 * every row says nothing. The note's favicon is gone from it altogether: it
 * is the key a NOTE row hangs in its own marker slot now, and under a block
 * row it only ever restated the name beside it. An empty trail draws nothing.
 */
function Breadcrumb({ hit, withNote }: { hit: BlockHit; withNote: boolean }) {
  const trail = [
    ...(withNote ? [{ id: hit.noteId, text: hit.note.displayName }] : []),
    ...hit.ancestors,
  ]
  if (trail.length === 0) return null
  return (
    <div
      data-testid="result-breadcrumb"
      className="flex min-w-0 items-center pl-[31px] text-xs text-text-secondary"
    >
      <span className="truncate">
        {trail.map((crumb, index) => (
          <React.Fragment key={`${crumb.id}:${index}`}>
            {index > 0 ? <span className="px-1 text-text-tertiary">›</span> : null}
            {crumb.text}
          </React.Fragment>
        ))}
      </span>
    </div>
  )
}

/** One row: the block as the editor draws it, plus (for a matched hit) the
 * breadcrumb. Revealed children are already positioned under their parent,
 * and a note row is the top of its own outline — repeating the note and
 * ancestry on either would be noise. */
function ResultBlock({
  row,
  api,
  withNote,
}: {
  row: ResultRow
  api: BlockEditorApi
  withNote: boolean
}) {
  return (
    <>
      <BlockItem doc={NO_DOC} block={blockOf(row)} occurrence={occurrenceOf(row)} api={api} />
      {row.depth === 0 && !isNoteHit(row.hit) ? (
        <Breadcrumb hit={row.hit} withNote={withNote} />
      ) : null}
    </>
  )
}

export interface SearchResultsProps {
  rows: ResultRow[]
  onActivate: (hit: BlockHit) => void
  onToggle: (row: ResultRow) => void
}

/** The rows as cmdk items, inside a `Command.List`. */
export function SearchResults({ rows, onActivate, onToggle }: SearchResultsProps) {
  // The note's name earns its place in a breadcrumb only while it tells two
  // rows apart (see `Breadcrumb`).
  const withNote = React.useMemo(() => new Set(rows.map((row) => row.hit.noteId)).size > 1, [rows])
  const api = useResultsApi({ rows, onToggle })

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
            <ResultBlock row={row} api={api} withNote={withNote} />
          </div>
        </Command.Item>
      ))}
    </>
  )
}
