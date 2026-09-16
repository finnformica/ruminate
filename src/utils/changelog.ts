/**
 * The changelog's format, as data.
 *
 * `CHANGELOG.md` is written by hand (with `.claude/skills/changelog`) and read
 * by three things that must agree about its shape: the CI gate
 * (`npm run check:changelog`), the in-app changelog page, and the "what's new"
 * what's-new card shown after an update. This module is the one definition of that
 * shape — the parse and the rules — so a file that passes CI is a file the app
 * can render.
 *
 * The format is Keep a Changelog, narrowed:
 *
 *   # Changelog
 *
 *   ## 2026-W38          one release per ISO week, newest first
 *
 *   ### Added            a category, at most once per release
 *
 *   - Lead sentence. Detail follows in the same bullet.
 *
 * Every entry leads with one short sentence that stands on its own: the
 * card shows leads alone, so an entry whose first sentence needs the rest of
 * the bullet to make sense reads as a fragment there. Anything after it is
 * detail, shown on the changelog page.
 */

import { addDays, parseISO } from "date-fns"
import { MONTH_NAMES } from "./date"

/** The categories an entry can sit under, in the order they are written. */
const CATEGORIES = ["Added", "Changed", "Deprecated", "Removed", "Fixed", "Security"] as const

type ChangelogCategory = (typeof CATEGORIES)[number]

/** The longest a lead sentence may be. Long enough for a clause and its point,
 * short enough that a card of them is read rather than skimmed. */
export const MAX_LEAD_LENGTH = 140

/** The longest a whole entry may be, lead and detail together. Past this an
 * entry is documentation, and belongs in `docs/`. */
export const MAX_ENTRY_LENGTH = 500

export type ChangelogEntry = {
  /** The first sentence: what changed, and why it matters. */
  lead: string
  /** Everything after the lead sentence; empty when the entry is one sentence. */
  detail: string
  /** The entry as written, lead and detail together. */
  text: string
  /** 1-based line in the source, for CI's report. */
  line: number
}

export type ChangelogSection = {
  category: ChangelogCategory
  entries: ChangelogEntry[]
  line: number
}

export type ChangelogRelease = {
  /** The ISO week the release is named by, e.g. `2026-W38`. */
  week: string
  sections: ChangelogSection[]
  line: number
}

export type ChangelogProblem = { line: number; message: string }

export type ParsedChangelog = {
  releases: ChangelogRelease[]
  /** Structural faults. The parse keeps going regardless, so a bad file still
   * renders as much of itself as it can. */
  problems: ChangelogProblem[]
}

/** The lines the fragment wrapper adds, so a fault points at the fragment. */
const FRAGMENT_OFFSET = 4

/**
 * Read one file from `changelog.d/` — a pull request's entries, waiting to be
 * folded into a release. A fragment is a changelog with the week left off:
 * category headings and their entries, nothing else.
 *
 * It is checked by wrapping it in the file it is destined for, so a fragment
 * is held to exactly the rules the changelog is, and the line numbers are
 * moved back onto the fragment for the report.
 */
export function parseFragment(source: string): {
  sections: ChangelogSection[]
  problems: ChangelogProblem[]
} {
  const { releases, problems } = parseChangelog(`# Changelog\n\n## 2000-W01\n\n${source.trim()}\n`)
  return {
    sections: (releases[0]?.sections ?? []).map((section) => ({
      ...section,
      line: section.line - FRAGMENT_OFFSET,
      entries: section.entries.map((entry) => ({ ...entry, line: entry.line - FRAGMENT_OFFSET })),
    })),
    problems: problems.map((problem) => ({
      ...problem,
      line: Math.max(1, problem.line - FRAGMENT_OFFSET),
    })),
  }
}

/** The ISO week a date falls in, written the way a release heading is. */
export function toReleaseWeek(date: Date): string {
  const thursday = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()))
  // ISO weeks are numbered by the Thursday in them, and week 1 is the one
  // holding 4 January.
  thursday.setUTCDate(thursday.getUTCDate() + 3 - ((thursday.getUTCDay() + 6) % 7))
  const firstThursday = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 4))
  firstThursday.setUTCDate(firstThursday.getUTCDate() + 3 - ((firstThursday.getUTCDay() + 6) % 7))
  const week = 1 + Math.round((thursday.getTime() - firstThursday.getTime()) / (7 * 86400000))
  return `${thursday.getUTCFullYear()}-W${String(week).padStart(2, "0")}`
}

/** A release written back out as the markdown it was read from. */
export function renderRelease(release: ChangelogRelease): string {
  const sections = [...release.sections].sort(
    (a, b) => CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category),
  )
  const body = sections
    .map(
      (section) =>
        `### ${section.category}\n\n${section.entries.map((entry) => `- ${entry.text}`).join("\n")}`,
    )
    .join("\n\n")
  return `## ${release.week}\n\n${body}\n`
}

/**
 * The days a release covers, as a reader would say them: the ISO week is how
 * the file is keyed, but "2026-W38" is not a date anybody reads.
 *
 * @example
 * formatReleaseDates("2026-W38") // "14–20 September 2026"
 * formatReleaseDates("2026-W40") // "28 September – 4 October 2026"
 * formatReleaseDates("2026-W40", { short: true }) // "28 Sep – 4 Oct 2026"
 */
export function formatReleaseDates(week: string, { short = false } = {}): string {
  const start = parseISO(week)
  if (Number.isNaN(start.getTime())) return week
  const end = addDays(start, 6)
  const day = (date: Date) => date.getDate()
  const month = (date: Date) =>
    short ? MONTH_NAMES[date.getMonth()].slice(0, 3) : MONTH_NAMES[date.getMonth()]
  const year = (date: Date) => date.getFullYear()
  if (year(start) !== year(end)) {
    return `${day(start)} ${month(start)} ${year(start)} – ${day(end)} ${month(end)} ${year(end)}`
  }
  if (month(start) !== month(end)) {
    return `${day(start)} ${month(start)} – ${day(end)} ${month(end)} ${year(end)}`
  }
  return `${day(start)}–${day(end)} ${month(end)} ${year(end)}`
}

/**
 * A run of text, or a run of keys pressed together. An entry names shortcuts
 * as `<kbd>` tags, and a keycap is drawn rather than written
 * (`src/components/keys.tsx`), so the text is handed out in the pieces between
 * them for markdown to render.
 */
export type EntrySegment = { type: "text"; text: string } | { type: "keys"; keys: string[] }

/** Adjacent keycaps are one shortcut; a word between them starts a new run. */
const KEY_RUN = /<kbd>[^<]*<\/kbd>(?:\s*<kbd>[^<]*<\/kbd>)*/g
const KEY = /<kbd>([^<]*)<\/kbd>/g

export function toSegments(text: string): EntrySegment[] {
  const segments: EntrySegment[] = []
  let at = 0
  for (const match of text.matchAll(KEY_RUN)) {
    const index = match.index ?? 0
    if (index > at) segments.push({ type: "text", text: text.slice(at, index) })
    segments.push({
      type: "keys",
      keys: [...match[0].matchAll(KEY)].map((key) => key[1]),
    })
    at = index + match[0].length
  }
  if (at < text.length) segments.push({ type: "text", text: text.slice(at) })
  return segments
}

/**
 * The week a build stamp names. A stamp is `<week>.<hash>` (vite.config.ts);
 * the hash tells two builds of the same week apart, and the week is what says
 * which releases are new.
 */
function weekOfVersion(version: string): string {
  return version.split(".")[0]
}

/**
 * The releases a reader has not seen, newest first.
 *
 * Nothing is new to a reader who has never been here: a first visit stores the
 * stamp and shows no card, rather than opening on the whole history.
 *
 * Releases are compared by week, so entries added to a week already seen are
 * not shown again. They are on the changelog page, which is the honest place
 * for them — a card that reopened on a week you had read would be worse than
 * one that missed a late entry.
 */
export function releasesSince(
  releases: ChangelogRelease[],
  version: string | null,
): ChangelogRelease[] {
  if (!version) return []
  const seen = weekOfVersion(version)
  return releases.filter((release) => release.week > seen)
}

/**
 * The first `limit` entries across these releases, in the order they are
 * written, with the releases and categories they came from kept around them.
 *
 * The what's-new card is a greeting, not the changelog: a reader
 * returning after a month should meet a dozen lines and a way in, not a
 * hundred. Categories are written most-notable-first (`CATEGORIES`), so what
 * survives the cut is what was added and changed rather than what was fixed.
 */
export function takeEntries(releases: ChangelogRelease[], limit: number): ChangelogRelease[] {
  const taken: ChangelogRelease[] = []
  let left = limit
  for (const release of releases) {
    if (left <= 0) break
    const sections: ChangelogSection[] = []
    for (const section of release.sections) {
      if (left <= 0) break
      const entries = section.entries.slice(0, left)
      left -= entries.length
      if (entries.length > 0) sections.push({ ...section, entries })
    }
    if (sections.length > 0) taken.push({ ...release, sections })
  }
  return taken
}

/** How many entries these releases hold altogether. */
export function countEntries(releases: ChangelogRelease[]): number {
  return releases.reduce(
    (total, release) =>
      total + release.sections.reduce((count, section) => count + section.entries.length, 0),
    0,
  )
}

/**
 * Fold a set of fragment sections into the release for `week`, creating that
 * release at the front if the week has none yet.
 *
 * Shared by collation (`scripts/collate-changelog.ts`), which writes the
 * result back to `CHANGELOG.md`, and by the app, which does the same thing in
 * memory at build time so that entries still waiting to be folded are shown
 * anyway. Both must agree, or what a reader sees before collation runs would
 * differ from what they see after it.
 *
 * A fragment's entries go to the end of their category, after whatever the
 * week already holds: neither caller can judge which change matters most, and
 * the order entries landed in is at least a true one.
 */
export function mergeFragments(
  releases: ChangelogRelease[],
  sections: ChangelogSection[],
  week: string,
): ChangelogRelease[] {
  if (sections.length === 0) return releases
  const existing = releases.find((release) => release.week === week)
  const merged: ChangelogRelease = existing
    ? { ...existing, sections: existing.sections.map((section) => ({ ...section })) }
    : { week, sections: [], line: 0 }

  for (const section of sections) {
    const target = merged.sections.find((held) => held.category === section.category)
    if (target) target.entries = [...target.entries, ...section.entries]
    else merged.sections.push({ ...section })
  }
  merged.sections.sort((a, b) => CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category))

  return existing
    ? releases.map((release) => (release.week === week ? merged : release))
    : [merged, ...releases]
}

const TITLE = "# Changelog"
const WEEK_HEADING = /^## (\d{4}-W\d{2})\s*$/
const CATEGORY_HEADING = /^### (.+?)\s*$/
const BULLET = /^- (.+?)\s*$/

function isCategory(value: string): value is ChangelogCategory {
  return (CATEGORIES as readonly string[]).includes(value)
}

/**
 * The lead sentence and the detail behind it. The lead runs to the first full
 * stop that ends a word — periods inside a code span (`node.js`, `1.` ) are
 * passed over, so a lead can name one without being cut in half.
 */
export function splitLead(text: string): { lead: string; detail: string } {
  let inCode = false
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (char === "`") inCode = !inCode
    if (inCode || char !== ".") continue
    const next = text[index + 1]
    if (next !== undefined && next !== " ") continue
    return { lead: text.slice(0, index + 1), detail: text.slice(index + 2).trim() }
  }
  return { lead: text, detail: "" }
}

/**
 * How long a run of text is to the person reading it. Markup does not count:
 * a lead that names four keys is short to read and long in the file, and it is
 * the reading that the limits are about.
 */
export function visibleLength(text: string): number {
  return text
    .replace(/<\/?kbd>/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`]/g, "").length
}

/**
 * Read `CHANGELOG.md` into releases. Structural faults are collected rather
 * than thrown: CI reports them, and the app renders whatever parsed.
 */
export function parseChangelog(source: string): ParsedChangelog {
  const releases: ChangelogRelease[] = []
  const problems: ChangelogProblem[] = []
  const lines = source.split("\n")

  let release: ChangelogRelease | null = null
  let section: ChangelogSection | null = null
  let sawTitle = false
  // Whether a bullet has been seen since the last heading, so the blank line
  // that normally follows a heading is never read as a split list.
  let sawBullet = false
  let blankSinceBullet = false

  const fault = (line: number, message: string) => problems.push({ line, message })

  lines.forEach((raw, index) => {
    const line = index + 1
    const text = raw.trimEnd()

    if (text === "") {
      if (sawBullet) blankSinceBullet = true
      return
    }

    if (text.startsWith("# ")) {
      if (text !== TITLE) fault(line, `The file's title must be exactly "${TITLE}".`)
      else if (sawTitle) fault(line, "The file has more than one title.")
      sawTitle = true
      return
    }

    const week = WEEK_HEADING.exec(text)
    if (week) {
      if (!sawTitle) fault(line, `A release appears before the "${TITLE}" title.`)
      const previous = releases.at(-1)
      if (releases.some((entry) => entry.week === week[1])) {
        fault(line, `${week[1]} appears more than once. A week is one release.`)
      } else if (previous && previous.week < week[1]) {
        fault(line, `${week[1]} sits below ${previous.week}. Releases run newest first.`)
      }
      release = { week: week[1], sections: [], line }
      releases.push(release)
      section = null
      sawBullet = false
      blankSinceBullet = false
      return
    }

    if (text.startsWith("## ")) {
      fault(line, `"${text}" is not an ISO week. A release heading reads "## 2026-W38".`)
      return
    }

    const category = CATEGORY_HEADING.exec(text)
    if (category && text.startsWith("### ")) {
      const name = category[1]
      // A heading ends the list above it, whatever we make of the heading, so
      // the blank line on either side of it is never a split list.
      sawBullet = false
      blankSinceBullet = false
      if (!release) {
        fault(line, `"${name}" sits outside a release. Every category belongs to a week.`)
        return
      }
      if (!isCategory(name)) {
        fault(line, `"${name}" is not a category. Use one of: ${CATEGORIES.join(", ")}.`)
        // Entries beneath an unrecognised heading are not quietly filed under
        // whichever category came before it.
        section = null
        return
      }
      const current: ChangelogRelease = release
      const duplicate = current.sections.find((existing) => existing.category === name)
      if (duplicate) {
        // Reported once, then merged: CI asks for the headings to be joined up,
        // while the app still shows every entry under the one category.
        fault(line, `${current.week} has more than one "${name}". Merge them into one.`)
        section = duplicate
        return
      }
      const previous = current.sections.at(-1)
      if (previous && CATEGORIES.indexOf(previous.category) > CATEGORIES.indexOf(name)) {
        fault(
          line,
          `"${name}" sits below "${previous.category}". Categories run in the order: ${CATEGORIES.join(", ")}.`,
        )
      }
      section = { category: name, entries: [], line }
      current.sections.push(section)
      return
    }

    const bullet = BULLET.exec(text)
    if (bullet) {
      if (!section) {
        fault(line, "An entry sits outside a category. Every entry belongs under one.")
        return
      }
      if (blankSinceBullet) {
        fault(line, "A blank line splits this category's entries into two lists. Remove it.")
        blankSinceBullet = false
      }
      const body = bullet[1]
      const { lead, detail } = splitLead(body)
      section.entries.push({ lead, detail, text: body, line })
      sawBullet = true
      return
    }

    fault(line, `"${text.slice(0, 40)}…" is neither a heading nor an entry.`)
  })

  if (!sawTitle) fault(1, `The file must open with "${TITLE}".`)

  return { releases, problems }
}
