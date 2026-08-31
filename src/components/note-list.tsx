import { Link, useNavigate } from "@tanstack/react-router"
import { useAtom } from "jotai"
import React, { useState } from "react"
import { useInView } from "react-intersection-observer"
import { useDebounce } from "use-debounce"
import { noteListViewAtom } from "../global-state"
import { useBlockResultTree } from "../hooks/block-result-tree"
import { useListKeyboardNav } from "../hooks/list-keyboard-nav"
import { useBlockSearchSource, useSearchResults } from "../hooks/search-results"
import { cx } from "../utils/cx"
import { parseQuery } from "../utils/search"
import { formatNumber, pluralize } from "../utils/pluralize"
import { Button } from "./button"
import { Dice } from "./dice"
import { DropdownMenu } from "./dropdown-menu"
import { IconButton } from "./icon-button"
import {
  GlobeIcon16,
  GridIcon16,
  ListIcon16,
  PinFillIcon12,
  TagFillIcon12,
  TagIcon12,
  TagIcon16,
  XIcon12,
} from "./icons"
import { LinkHighlightProvider } from "./link-highlight-provider"
import { NoteFavicon } from "./note-favicon"
import { NotePreviewCard } from "./note-preview-card"
import { PillButton } from "./pill-button"
import { SearchInput } from "./search-input"
import { SearchResults, blockHitNavigation } from "./search-results"

type View = "grid" | "list"

const viewIcons: Record<View, React.ReactNode> = {
  grid: <GridIcon16 />,
  list: <ListIcon16 />,
}

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
  // Grid/list layout is a local preference, persisted outside the URL.
  const [view, setView] = useAtom(noteListViewAtom)

  const [deferredQuery] = useDebounce(query, 150)

  // A query with text (or a block-scoped `type:`) resolves to BLOCKS: the
  // results are the matching blocks themselves, at any depth. A query that
  // only names notes (`tag:`, a date, nothing at all) keeps the note listing —
  // see `resolvesToBlocks`.
  const source = useBlockSearchSource()
  const { mode, hits, notes: noteResults } = useSearchResults(`${baseQuery} ${deferredQuery}`)
  const showBlocks = mode === "blocks"

  const [numVisibleItems, setNumVisibleItems] = useState(initialVisibleItems)

  // Block results are a tree: `rows` is the visible flattening, expanded rows
  // resolving their children lazily (and once) through the data source.
  const { rows, expand, collapse, toggle } = useBlockResultTree({
    hits,
    source,
    limit: numVisibleItems,
    resetKey: deferredQuery,
  })

  // The rows the keyboard highlight roves over.
  const visibleResults = noteResults.slice(0, numVisibleItems)
  const totalResults = showBlocks ? hits.length : noteResults.length
  const { activeIndex, setActiveIndex, containerRef } = useListKeyboardNav({
    enabled: enableKeyboardNav,
    count: showBlocks ? rows.length : visibleResults.length,
    resetKey: deferredQuery,
    onActivate: (index) => {
      if (showBlocks) {
        const row = rows[index]
        if (row) navigate(blockHitNavigation(row.hit))
        return
      }
      const note = noteResults[index]
      if (note) {
        navigate({ to: "/notes/$", params: { _splat: note.id }, search: { query: undefined } })
      }
    },
    // `→` opens a result in place; `←` closes it, or — on a row that is
    // already closed — steps out to the parent it was revealed under.
    onExpand: showBlocks
      ? (index) => {
          const row = rows[index]
          if (row) expand(row)
        }
      : undefined,
    onCollapse: showBlocks
      ? (index) => {
          const row = rows[index]
          if (!row) return
          if (row.expanded) {
            collapse(row)
            return
          }
          const parentIndex = rows.findIndex((other) => other.key === row.parentKey)
          if (parentIndex !== -1) setActiveIndex(parentIndex)
        }
      : undefined,
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

  const highlightPaths = React.useMemo(() => {
    return filters
      .filter((filter) => !filter.exclude)
      .flatMap((filter) => {
        switch (filter.key) {
          case "tag":
            return filter.values.map((value) => `/tags/${value}`)
          case "link":
            return filter.values.map((value) => `/${value}`)
          case "date":
            return filter.values.map((value) => `/${value}`)
          default:
            return []
        }
      })
  }, [filters])

  return (
    <LinkHighlightProvider href={highlightPaths}>
      <div ref={containerRef}>
        <div className="flex flex-col gap-4">
          <div className="flex gap-2">
            <SearchInput
              placeholder={`Search ${pluralize(noteResults.length, "note")}…`}
              shortcut={["/"]}
              value={query}
              autoCapitalize="off"
              spellCheck="false"
              onChange={(value) => {
                onQueryChange(value)

                // Reset the number of visible notes when the user starts typing
                setNumVisibleItems(initialVisibleItems)
              }}
            />
            <DiceButton
              disabled={noteResults.length === 0}
              onClick={() => {
                const resultsCount = noteResults.length
                const randomIndex = Math.floor(Math.random() * resultsCount)
                navigate({ to: `/notes/${noteResults[randomIndex].id}` })
              }}
            />
            {/* Grid/list is how the note LISTING is laid out; block results
                have their own shape, so the control retires while they show. */}
            {showBlocks ? null : (
              <DropdownMenu>
                <DropdownMenu.Trigger
                  render={
                    <IconButton
                      aria-label="View"
                      className="h-10 w-10 shrink-0 rounded-lg bg-bg-secondary hover:bg-bg-secondary-hover! data-[popup-open]:bg-bg-secondary-hover! active:bg-bg-secondary-active! coarse:h-12 coarse:w-12"
                    >
                      {viewIcons[view]}
                    </IconButton>
                  }
                />
                <DropdownMenu.Content align="end" width={160}>
                  <DropdownMenu.Group>
                    <DropdownMenu.GroupLabel>View as</DropdownMenu.GroupLabel>
                    <DropdownMenu.Item
                      icon={<GridIcon16 />}
                      onClick={() => setView("grid")}
                      selected={view === "grid"}
                    >
                      Grid
                    </DropdownMenu.Item>
                    <DropdownMenu.Item
                      icon={<ListIcon16 />}
                      onClick={() => setView("list")}
                      selected={view === "list"}
                    >
                      List
                    </DropdownMenu.Item>
                  </DropdownMenu.Group>
                </DropdownMenu.Content>
              </DropdownMenu>
            )}
          </div>
          {sortedTagFrequencies.length > 0 || tagFilters.length > 0 || deferredQuery ? (
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap gap-2 empty:hidden">
                {sortedTagFrequencies.length > 0 || tagFilters.length > 0 ? (
                  <>
                    {tagFilters.map((filter) => (
                      <PillButton
                        key={filter.values.join(",")}
                        data-tag={filter.values.join(",")}
                        variant="primary"
                        onClick={() => {
                          const text = `${filter.exclude ? "-" : ""}tag:${filter.values.join(",")}`

                          const index = query.indexOf(text)

                          if (index === -1) return

                          const newQuery =
                            query.slice(0, index) + query.slice(index + text.length).trimStart()

                          // Remove the tag qualifier from the query
                          onQueryChange(newQuery.trim())

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
          {showBlocks ? (
            <SearchResults
              variant="page"
              rows={rows}
              activeIndex={activeIndex}
              onActivate={(hit) => navigate(blockHitNavigation(hit))}
              onToggle={toggle}
            />
          ) : null}
          {!showBlocks && view === "grid" ? (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-4">
              {visibleResults.map(({ id }, index) => (
                <div
                  key={id}
                  data-list-index={index}
                  className={cx(
                    // The keyboard highlight on a card is a ring in the same
                    // accent (the card's own surface must stay readable).
                    activeIndex === index &&
                      "rounded-[calc(var(--border-radius-base)+6px)] ring-2 ring-[color:var(--color-border-focus)]",
                  )}
                >
                  <NotePreviewCard id={id} />
                </div>
              ))}
            </div>
          ) : null}
          {!showBlocks && view === "list" ? (
            <ul className="flex flex-col gap-0.5">
              {visibleResults.map((note, index) => {
                return (
                  <li key={note.id} data-list-index={index}>
                    <Link
                      to="/notes/$"
                      params={{ _splat: note.id }}
                      search={{
                        query: undefined,
                      }}
                      className={cx(
                        "focus-ring flex h-10 items-center rounded-lg px-3 hover:bg-bg-hover coarse:h-12 coarse:p-4",
                        // The roving keyboard highlight — the editor's
                        // selection surface (same tokens, see block-editor.css).
                        activeIndex === index && "list-highlight",
                      )}
                    >
                      <NoteFavicon note={note} className="mr-3 coarse:mr-4" />
                      {note.pinned ? (
                        <PinFillIcon12 className="mr-2 coarse:mr-3 shrink-0 text-text-pinned" />
                      ) : null}
                      {note?.frontmatter?.gist_id ? (
                        <GlobeIcon16 className="mr-2 coarse:mr-3 shrink-0 text-border-focus" />
                      ) : null}
                      <span className="truncate text-text-secondary">
                        {/* Show the filename (id), matching the page header and
                            sidebar — not the note's first heading. */}
                        <span className="text-text">{note.id}</span>
                      </span>
                    </Link>
                  </li>
                )
              })}
            </ul>
          ) : null}
        </div>

        {totalResults > numVisibleItems ? (
          <Button ref={bottomRef} className="mt-4 w-full" onClick={loadMore}>
            Load more
          </Button>
        ) : null}
      </div>
    </LinkHighlightProvider>
  )
}

function DiceButton({ disabled = false, onClick }: { disabled?: boolean; onClick?: () => void }) {
  const [number, setNumber] = React.useState(() => Math.floor(Math.random() * 6) + 1)
  return (
    <IconButton
      disabled={disabled}
      aria-label="Roll the dice"
      className="group/dice h-10 w-10 shrink-0 rounded-lg bg-bg-secondary hover:bg-bg-secondary-hover! active:bg-bg-secondary-active! coarse:h-12 coarse:w-12"
      onClick={() => {
        setNumber(Math.floor(Math.random() * 6) + 1)
        onClick?.()
      }}
    >
      <Dice
        number={number}
        className="group-hover/dice:rotate-[20deg] group-active/dice:rotate-[100deg] group-hover/dice:-translate-y-0.5"
      />
    </IconButton>
  )
}
