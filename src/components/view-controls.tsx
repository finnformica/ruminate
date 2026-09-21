import React from "react"
import { cx } from "../utils/cx"
import {
  clearFilterKey,
  describeFilter,
  describeSort,
  FILTER_TYPE_OPTIONS,
  filterValues,
  sortBranches,
  sortDirections,
  toggleFilterValue,
} from "../utils/view-filter"
import { Button } from "./ui/button"
import { DropdownMenu } from "./ui/dropdown-menu"
import { IconButton } from "./ui/icon-button"
import { FilterIcon16, SortAlphabetAscIcon16 } from "./icons"
import { QualifierPicture } from "./qualifier-suggestions"

/**
 * **The note header's Sort and Filter, beside its ⋯ menu.**
 *
 * Both write the query language (docs/query-language.md): Filter sets the
 * view's `filter` (`type:todo`), Sort its `sort` (`text:desc`), and the page
 * narrows the walk by them through the search engine
 * (`src/utils/view-narrowing.ts`). Each menu branches the way typing
 * branches — a row per qualifier, its values in the submenu — and the values
 * are read from the query box's own picker vocabulary
 * (`src/utils/view-filter.ts`), so the menu and the box can never offer
 * different things.
 *
 * **Filter offers `type:` and nothing else**, though a filter typed by hand
 * understands the whole language. The rest of the vocabulary is note-level:
 * inside a single note it holds for every row or for none, so as a menu item
 * it is not a filter but a switch between the whole note and a blank page.
 * `in:` is left out too — it names the view's root, which is what focusing
 * already does (a bullet, `f`, the breadcrumb). The one branch still sits in
 * a submenu: it keeps the shape a second qualifier would need, and keeps the
 * top of the menu a list of what can be filtered rather than of block types.
 *
 * A button carries a **dot** when what is on screen differs from the view
 * this note or block saved (docs/metadata.md), and the menu behind it grows
 * a footer offering to settle it. The dot says which half moved; the buttons
 * act on the WHOLE view, because a node holds one view and saving half of it
 * would leave the other half behind.
 */

/** The dot on a button whose value is not the saved view's. */
function DirtyDot() {
  return (
    <span
      aria-hidden
      className="absolute right-0.5 top-0.5 size-1.5 rounded-full bg-border-focus"
    />
  )
}

/**
 * What a saved view is worth doing about, when the view has moved away from
 * it. Both act on the whole view — filter and sort together — so settling
 * one from the Sort menu keeps whatever the Filter is set to.
 */
export interface SavedViewActions {
  /** Whether THIS menu's half differs from what was saved (drives the dot). */
  dirty: boolean
  /** Write the whole view onto the note or block it is rooted at. */
  onUpdateDefault: () => void
  /** Put the whole saved view back. */
  onResetDefault: () => void
}

function DefaultFooter({ onUpdateDefault, onResetDefault }: SavedViewActions) {
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
  saved,
}: {
  /** The view's filter, as the query language writes it. */
  filter: string
  onFilterChange: (filter: string) => void
  /** The note or block's saved view, when this session may write one. */
  saved?: SavedViewActions
}) {
  const summary = describeFilter(filter)
  const active = summary !== ""
  const chosen = filterValues(filter, "type")

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
            {saved?.dirty ? <DirtyDot /> : null}
          </IconButton>
        }
      />
      <DropdownMenu.Content
        align="end"
        width={saved?.dirty ? 320 : undefined}
        footer={saved?.dirty ? <DefaultFooter {...saved} /> : undefined}
      >
        {/* One branch per qualifier the menu offers. The block types come
            straight from the query box's picker; several at once is a comma
            list, exactly as it is typed. */}
        <DropdownMenu.Submenu>
          <DropdownMenu.SubmenuTrigger value={describeFilter(filter) || "Any"}>
            Type
          </DropdownMenu.SubmenuTrigger>
          <DropdownMenu.Content align="start" side="left">
            <DropdownMenu.Item
              selected={chosen.length === 0}
              closeOnClick={false}
              onClick={() => onFilterChange(clearFilterKey(filter, "type"))}
            >
              Any
            </DropdownMenu.Item>
            <DropdownMenu.Separator />
            {FILTER_TYPE_OPTIONS.map((option) => (
              <DropdownMenu.Item
                key={option.value}
                selected={chosen.includes(option.value)}
                closeOnClick={false}
                // The picker's own leading slot: a fixed, centred box, so a
                // three-character glyph, a one-character one and a 16px icon
                // share an axis.
                icon={<QualifierPicture item={option} qualifierKey="type" />}
                onClick={() => onFilterChange(toggleFilterValue(filter, "type", option.value))}
              >
                {option.label ?? option.value}
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
  saved,
}: {
  /** The view's sort (`text`, `text:desc`), or empty for document order. */
  sort: string
  onSortChange: (sort: string) => void
  /** The note or block's saved view, when this session may write one. */
  saved?: SavedViewActions
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
            {saved?.dirty ? <DirtyDot /> : null}
          </IconButton>
        }
      />
      <DropdownMenu.Content
        align="end"
        width={saved?.dirty ? 320 : undefined}
        footer={saved?.dirty ? <DefaultFooter {...saved} /> : undefined}
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
