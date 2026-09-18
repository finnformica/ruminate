import { searchTypeOptions } from "../blocks/registry"
import type { QualifierOption } from "./qualifier-suggestions"
import { composeQuery, parseQuery, splitQuery } from "./search"

/**
 * **Reading and writing a view's filter, one qualifier at a time.**
 *
 * A note's filter is a query-language string (`type:todo milk`) — the same
 * language the search box speaks, so what the header's menus set can be read
 * and typed by hand. These are the small edits the menus make to it: which
 * block types are on, and the string with a different set of them, leaving
 * whatever else the filter says (its free text, a qualifier typed by hand)
 * exactly where it was.
 */

/** The block types the `type:` menu offers, each with its markdown glyph —
 * the registry's own list, the one the query box's picker offers. */
export const FILTER_TYPE_OPTIONS: readonly QualifierOption[] = searchTypeOptions()

/** The `type:` values a filter names, in the order it names them. Empty when
 * it has no `type:` at all (the view is every row). */
export function filterTypes(filter: string): string[] {
  const { filters } = parseQuery(filter)
  const type = filters.find((f) => f.key === "type" && !f.exclude)
  return type ? type.values : []
}

/**
 * `filter` with its `type:` set to `values` — no `type:` at all when the
 * list is empty. Everything else the filter holds is kept as written.
 */
function withFilterTypes(filter: string, values: readonly string[]): string {
  const { qualifiers, text } = splitQuery(filter)
  const rest = qualifiers.filter((q) => !/^-?type:/.test(q))
  const next = values.length > 0 ? [`type:${values.join(",")}`, ...rest] : rest
  return composeQuery(next, text)
}

/** `filter` with `value` toggled in its `type:` list. */
export function toggleFilterType(filter: string, value: string): string {
  const current = filterTypes(filter)
  const next = current.includes(value)
    ? current.filter((each) => each !== value)
    : [...current, value]
  return withFilterTypes(filter, next)
}

/** How a filter reads in a sentence — "To-do, Done", or nothing at all. */
export function describeFilter(filter: string): string {
  const values = filterTypes(filter)
  const labels = values.map(
    (value) => FILTER_TYPE_OPTIONS.find((option) => option.value === value)?.label ?? value,
  )
  const { text } = splitQuery(filter)
  return [...labels, ...(text ? [`“${text}”`] : [])].join(", ")
}

/** The keys a view can sort its rows by. A block has no `updated_at` of its
 * own — that is the note's — so the ones offered are the row's own. */
export const SORT_KEYS: readonly { value: string; label: string }[] = [
  { value: "text", label: "Text" },
  { value: "type", label: "Type" },
]

/** How a sort reads in a sentence — "Text, descending", or nothing. */
export function describeSort(sort: string): string {
  const body = sort.trim().replace(/^sort:/, "")
  if (body === "") return ""
  return body
    .split(",")
    .map((part) => {
      const [key, direction] = part.trim().split(":")
      const label = SORT_KEYS.find((each) => each.value === key)?.label ?? key
      return direction === "desc" ? `${label}, descending` : label
    })
    .join(" then ")
}
