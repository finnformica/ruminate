import React from "react"
import { cx } from "../utils/cx"
import {
  clearFilterKey,
  describeBranch,
  describeFilter,
  describeSort,
  filterBranches,
  filterValues,
  sortBranches,
  sortDirections,
  toggleFilterValue,
} from "../utils/view-filter"
import { DropdownMenu } from "./dropdown-menu"
import { IconButton } from "./icon-button"
import { FilterIcon16, NoteIcon16, SortAlphabetAscIcon16 } from "./icons"

/**
 * **The note header's Sort and Filter, beside its ⋯ menu.**
 *
 * Both write the query language (docs/query-language.md): Filter sets the
 * view's `filter` (`type:todo`), Sort its `sort` (`text:desc`), and the page
 * narrows the walk by them through the search engine
 * (`src/utils/view-narrowing.ts`). Each menu branches the way typing
 * branches — a top-level row per qualifier, its values in the submenu — and
 * both the keys and the values are read from the query box's own picker
 * vocabulary (`src/utils/view-filter.ts`), so the menu and the box can never
 * offer different things.
 *
 * A button carries a **dot** when what is on screen differs from what the
 * block's pin saved (docs/metadata.md): the view is showing something the
 * pin would not bring back, and the header offers to update it.
 */

/** A row that can be the view's root — what `in:` names. */
export interface RootOption {
  id: string
  /** How the row reads: the block's own text. */
  text: string
}

/** The dot on a button whose value is not the pinned default's. */
function DirtyDot() {
  return (
    <span
      aria-hidden
      className="absolute right-0.5 top-0.5 size-1.5 rounded-full bg-border-focus"
    />
  )
}

/** A value row: its markdown glyph where it has one (a `type:` row), so the
 * menu reads as the query box's picker does. */
function ValueGlyph({ glyph }: { glyph?: string }) {
  if (!glyph) return null
  return (
    <span aria-hidden className="w-6 shrink-0 whitespace-nowrap font-mono text-text-tertiary">
      {glyph}
    </span>
  )
}

export function FilterMenu({
  filter,
  onFilterChange,
  roots,
  focusBlockId,
  onFocusBlock,
  dirty = false,
}: {
  /** The view's filter, as the query language writes it. */
  filter: string
  onFilterChange: (filter: string) => void
  /** The blocks the view could be rooted at — what the `in:` branch offers. */
  roots: readonly RootOption[]
  /** The block the page is rooted at now, or null for the whole note. */
  focusBlockId: string | null
  /** Root the view at a block, or at the note (`null`). */
  onFocusBlock: (id: string | null) => void
  /** Whether this differs from what the pin saved. */
  dirty?: boolean
}) {
  // Built once a render: `date:` resolves its shortcuts against the clock.
  const branches = React.useMemo(() => filterBranches(), [])
  const summary = describeFilter(filter)
  const active = summary !== ""
  const rootedAt = roots.find((root) => root.id === focusBlockId)

  return (
    <DropdownMenu modal={false}>
      <DropdownMenu.Trigger
        render={
          <IconButton
            aria-label={summary ? `Filter: ${summary}` : "Filter"}
            size="small"
            disableTooltip
            className="relative shrink-0"
          >
            <FilterIcon16 className={cx(active && "text-text")} />
            {dirty ? <DirtyDot /> : null}
          </IconButton>
        }
      />
      <DropdownMenu.Content align="end">
        {/* One branch per qualifier the query language has — the query box's
            own keys and values, in its own order. */}
        {branches.map((branch) => {
          const chosen = filterValues(filter, branch.key)
          return (
            <DropdownMenu.Submenu key={branch.key}>
              <DropdownMenu.SubmenuTrigger value={describeBranch(filter, branch) || "Any"}>
                {branch.label}
              </DropdownMenu.SubmenuTrigger>
              <DropdownMenu.Content align="start" side="left">
                <DropdownMenu.Item
                  selected={chosen.length === 0}
                  closeOnClick={false}
                  onClick={() => onFilterChange(clearFilterKey(filter, branch.key))}
                >
                  Any
                </DropdownMenu.Item>
                <DropdownMenu.Separator />
                {branch.options.map((option) => (
                  <DropdownMenu.Item
                    key={option.value}
                    selected={chosen.includes(option.value)}
                    closeOnClick={false}
                    icon={option.glyph ? <ValueGlyph glyph={option.glyph} /> : undefined}
                    onClick={() =>
                      onFilterChange(toggleFilterValue(filter, branch.key, option.value))
                    }
                  >
                    {option.label ?? option.value}
                  </DropdownMenu.Item>
                ))}
              </DropdownMenu.Content>
            </DropdownMenu.Submenu>
          )
        })}

        {/* `in:` — where the view starts. Inside a note that is focusing, so
            picking one is the same navigation the bullet and `f` do. */}
        <DropdownMenu.Submenu>
          <DropdownMenu.SubmenuTrigger
            icon={<NoteIcon16 />}
            value={rootedAt ? rootedAt.text : "Whole note"}
          >
            In
          </DropdownMenu.SubmenuTrigger>
          <DropdownMenu.Content align="start" side="left">
            <DropdownMenu.Item selected={focusBlockId === null} onClick={() => onFocusBlock(null)}>
              Whole note
            </DropdownMenu.Item>
            {roots.length > 0 ? <DropdownMenu.Separator /> : null}
            {roots.map((root) => (
              <DropdownMenu.Item
                key={root.id}
                selected={root.id === focusBlockId}
                onClick={() => onFocusBlock(root.id)}
              >
                {root.text || "Untitled block"}
              </DropdownMenu.Item>
            ))}
          </DropdownMenu.Content>
        </DropdownMenu.Submenu>

        <DropdownMenu.Separator />
        <DropdownMenu.Item disabled={filter === ""} onClick={() => onFilterChange("")}>
          Clear filter
        </DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu>
  )
}

export function SortMenu({
  sort,
  onSortChange,
  dirty = false,
}: {
  /** The view's sort (`text`, `text:desc`), or empty for document order. */
  sort: string
  onSortChange: (sort: string) => void
  /** Whether this differs from what the pin saved. */
  dirty?: boolean
}) {
  const summary = describeSort(sort)
  const active = summary !== ""
  const [key, direction] = sort
    .trim()
    .replace(/^sort:/, "")
    .split(":")

  return (
    <DropdownMenu modal={false}>
      <DropdownMenu.Trigger
        render={
          <IconButton
            aria-label={summary ? `Sort: ${summary}` : "Sort"}
            size="small"
            disableTooltip
            className="relative shrink-0"
          >
            <SortAlphabetAscIcon16 className={cx(active && "text-text")} />
            {dirty ? <DirtyDot /> : null}
          </IconButton>
        }
      />
      <DropdownMenu.Content align="end">
        {/* Document order is the note's own order, and the absence of a sort. */}
        <DropdownMenu.Item selected={!active} onClick={() => onSortChange("")}>
          Document order
        </DropdownMenu.Item>
        <DropdownMenu.Separator />
        {/* One branch per key, its directions inside — the two steps the
            query box's `sort:` picker walks through, from the same source. */}
        {sortBranches().map((option) => (
          <DropdownMenu.Submenu key={option.value}>
            <DropdownMenu.SubmenuTrigger
              value={
                key === option.value
                  ? direction === "desc"
                    ? "Descending"
                    : "Ascending"
                  : undefined
              }
            >
              {option.label ?? option.value}
            </DropdownMenu.SubmenuTrigger>
            <DropdownMenu.Content align="start" side="left" width={200}>
              {sortDirections(option.value).map((step) => (
                <DropdownMenu.Item
                  key={step.value}
                  selected={sort.trim().replace(/^sort:/, "") === step.value}
                  icon={<ValueGlyph glyph={step.glyph} />}
                  onClick={() => onSortChange(step.value)}
                >
                  {step.label ?? step.value}
                </DropdownMenu.Item>
              ))}
            </DropdownMenu.Content>
          </DropdownMenu.Submenu>
        ))}
      </DropdownMenu.Content>
    </DropdownMenu>
  )
}
