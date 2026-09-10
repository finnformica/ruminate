import { parseDate } from "chrono-node"
import { toDateString } from "./date"

export type Filter = {
  key: string
  values: string[]
  exclude: boolean
}

type SortDirection = "asc" | "desc"

export type Sort = {
  key: string
  direction: SortDirection
}

export type Query = {
  filters: Filter[]
  fuzzy: string
  sorts: Sort[]
}

// eslint-disable-next-line no-useless-escape
const QUALIFIER_REGEX = /(?<exclude>-?)(?<key>[-\w]+):(?<value>[^"\[\]| ]+|"[^"\[\]|]+")/g

export function parseQuery(query: string): Query {
  const sorts: Sort[] = []
  const filters: Filter[] = []

  const matches = Array.from(query.matchAll(QUALIFIER_REGEX))

  for (const match of matches) {
    if (!match.groups) continue

    const key = match.groups.key
    const value = match.groups.value

    if (key === "sort") {
      const values = value.split(",")

      for (const sort of values) {
        const [key, direction] = sort.trim().split(":")

        sorts.push({
          key,
          direction: getSortDirection(key, direction),
        })
      }

      continue
    }

    filters.push(parseQualifier(match.groups))
  }

  const fuzzy = query.replace(QUALIFIER_REGEX, "").trim()

  return { fuzzy, filters, sorts }
}

/**
 * The query with one qualifier taken out — the `filter` as `parseQuery`
 * returned it (key, values, exclusion). Matched on the parsed form rather
 * than by re-spelling it, so a quoted value (`in:"Reading list"`) is found as
 * typed. Only the first occurrence goes; surrounding whitespace collapses.
 */
export function removeQualifier(query: string, filter: Filter): string {
  for (const match of query.matchAll(QUALIFIER_REGEX)) {
    if (!match.groups || match.index === undefined) continue
    const { key, values, exclude } = parseQualifier(match.groups)
    if (
      key !== filter.key ||
      exclude !== filter.exclude ||
      values.length !== filter.values.length ||
      values.some((value, index) => value !== filter.values[index])
    ) {
      continue
    }
    const before = query.slice(0, match.index)
    const after = query.slice(match.index + match[0].length)
    return `${before.trimEnd()} ${after.trimStart()}`.trim()
  }
  return query
}

/** One `key:value` match, as a filter. `sort:` is not a filter; callers
 * handle it before reaching here. */
function parseQualifier(groups: Record<string, string>): Filter {
  const value = groups.value
  let values: string[]
  if (value.startsWith('"')) {
    values = [value.slice(1, -1)]
  } else if (value.includes(",")) {
    values = value
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean)
  } else {
    values = [value.trim()]
  }
  return { key: groups.key, values, exclude: Boolean(groups.exclude) }
}

function getSortDirection(key: string, direction?: string): SortDirection {
  if (direction === "asc") return "asc"
  if (direction === "desc") return "desc"
  // `updated` is the block-search spelling of `updated_at` — recent-first too.
  if (["tags", "updated", "updated_at"].includes(key)) return "desc"
  return "asc"
}

/**
 * Resolves relative date strings (today, tomorrow, yesterday, etc.) to ISO format.
 * Returns original string if not a parseable date.
 */
export function resolveRelativeDate(value: string): string {
  // Replace + with space to support date:next+week syntax
  const normalized = value.replace(/\+/g, " ")
  const date = parseDate(normalized)
  if (date) {
    return toDateString(date)
  }
  return value
}

export function isInRange(value: string | number, range: string): boolean {
  if (range.startsWith(">=")) {
    return value >= resolveRelativeDate(range.slice(2))
  } else if (range.startsWith("<=")) {
    return value <= resolveRelativeDate(range.slice(2))
  } else if (range.startsWith(">")) {
    return value > resolveRelativeDate(range.slice(1))
  } else if (range.startsWith("<")) {
    return value < resolveRelativeDate(range.slice(1))
  } else {
    return value.toString() === resolveRelativeDate(range)
  }
}
