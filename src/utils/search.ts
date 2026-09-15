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
 * The query as the box shows it: the qualifier tokens as typed (`type:todo`,
 * `-in:"Reading list"`, `sort:updated`), and the text between them with its
 * spacing collapsed. The inverse of `composeQuery`.
 */
export function splitQuery(query: string): { qualifiers: string[]; text: string } {
  const qualifiers = Array.from(query.matchAll(QUALIFIER_REGEX), (match) => match[0])
  const text = query.replace(QUALIFIER_REGEX, " ").replace(/\s+/g, " ").trim()
  return { qualifiers, text }
}

/** The one query string: the qualifiers first, then the text. */
export function composeQuery(qualifiers: readonly string[], text: string): string {
  return [...qualifiers, text.trim()].filter(Boolean).join(" ")
}

/**
 * Lift the finished qualifiers out of a line being typed. A `key:value`
 * token with whitespace after it is finished — typing carried on past it,
 * or a pick from the popover wrote it with its trailing space — while one
 * the line ends in is still being typed and stays. Returns the line with
 * those tokens (and the whitespace after each) taken out, the caret moved
 * with the text around it, and the tokens in the order they stood.
 */
export function extractQualifiers(
  text: string,
  caret: number,
): { text: string; caret: number; qualifiers: string[] } {
  const qualifiers: string[] = []
  let kept = ""
  let nextCaret = caret
  let from = 0
  for (const match of text.matchAll(QUALIFIER_REGEX)) {
    if (match.index === undefined) continue
    const start = match.index
    const trailing = /^\s+/.exec(text.slice(start + match[0].length))?.[0] ?? ""
    if (trailing === "") continue
    const end = start + match[0].length + trailing.length
    qualifiers.push(match[0])
    kept += text.slice(from, start)
    if (caret >= end) nextCaret -= end - start
    else if (caret > start) nextCaret -= caret - start
    from = end
  }
  kept += text.slice(from)
  return { text: kept, caret: nextCaret, qualifiers }
}

/**
 * One qualifier token as typed, read as a filter: its key, its values
 * (unquoted, a comma list split) and whether it is negated. A `sort:` token
 * reads as the key `sort` with its list as the one value, since it is not a
 * filter (`parseQuery` keeps sorts apart). Null when the token is not one.
 */
export function parseQualifierToken(token: string): Filter | null {
  const match = new RegExp(QUALIFIER_REGEX.source).exec(token)
  if (!match?.groups || match[0] !== token) return null
  if (match.groups.key === "sort") {
    return { key: "sort", values: [match.groups.value], exclude: false }
  }
  return parseQualifier(match.groups)
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
  if (["updated", "updated_at"].includes(key)) return "desc"
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
