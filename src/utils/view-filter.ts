import {
  BLOCK_SORT_KEYS,
  STATIC_QUALIFIER_OPTIONS,
  dateQualifierOptions,
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
 * The menus offer the SAME vocabulary the query box's picker offers, read
 * from the same place (`STATIC_QUALIFIER_OPTIONS`, `dateQualifierOptions`,
 * `sortQualifierOptions`). Nothing about which qualifiers exist, or what
 * their values are, is written twice: a key added to the query language
 * appears in the note header's menus with it.
 */

/** One branch of the Filter menu: a qualifier, and the values it offers. */
export interface FilterBranch {
  /** The qualifier this branch writes (`type`, `has`, `no`, `date`). */
  key: string
  /** How the branch reads — the key, capitalised. */
  label: string
  options: readonly QualifierOption[]
}

/**
 * `sort:` is the Sort menu's, not a filter; `in:` names the view's ROOT,
 * which the header applies by focusing rather than by writing a qualifier.
 * Everything else the query language offers is a filter branch.
 */
const NOT_FILTER_KEYS = new Set(["sort", "in"])

/** A key as a menu row reads it: `updated_at` → "Updated at". */
function keyLabel(key: string): string {
  const words = key.replace(/_/g, " ")
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/**
 * The Filter menu's branches, in the query language's own order: the static
 * qualifier sets, then the ones built on demand. One entry per qualifier the
 * query box would open a picker for.
 */
export function filterBranches(now: Date = new Date()): FilterBranch[] {
  const branches: FilterBranch[] = []
  for (const [key, options] of Object.entries(STATIC_QUALIFIER_OPTIONS)) {
    if (NOT_FILTER_KEYS.has(key)) continue
    branches.push({ key, label: keyLabel(key), options })
  }
  branches.push({ key: "date", label: "Date", options: dateQualifierOptions(now) })
  return branches
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

/** How one branch reads in its row — "Todo, Done", or nothing. */
export function describeBranch(filter: string, branch: FilterBranch): string {
  return filterValues(filter, branch.key)
    .map((value) => branch.options.find((option) => option.value === value)?.label ?? value)
    .join(", ")
}

/** How a whole filter reads in a sentence — every qualifier it names, then
 * the text it is searching for. */
export function describeFilter(filter: string, now?: Date): string {
  const parts = filterBranches(now)
    .map((branch) => describeBranch(filter, branch))
    .filter(Boolean)
  const { text } = splitQuery(filter)
  return [...parts, ...(text ? [`“${text}”`] : [])].join(", ")
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
