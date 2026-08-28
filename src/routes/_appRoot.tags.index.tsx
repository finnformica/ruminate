import { createFileRoute, Link } from "@tanstack/react-router"
import { useAtom, useAtomValue } from "jotai"
import React, { useDeferredValue, useMemo, useState } from "react"
import { DropdownMenu } from "../components/dropdown-menu"
import { IconButton } from "../components/icon-button"
import {
  ChevronRightIcon12,
  GridIcon16,
  ListIcon16,
  SortAlphabetAscIcon16,
  SortNumberDescIcon16,
  TagIcon16,
} from "../components/icons"
import { PageLayout } from "../components/page-layout"
import { PillButton } from "../components/pill-button"
import { SearchInput } from "../components/search-input"
import { noteListViewAtom, sortedTagEntriesAtom, tagSearcherAtom } from "../global-state"
import { useListKeyboardNav } from "../hooks/list-keyboard-nav"
import { cx } from "../utils/cx"
import { pluralize } from "../utils/pluralize"

type View = "grid" | "list"

const viewIcons: Record<View, React.ReactNode> = {
  grid: <GridIcon16 />,
  list: <ListIcon16 />,
}

type RouteSearch = {
  query: string | undefined
  sort: "name" | "count"
}

export const Route = createFileRoute("/_appRoot/tags/")({
  validateSearch: (search: Record<string, unknown>): RouteSearch => {
    return {
      query: typeof search.query === "string" ? search.query : undefined,
      sort: search.sort === "name" || search.sort === "count" ? search.sort : "name",
    }
  },
  component: RouteComponent,
  head: () => ({
    meta: [{ title: "Tags · Ruminate" }],
  }),
})

function RouteComponent() {
  const { query, sort } = Route.useSearch()
  const navigate = Route.useNavigate()
  // Grid/list layout is a local preference, persisted outside the URL.
  const [view, setView] = useAtom(noteListViewAtom)

  const sortedTagEntries = useAtomValue(sortedTagEntriesAtom)
  const tagSearcher = useAtomValue(tagSearcherAtom)

  const deferredQuery = useDeferredValue(query)

  const searchResults = useMemo(() => {
    const results = deferredQuery ? tagSearcher.search(deferredQuery) : sortedTagEntries

    return results.sort((a, b) => {
      // Sort by count descending
      if (sort === "count") {
        return b[1].length - a[1].length
      }
      // Sort by name ascending
      return a[0].localeCompare(b[0])
    })
  }, [tagSearcher, deferredQuery, sortedTagEntries, sort])

  const tagTree = useMemo(() => buildTagTree(searchResults, sort), [searchResults, sort])

  // The keyboard highlight roves over tags in the order the current view
  // renders them: the flat results in grid view, a DFS of the tree in list
  // view (collapse state is per-row local, so hidden rows are still counted —
  // an accepted edge; Enter on one still opens the tag).
  const treeOrder = useMemo(() => {
    const order: string[] = []
    const walk = (nodes: TagTreeNode[], path: string[]) => {
      for (const node of nodes) {
        const fullPath = [...path, node.name]
        order.push(fullPath.join("/"))
        walk(node.children, fullPath)
      }
    }
    walk(tagTree, [])
    return order
  }, [tagTree])
  const navOrder = view === "grid" ? searchResults.map(([tag]) => tag) : treeOrder
  const { activeIndex, containerRef } = useListKeyboardNav({
    count: navOrder.length,
    resetKey: deferredQuery ?? "",
    onActivate: (index) => {
      const tag = navOrder[index]
      if (tag) navigate({ to: "/", search: { query: `tag:${tag}` } })
    },
  })
  const activeTag = activeIndex !== null ? (navOrder[activeIndex] ?? null) : null
  const treeIndexByTag = useMemo(
    () => new Map(treeOrder.map((tag, index) => [tag, index])),
    [treeOrder],
  )

  return (
    <PageLayout title="Tags" icon={<TagIcon16 />}>
      <div ref={containerRef} className="flex flex-col gap-4 px-4 pt-0 pb-[50vh]">
        <div className="flex flex-col gap-3">
          <div className="flex gap-2">
            <SearchInput
              placeholder={`Search ${pluralize(sortedTagEntries.length, "tag")}…`}
              shortcut={["/"]}
              value={query ?? ""}
              onChange={(value) =>
                navigate({
                  search: (prev) => ({
                    ...prev,
                    query: value,
                  }),
                })
              }
            />
            <DropdownMenu>
              <DropdownMenu.Trigger
                render={
                  <IconButton
                    aria-label="Sort"
                    className="h-10 w-10 shrink-0 rounded-lg bg-bg-secondary hover:bg-bg-secondary-hover! data-[popup-open]:bg-bg-secondary-hover! active:bg-bg-secondary-active! coarse:h-12 coarse:w-12"
                  >
                    {sort === "count" ? <SortNumberDescIcon16 /> : <SortAlphabetAscIcon16 />}
                  </IconButton>
                }
              />
              <DropdownMenu.Content align="end" width={160}>
                <DropdownMenu.Group>
                  <DropdownMenu.GroupLabel>Sort by</DropdownMenu.GroupLabel>
                  <DropdownMenu.Item
                    icon={<SortAlphabetAscIcon16 />}
                    onClick={() =>
                      navigate({
                        search: (prev) => ({ ...prev, sort: "name" }),
                        replace: true,
                      })
                    }
                    selected={sort === "name"}
                  >
                    Name
                  </DropdownMenu.Item>
                  <DropdownMenu.Item
                    icon={<SortNumberDescIcon16 />}
                    onClick={() =>
                      navigate({
                        search: (prev) => ({ ...prev, sort: "count" }),
                        replace: true,
                      })
                    }
                    selected={sort === "count"}
                  >
                    Count
                  </DropdownMenu.Item>
                </DropdownMenu.Group>
              </DropdownMenu.Content>
            </DropdownMenu>
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
          </div>
          {deferredQuery ? (
            <span className="text-sm text-text-secondary leading-4">
              {pluralize(searchResults.length, "tag")}
            </span>
          ) : null}
        </div>
        {view === "grid" ? (
          <ul className="flex flex-wrap gap-y-3 gap-x-2">
            {searchResults.map(([tag, noteIds], index) => (
              <li
                key={tag}
                data-list-index={index}
                className={cx(
                  "rounded-full",
                  // The keyboard highlight on a pill is an accent ring (the
                  // pill keeps its own surface) — same accent as the editor's
                  // selection family.
                  activeTag === tag && "ring-2 ring-[color:var(--color-border-focus)]",
                )}
              >
                <PillButton asChild>
                  <Link to="/" search={{ query: `tag:${tag}` }}>
                    {tag}
                    <span className="text-text-secondary">{noteIds.length}</span>
                  </Link>
                </PillButton>
              </li>
            ))}
          </ul>
        ) : (
          <TagTree tree={tagTree} activeTag={activeTag} indexByTag={treeIndexByTag} />
        )}
      </div>
    </PageLayout>
  )
}

type TagTreeNode = {
  name: string
  count: number
  children: TagTreeNode[]
}

/** Build a tree from a flat list of tags */
function buildTagTree(tags: [string, string[]][], sort: "name" | "count"): TagTreeNode[] {
  const tree: TagTreeNode[] = []

  for (const [name, noteIds] of tags) {
    const parts = name.split("/")

    let parent = tree

    for (const part of parts) {
      const existing = parent.find((node) => node.name === part)

      if (existing) {
        parent = existing.children
      } else {
        const node = { name: part, count: noteIds.length, children: [] }
        parent.push(node)
        parent = node.children
      }
    }
  }

  // Sort the tree nodes based on the sort parameter
  const sortNodes = (nodes: TagTreeNode[]): TagTreeNode[] => {
    return nodes
      .sort((a, b) => {
        // Sort by count descending
        if (sort === "count") {
          return b.count - a.count
        }
        // Sort by name ascending
        return a.name.localeCompare(b.name)
      })
      .map((node) => ({
        ...node,
        children: sortNodes(node.children),
      }))
  }

  return sortNodes(tree)
}

type TagTreeProps = {
  tree: TagTreeNode[]
  path?: string[]
  depth?: number
  /** The tag path the keyboard highlight is on (see useListKeyboardNav). */
  activeTag?: string | null
  /** Each tag path's index in the DFS order, for the highlight's scroll hook. */
  indexByTag?: Map<string, number>
}

// TODO: Improve accessibility of the tree
function TagTree({ tree, path = [], depth = 0, activeTag = null, indexByTag }: TagTreeProps) {
  if (tree.length === 0) {
    return null
  }

  return (
    <ul className="flex flex-col gap-3">
      {tree.map((node) => {
        return (
          <TagTreeItem
            key={node.name}
            node={node}
            path={path}
            depth={depth}
            activeTag={activeTag}
            indexByTag={indexByTag}
          />
        )
      })}
    </ul>
  )
}

type TagTreeItemProps = {
  node: TagTreeNode
  path?: string[]
  depth?: number
  activeTag?: string | null
  indexByTag?: Map<string, number>
}

function TagTreeItem({
  node,
  path = [],
  depth = 0,
  activeTag = null,
  indexByTag,
}: TagTreeItemProps) {
  const [expanded, setExpanded] = useState(true)
  const fullPath = [...path, node.name].join("/")

  return (
    <li className="flex flex-col gap-3">
      <div className="flex items-center gap-0.5" style={{ paddingLeft: `calc(${depth} * 1.5rem)` }}>
        <span
          data-list-index={indexByTag?.get(fullPath)}
          className={cx(
            "rounded-full",
            // The keyboard highlight — an accent ring around the row's pill.
            activeTag === fullPath && "ring-2 ring-[color:var(--color-border-focus)]",
          )}
        >
          <PillButton asChild>
            <Link to="/" search={{ query: `tag:${fullPath}` }}>
              {node.name}
              <span className="text-text-secondary">{node.count}</span>
            </Link>
          </PillButton>
        </span>
        {node.children.length ? (
          <IconButton
            aria-label={expanded ? "Collapse" : "Expand"}
            disableTooltip
            size="small"
            className="size-6 p-0 coarse:size-8 coarse:p-0"
            onClick={() => setExpanded(!expanded)}
          >
            <ChevronRightIcon12 className={cx("transition-transform", expanded && "rotate-90")} />
          </IconButton>
        ) : null}
      </div>
      <div className={cx("empty:hidden", !expanded && "hidden")}>
        <TagTree
          key={node.name}
          tree={node.children}
          path={[...path, node.name]}
          depth={depth + 1}
          activeTag={activeTag}
          indexByTag={indexByTag}
        />
      </div>
    </li>
  )
}
