import {
  BLOCK_SORT_KEYS,
  STATIC_QUALIFIER_OPTIONS,
  sortQualifierOptions,
  type QualifierOption,
} from "./qualifier-suggestions"
import { composeQuery, parseQuery, splitQuery, type Sort } from "./search"

/**
 * **Reading and writing a view's filter, one qualifier at a time.**
 *
 * A note's filter is a query-language string (`type:todo milk`) — the same
 * language the search box speaks — so what the header's menus set can be
 * read, and typed, by hand, and is answered by the same engine
 * (`src/utils/view-narrowing.ts`).
 *
 * **The menu offers `type:` and nothing else**, though the filter understands
 * everything the language does. The rest of the vocabulary is note-level
 * (`has:`, `no:`, `date:`, a property): inside a single note it holds for
 * every row or for none, so as a menu item it is not a filter but a switch
 * between the whole note and a blank page. Typed by hand it still works,
 * and means there exactly what it means in a search.
 *
 * `in:` is left out for a different reason: it names the view's ROOT, which
 * is what focusing already does.
 *
 * The values come from the query box's own picker
 * (`STATIC_QUALIFIER_OPTIONS`), so a block type added to the registry
 * appears in the note header with it.
 */

/** The `type:` values the Filter menu offers — the picker's list, verbatim. */
export const FILTER_TYPE_OPTIONS: readonly QualifierOption[] = STATIC_QUALIFIER_OPTIONS.type

/** A sort key as a menu row reads it: `updated_at` → "Updated at". */
function keyLabel(key: string): string {
  const words = key.replace(/_/g, " ")
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** The sort keys a note's rows can actually be ordered by, as the query
 * box's own `sort:` picker offers them (its first step). The rest of that
 * picker's keys belong to the containing note, so inside one note they tie. */
export function sortBranches(): QualifierOption[] {
  return sortQualifierOptions("").filter((option) => BLOCK_SORT_KEYS.includes(option.value))
}

/** The directions for a sort key — the query box's second step, verbatim. */
export function sortDirections(key: string): QualifierOption[] {
  return sortQualifierOptions(`${key}:`)
}

/** The values a filter names under `key`, in the order it names them. An
 * exclusion (`-type:done`) is not what a menu ticks, so it is left alone —
 * and left in the string. */
export function filterValues(filter: string, key: string): string[] {
  const { filters } = parseQuery(filter)
  const found = filters.find((f) => f.key === key && !f.exclude)
  return found ? found.values : []
}

/**
 * `filter` with `key` set to `values` — the qualifier dropped entirely when
 * the list is empty. Everything else the filter holds (its text, its other
 * qualifiers, an exclusion typed by hand) is kept exactly as written.
 */
function withFilterValues(filter: string, key: string, values: readonly string[]): string {
  const { qualifiers, text } = splitQuery(filter)
  const rest = qualifiers.filter((q) => !q.startsWith(`${key}:`))
  const next = values.length > 0 ? [`${key}:${quoteValues(values)}`, ...rest] : rest
  return composeQuery(next, text)
}

/** A value with a space in it is quoted, as the query box quotes one. */
function quoteValues(values: readonly string[]): string {
  return values.map((value) => (/\s/.test(value) ? `"${value}"` : value)).join(",")
}

/** `filter` with `value` toggled in `key`'s list. */
export function toggleFilterValue(filter: string, key: string, value: string): string {
  const current = filterValues(filter, key)
  const next = current.includes(value)
    ? current.filter((each) => each !== value)
    : [...current, value]
  return withFilterValues(filter, key, next)
}

/** `filter` with `key` taken out entirely. */
export function clearFilterKey(filter: string, key: string): string {
  return withFilterValues(filter, key, [])
}

/**
 * How a filter reads in a sentence — the block types it names, then the text
 * it is searching for, then anything else it carries (a qualifier typed by
 * hand) as written, so the button never claims a filter is empty when it is
 * not.
 */
export function describeFilter(filter: string): string {
  const types = filterValues(filter, "type").map(
    (value) => FILTER_TYPE_OPTIONS.find((option) => option.value === value)?.label ?? value,
  )
  const { qualifiers, text } = splitQuery(filter)
  const others = qualifiers.filter((q) => !q.startsWith("type:"))
  return [...types, ...(text ? [`“${text}”`] : []), ...others].join(", ")
}

/**
 * **What the view is narrowed by, and what to write when it changes.**
 *
 * A note or a block may have saved a default view onto its node
 * (docs/metadata.md), and the URL may say something else. The URL wins where
 * it speaks — that is what makes a narrowed view a link — and the saved
 * default fills the silence:
 *
 * - the param ABSENT means "nothing said", so the saved default applies;
 * - the param EMPTY (`?filter=`) means "explicitly none", which is how a
 *   filter is cleared on something whose default is not empty. Without the
 *   distinction, clearing would drop the param and the default would come
 *   straight back, and there would be no way to see the whole note again.
 */
export function resolveNarrowing(param: string | undefined, saved: string): string {
  return param ?? saved
}

/** What to put in the URL for `next`, given what the node saved. Nothing to
 * say is said by leaving the param out — unless leaving it out would mean
 * the saved default, in which case the emptiness has to be written down. */
export function narrowingParam(next: string, saved: string): string | undefined {
  if (next !== "") return next
  return saved === "" ? undefined : ""
}

/**
 * The sort as the header's menu writes it: `text`, `text:desc`, or several
 * comma-separated (`type,text:desc`). The query language's own `sort:` form
 * is accepted too, so a sort copied out of the search box works here.
 */
export function parseSort(sort: string): Sort[] {
  const body = sort.trim().replace(/^sort:/, "")
  if (body === "") return []
  const parsed: Sort[] = []
  for (const part of body.split(",")) {
    const [key, direction] = part.trim().split(":")
    if (!key) continue
    parsed.push({ key, direction: direction === "desc" ? "desc" : "asc" })
  }
  return parsed
}

/** How a sort reads in a sentence — "Text, descending", or nothing. */
export function describeSort(sort: string): string {
  return parseSort(sort)
    .map(({ key, direction }) => {
      const label = keyLabel(key)
      return direction === "desc" ? `${label}, descending` : label
    })
    .join(" then ")
}
