import { useNavigate } from "@tanstack/react-router"
import React, { useState } from "react"
import { useInView } from "react-intersection-observer"
import { useDebounce } from "use-debounce"
import { useBlockResultTree } from "../hooks/block-result-tree"
import { useListKeyboardNav } from "../hooks/list-keyboard-nav"
import { useBlockSearchSource, useSearchResults } from "../hooks/search-results"
import { parseQuery, removeQualifier } from "../utils/search"
import { formatNumber, pluralize } from "../utils/pluralize"
import { Button } from "./button"
import { DropdownMenu } from "./dropdown-menu"
import { TagFillIcon12, TagIcon12, TagIcon16, XIcon12 } from "./icons"
import { PillButton } from "./pill-button"
import { ScopePill } from "./scope-pill"
import { SearchInput } from "./search-input"
import { SearchResults, blockHitNavigation } from "./search-results"

type NoteListProps = {
  baseQuery?: string
  query: string
  onQueryChange: (query: string) => void
  /**
   * Linear-style list keys (↑/↓ highlight, Enter opens, ↓ from search hands
   * off, Escape returns to search). Only the notes *index* page turns this on
   * — embedded lists must not grab document-level keys.
   */
  enableKeyboardNav?: boolean
}

const initialVisibleItems = 10

export function NoteList({
  baseQuery = "",
  query,
  onQueryChange,
  enableKeyboardNav = false,
}: NoteListProps) {
  const navigate = useNavigate()

  const [deferredQuery] = useDebounce(query, 150)

  // A query with text (or a block-scoped `type:`) resolves to BLOCKS: the
  // results are the matching blocks themselves, at any depth. A query that
  // only names notes (`tag:`, a date, nothing at all) keeps the note listing —
  // see `resolvesToBlocks`.
  const source = useBlockSearchSource()
  const { mode, hits, notes: noteResults } = useSearchResults(`${baseQuery} ${deferredQuery}`)
  const showBlocks = mode === "blocks"

  const [numVisibleItems, setNumVisibleItems] = useState(initialVisibleItems)

  // The two modes differ only in WHICH ROOTS are listed. A note is a node
  // whose children are its blocks (docs/graph-schema-v2.md), so a note is a
  // root row exactly as a matched block is — and from here down there is one
  // tree, one keyboard, one renderer.
  const noteHits = React.useMemo(
    () => (showBlocks ? [] : noteResults.map((note) => source.noteHit(note))),
    [showBlocks, noteResults, source],
  )

  // Results are a tree: `rows` is the visible flattening, expanded rows
  // resolving their children lazily (and once) through the data source.
  const { rows, expand, collapse, toggle } = useBlockResultTree({
    hits: showBlocks ? hits : noteHits,
    source,
    limit: numVisibleItems,
    resetKey: `${mode}:${deferredQuery}`,
  })

  const totalResults = showBlocks ? hits.length : noteResults.length
  const { activeIndex, setActiveIndex, containerRef } = useListKeyboardNav({
    enabled: enableKeyboardNav,
    count: rows.length,
    resetKey: deferredQuery,
    onActivate: (index) => {
      const row = rows[index]
      if (row) navigate(blockHitNavigation(row.hit))
    },
    // `→` opens a result in place; `←` closes it, or — on a row that is
    // already closed — steps out to the parent it was revealed under.
    onExpand: (index) => {
      const row = rows[index]
      if (row) expand(row)
    },
    onCollapse: (index) => {
      const row = rows[index]
      if (!row) return
      if (row.expanded) {
        collapse(row)
        return
      }
      const parentIndex = rows.findIndex((other) => other.key === row.parentKey)
      if (parentIndex !== -1) setActiveIndex(parentIndex)
    },
  })

  const [bottomRef, bottomInView] = useInView()

  const loadMore = React.useCallback(() => {
    setNumVisibleItems((num) => Math.min(num + 10, totalResults))
  }, [totalResults])

  React.useEffect(() => {
    if (bottomInView) {
      // Load more notes when the user scrolls to the bottom of the list
      loadMore()
    }
  }, [bottomInView, loadMore])

  const numVisibleTags = 4

  const sortedTagFrequencies = React.useMemo(() => {
    const frequencyMap = new Map<string, number>()

    const tags = noteResults.flatMap((result) => result.tags)

    for (const tag of tags) {
      frequencyMap.set(tag, (frequencyMap.get(tag) ?? 0) + 1)
    }

    const frequencyEntries = [...frequencyMap.entries()]

    return (
      frequencyEntries
        // Filter out tags that every note has
        .filter(([, frequency]) => frequency < noteResults.length)
        // Filter out parent tags if the all the childs tag has the same frequency
        .filter(([tag, frequency]) => {
          const childTags = frequencyEntries.filter(
            ([otherTag]) => otherTag !== tag && otherTag.startsWith(tag),
          )

          if (childTags.length === 0) return true

          return !childTags.every(([, otherFrequency]) => otherFrequency === frequency)
        })
        .sort((a, b) => {
          return b[1] - a[1]
        })
    )
  }, [noteResults])

  const filters = React.useMemo(() => {
    return parseQuery(query).filters
  }, [query])

  const tagFilters = React.useMemo(() => {
    return filters.filter((filter) => filter.key === "tag")
  }, [filters])

  // `in:` scopes — shown as pills naming the note (or block), since the
  // query carries an id.
  const scopeFilters = React.useMemo(() => {
    return filters.filter((filter) => filter.key === "in")
  }, [filters])

  return (
    <>
      <div ref={containerRef}>
        <div className="flex flex-col gap-4">
          <div className="flex gap-2">
            <SearchInput
              placeholder={`Search ${pluralize(noteResults.length, "note")}…`}
              shortcut={["/"]}
              value={query}
              autoCapitalize="off"
              spellCheck="false"
              suggest
              onChange={(value) => {
                onQueryChange(value)

                // Reset the number of visible notes when the user starts typing
                setNumVisibleItems(initialVisibleItems)
              }}
            />
          </div>
          {sortedTagFrequencies.length > 0 ||
          tagFilters.length > 0 ||
          scopeFilters.length > 0 ||
          deferredQuery ? (
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap gap-2 empty:hidden">
                {scopeFilters.flatMap((filter) =>
                  filter.values.map((value) => (
                    <ScopePill
                      key={`${filter.exclude ? "-" : ""}in:${value}`}
                      value={value}
                      exclude={filter.exclude}
                      // Remove the scope from the query (the whole qualifier:
                      // a comma list goes as one).
                      onRemove={() => onQueryChange(removeQualifier(query, filter))}
                    />
                  )),
                )}
                {sortedTagFrequencies.length > 0 || tagFilters.length > 0 ? (
                  <>
                    {tagFilters.map((filter) => (
                      <PillButton
                        key={filter.values.join(",")}
                        data-tag={filter.values.join(",")}
                        variant="primary"
                        onClick={() => {
                          // Remove the tag qualifier from the query
                          onQueryChange(removeQualifier(query, filter))

                          // TODO: Move focus
                        }}
                      >
                        <TagFillIcon12 />
                        {filter.exclude ? <span className="italic">not</span> : null}
                        {filter.values.map((value, index) => (
                          <React.Fragment key={value}>
                            {index > 0 ? <span>or</span> : null}
                            <span key={value}>{value}</span>
                          </React.Fragment>
                        ))}
                        <XIcon12 className="-mr-0.5" />
                      </PillButton>
                    ))}
                    {sortedTagFrequencies.slice(0, numVisibleTags).map(([tag, frequency]) => (
                      <PillButton
                        key={tag}
                        data-tag={tag}
                        onClick={(event) => {
                          const qualifier = `${event.shiftKey ? "-" : ""}tag:${tag}`

                          onQueryChange(query ? `${query} ${qualifier}` : qualifier)

                          // Move focus
                          setTimeout(() => {
                            document.querySelector<HTMLElement>(`[data-tag="${tag}"]`)?.focus()
                          })
                        }}
                      >
                        <TagIcon12 className="text-text-secondary" />
                        {tag}
                        <span className="text-text-secondary">{formatNumber(frequency)}</span>
                      </PillButton>
                    ))}
                    {sortedTagFrequencies.length > numVisibleTags ? (
                      <DropdownMenu>
                        <DropdownMenu.Trigger
                          render={
                            <PillButton variant="dashed" className="data-[popup-open]:bg-bg-hover">
                              More…
                            </PillButton>
                          }
                        />
                        <DropdownMenu.Content width={300}>
                          {sortedTagFrequencies.slice(numVisibleTags).map(([tag, frequency]) => (
                            <DropdownMenu.Item
                              key={tag}
                              icon={<TagIcon16 />}
                              trailingVisual={
                                <span className="text-text-secondary">{frequency}</span>
                              }
                              onClick={(event) => {
                                const qualifier = `${event.shiftKey ? "-" : ""}tag:${tag}`
                                onQueryChange(query ? `${query} ${qualifier}` : qualifier)
                              }}
                            >
                              {tag}
                            </DropdownMenu.Item>
                          ))}
                        </DropdownMenu.Content>
                      </DropdownMenu>
                    ) : null}
                  </>
                ) : null}
              </div>
              {deferredQuery ? (
                <div data-testid="result-count" className="text-sm text-text-secondary leading-4">
                  {/* Counts the MATCHED blocks. Children revealed by expanding
                      a result are context, not matches, so they never inflate
                      it — which is what makes the number checkable. */}
                  {showBlocks
                    ? `${pluralize(totalResults, "matching block")} in ${pluralize(noteResults.length, "note")}`
                    : pluralize(totalResults, "result")}
                </div>
              ) : null}
            </div>
          ) : null}
          {/* One renderer, whatever the roots are: matched blocks, or the
              notes themselves. Expand a row to read what is inside it. */}
          <SearchResults
            variant="page"
            rows={rows}
            activeIndex={activeIndex}
            onActivate={(hit) => navigate(blockHitNavigation(hit))}
            onToggle={toggle}
          />
        </div>

        {totalResults > numVisibleItems ? (
          <Button ref={bottomRef} className="mt-4 w-full" onClick={loadMore}>
            Load more
          </Button>
        ) : null}
      </div>
    </>
  )
}
