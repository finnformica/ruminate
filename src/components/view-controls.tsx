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
import { Button } from "./button"
import { DropdownMenu } from "./dropdown-menu"
import { IconButton } from "./icon-button"
import { FilterIcon16, NoteIcon16, SortAlphabetAscIcon16 } from "./icons"
import { QualifierPicture, anyQualifierPicture } from "./qualifier-suggestions"

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
 * block's pin saved (docs/metadata.md), and the menu behind it grows a
 * footer offering to settle it. The dot says which half moved; the buttons
 * act on the WHOLE view, because a pin holds one view and saving half of it
 * would leave the other half behind.
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

/**
 * What the pin's saved view is worth doing about, when the view has moved
 * away from it. Both act on the whole view — filter and sort together — so
 * settling one from the Sort menu keeps whatever the Filter is set to.
 */
export interface PinnedDefaultActions {
  /** Whether THIS menu's half differs from the pin (drives the dot). */
  dirty: boolean
  /** Write the whole view onto the pin. */
  onUpdateDefault: () => void
  /** Put the pin's whole view back. */
  onResetDefault: () => void
}

function DefaultFooter({ onUpdateDefault, onResetDefault }: PinnedDefaultActions) {
  return (
    <div className="flex items-center gap-1.5">
      <Button size="small" className="w-0 grow whitespace-nowrap" onClick={onUpdateDefault}>
        Update to default
      </Button>
      <Button size="small" className="w-0 grow whitespace-nowrap" onClick={onResetDefault}>
        Reset to default
      </Button>
    </div>
  )
}

export function FilterMenu({
  filter,
  onFilterChange,
  roots,
  focusBlockId,
  onFocusBlock,
  pinned,
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
  /** The pin's saved view, when this block has one; absent = nothing saved,
   * so there is nothing to settle. */
  pinned?: PinnedDefaultActions
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
            {pinned?.dirty ? <DirtyDot /> : null}
          </IconButton>
        }
      />
      <DropdownMenu.Content
        align="end"
        width={pinned?.dirty ? 320 : undefined}
        footer={pinned?.dirty ? <DefaultFooter {...pinned} /> : undefined}
      >
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
                    // The query box picker's own leading slot: a fixed,
                    // centred box, so a three-character glyph, a
                    // one-character one and a 16px icon share an axis.
                    icon={
                      anyQualifierPicture(branch.options, branch.key) ? (
                        <QualifierPicture item={option} qualifierKey={branch.key} />
                      ) : undefined
                    }
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
  pinned,
}: {
  /** The view's sort (`text`, `text:desc`), or empty for document order. */
  sort: string
  onSortChange: (sort: string) => void
  /** The pin's saved view, when this block has one. */
  pinned?: PinnedDefaultActions
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
            {pinned?.dirty ? <DirtyDot /> : null}
          </IconButton>
        }
      />
      <DropdownMenu.Content
        align="end"
        width={pinned?.dirty ? 320 : undefined}
        footer={pinned?.dirty ? <DefaultFooter {...pinned} /> : undefined}
      >
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
                  icon={<QualifierPicture item={step} qualifierKey="sort" />}
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
