import { cx } from "../utils/cx"
import {
  FILTER_TYPE_OPTIONS,
  SORT_KEYS,
  describeFilter,
  describeSort,
  filterTypes,
  toggleFilterType,
} from "../utils/view-filter"
import { DropdownMenu } from "./dropdown-menu"
import { IconButton } from "./icon-button"
import { FilterIcon16, NoteIcon16, SortAlphabetAscIcon16 } from "./icons"

/**
 * **The note header's Filter and Sort, beside its ⋯ menu.**
 *
 * Both write the query language (docs/query-language.md): Filter sets the
 * view's `filter` (`type:todo`), Sort its `sort` (`text:desc`), and the page
 * narrows the walk by them (`src/data/filter-view.ts`). Each menu branches
 * the way typing branches — a top-level row per qualifier, its values in the
 * submenu — so the menu and the query box offer the same vocabulary and a
 * filter set here can be read, and typed, by hand.
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
  const types = filterTypes(filter)
  const summary = describeFilter(filter)
  const rootedAt = roots.find((root) => root.id === focusBlockId)

  return (
    <DropdownMenu modal={false}>
      <DropdownMenu.Trigger
        render={
          <IconButton
            aria-label={summary ? `Filter: ${summary}` : "Filter"}
            size="small"
            disableTooltip
            className={cx("relative shrink-0", types.length > 0 && "text-text")}
          >
            <FilterIcon16 className={cx(types.length > 0 && "text-text")} />
            {dirty ? <DirtyDot /> : null}
          </IconButton>
        }
      />
      <DropdownMenu.Content align="end">
        {/* `type:` — which kinds of row the view keeps. Several at once is a
            comma list, exactly as it is typed. */}
        <DropdownMenu.Submenu>
          <DropdownMenu.SubmenuTrigger
            icon={<FilterIcon16 />}
            value={types.length > 0 ? describeFilter(filter) : "Any"}
          >
            Type
          </DropdownMenu.SubmenuTrigger>
          <DropdownMenu.Content align="start" side="left">
            <DropdownMenu.Item
              selected={types.length === 0}
              closeOnClick={false}
              onClick={() => onFilterChange("")}
            >
              Any
            </DropdownMenu.Item>
            <DropdownMenu.Separator />
            {FILTER_TYPE_OPTIONS.map((option) => (
              <DropdownMenu.Item
                key={option.value}
                selected={types.includes(option.value)}
                closeOnClick={false}
                icon={
                  <span
                    aria-hidden
                    className="w-6 shrink-0 whitespace-nowrap font-mono text-text-tertiary"
                  >
                    {option.glyph}
                  </span>
                }
                onClick={() => onFilterChange(toggleFilterType(filter, option.value))}
              >
                {option.label ?? option.value}
              </DropdownMenu.Item>
            ))}
          </DropdownMenu.Content>
        </DropdownMenu.Submenu>

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
  const active = sort.trim() !== ""
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
            query box's `sort:` picker walks through. */}
        {SORT_KEYS.map((option) => (
          <DropdownMenu.Submenu key={option.value}>
            <DropdownMenu.SubmenuTrigger
              value={key === option.value ? (direction === "desc" ? "Z–A" : "A–Z") : undefined}
            >
              {option.label}
            </DropdownMenu.SubmenuTrigger>
            <DropdownMenu.Content align="start" side="left" width={180}>
              <DropdownMenu.Item
                selected={key === option.value && direction !== "desc"}
                onClick={() => onSortChange(option.value)}
              >
                Ascending
              </DropdownMenu.Item>
              <DropdownMenu.Item
                selected={key === option.value && direction === "desc"}
                onClick={() => onSortChange(`${option.value}:desc`)}
              >
                Descending
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Submenu>
        ))}
      </DropdownMenu.Content>
    </DropdownMenu>
  )
}
