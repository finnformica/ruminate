import {
  BLOCK_SORT_KEYS,
  STATIC_QUALIFIER_OPTIONS,
  sortQualifierOptions,
  type QualifierOption,
} from "./qualifier-suggestions"
import { composeQuery, parseQualifierToken, splitQuery, type Sort } from "./search"

/**
 * **Reading and writing a view's filter, one qualifier at a time.**
 *
 * A note's filter is a query-language string (`type:todo milk`) — the same
 * language the search box speaks — so what the header's menus set can be
 * read, and typed, by hand, and is answered by the same engine
 * (`src/utils/view-narrowing.ts`).
 *
 * **The menu offers `type:`, the ancestors and the text**, though the filter
 * understands everything the language does. The rest of the vocabulary is note-level
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

/**
 * **A key may be written more than once, and the menus know which one is
 * theirs.** The language reads a comma list as _either_ (`parent:a,b`) and a
 * repeated key as _both_ (`parent:a parent:b`) — the engine ANDs the
 * qualifiers and ORs within one (`searchBlocks`). A board's Filter leans on
 * that: each feature branch (Location, Fixture — `FilterBranch`,
 * src/components/view-controls.tsx) writes a `parent:` qualifier of its own,
 * so Mauritius or Lisbon, and a lamp, is `parent:<mauritius>,<lisbon>
 * parent:<lamp>`. A branch addresses its qualifier by the values it offers
 * (`among`): the qualifier of the key whose values all lie among the
 * branch's is the branch's, and the rest are left exactly as written. Called
 * without `among`, these read EVERY qualifier of the key — the generic
 * Parent branch lists all that is chosen, and the button describes it all —
 * and write the one that already holds the value, or the key's last.
 */

/** The qualifiers of `key` a menu may tick — the ones not excluded — each
 * with its place among the filter's tokens and the values it names. */
interface OwnQualifier {
  at: number
  values: string[]
}

function ownQualifiers(tokens: readonly string[], key: string): OwnQualifier[] {
  const own: OwnQualifier[] = []
  tokens.forEach((token, at) => {
    const parsed = parseQualifierToken(token)
    if (parsed && parsed.key === key && !parsed.exclude) own.push({ at, values: parsed.values })
  })
  return own
}

/** The qualifier a branch owns among a key's: the first whose values all
 * lie among the branch's own. A value typed by hand belongs to no branch. */
function branchQualifier(
  own: readonly OwnQualifier[],
  among: readonly string[],
): OwnQualifier | undefined {
  return own.find((qualifier) => qualifier.values.every((value) => among.includes(value)))
}

/**
 * `tokens` with one qualifier of `key` written as `values`: the one at
 * `at`, rewritten where it stands (and taken out when the list is empty),
 * or, with no `at`, a new one put after the key's last (`after`) so a key's
 * qualifiers read together — or at the front when it is the first.
 */
function writeQualifier(
  tokens: readonly string[],
  key: string,
  values: readonly string[],
  at: number | undefined,
  after: number | undefined,
): string[] {
  const next = [...tokens]
  const written = values.length > 0 ? [`${key}:${quoteValues(values)}`] : []
  if (at !== undefined) next.splice(at, 1, ...written)
  else next.splice(after !== undefined ? after + 1 : 0, 0, ...written)
  return next
}

/** A value with a space in it is quoted, as the query box quotes one. */
function quoteValues(values: readonly string[]): string {
  return values.map((value) => (/\s/.test(value) ? `"${value}"` : value)).join(",")
}

/**
 * The values a filter names under `key`, in the order it names them — from
 * every qualifier of the key, or, given `among`, from the one qualifier the
 * branch owns. An exclusion (`-type:done`) is not what a menu ticks, so it
 * is left alone — and left in the string.
 */
export function filterValues(filter: string, key: string, among?: readonly string[]): string[] {
  const own = ownQualifiers(splitQuery(filter).qualifiers, key)
  if (among) return branchQualifier(own, among)?.values ?? []
  return own.flatMap((qualifier) => qualifier.values)
}

/**
 * `filter` with `value` toggled under `key`. Given `among`, in the branch's
 * own qualifier — a new one when the branch has none yet, after the key's
 * last, so a second feature ANDs with the first. Without, out of whichever
 * qualifier of the key holds it, or into the key's last — one list, as the
 * Type branch has always written. Everything else the filter holds (its
 * text, its other qualifiers, an exclusion typed by hand) is kept exactly
 * as written, and a qualifier emptied is dropped.
 */
export function toggleFilterValue(
  filter: string,
  key: string,
  value: string,
  among?: readonly string[],
): string {
  const { qualifiers: tokens, text } = splitQuery(filter)
  const own = ownQualifiers(tokens, key)
  const last = own.at(-1)
  const target = among
    ? branchQualifier(own, among)
    : (own.find((qualifier) => qualifier.values.includes(value)) ?? last)
  const current = target?.values ?? []
  const next = current.includes(value)
    ? current.filter((each) => each !== value)
    : [...current, value]
  return composeQuery(writeQualifier(tokens, key, next, target?.at, last?.at), text)
}

/** `filter` with `key` taken out entirely — or, given `among`, with the
 * branch's own qualifier of it taken out and the key's others left. */
export function clearFilterKey(filter: string, key: string, among?: readonly string[]): string {
  const { qualifiers: tokens, text } = splitQuery(filter)
  const own = ownQualifiers(tokens, key)
  const gone = among ? [branchQualifier(own, among)].filter((q) => q !== undefined) : own
  const next = tokens.filter((_, at) => !gone.some((qualifier) => qualifier.at === at))
  return composeQuery(next, text)
}

/** The words a filter searches for — its text outside the qualifiers,
 * fuzzy-matched over each row's own text by the engine. */
export function filterText(filter: string): string {
  return splitQuery(filter).text
}

/** `filter` with its words set to `text` (none, when empty); the qualifiers
 * are kept exactly as written. */
export function withFilterText(filter: string, text: string): string {
  return composeQuery(splitQuery(filter).qualifiers, text)
}

/** The ancestor qualifiers the Filter menu offers beside `type:` — each a
 * block picked by id, or a text the block must contain (docs/query-language.md,
 * "Under a block, by what it says"). */
export const ANCESTOR_FILTER_KEYS = ["parent", "under"] as const
export type AncestorFilterKey = (typeof ANCESTOR_FILTER_KEYS)[number]

/** How an ancestor value reads: a picked block by its text (the id is
 * opaque), a typed text in quotes. */
export function describeAncestorValue(
  value: string,
  blockText?: (id: string) => string | undefined,
): string {
  const text = blockText?.(value)
  return text !== undefined ? text : `“${value}”`
}

/**
 * How a filter reads in a sentence — the block types it names, then the
 * ancestors ("parent Alice", "under Standup"; every qualifier of the key,
 * so a board's two features both read), then the text it is searching for,
 * then anything else it carries (a qualifier typed by hand) as written, so
 * the button never claims a filter is empty when it is not. `blockText`
 * names a block picked by id (`blockIndexAtom`'s `getBlock`).
 */
export function describeFilter(
  filter: string,
  blockText?: (id: string) => string | undefined,
): string {
  const types = filterValues(filter, "type").map(
    (value) => FILTER_TYPE_OPTIONS.find((option) => option.value === value)?.label ?? value,
  )
  const ancestors = ANCESTOR_FILTER_KEYS.flatMap((key) =>
    filterValues(filter, key).map((value) => `${key} ${describeAncestorValue(value, blockText)}`),
  )
  const { qualifiers, text } = splitQuery(filter)
  const described = ["type", ...ANCESTOR_FILTER_KEYS]
  const others = qualifiers.filter((q) => !described.some((key) => q.startsWith(`${key}:`)))
  return [...types, ...ancestors, ...(text ? [`“${text}”`] : []), ...others].join(", ")
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
