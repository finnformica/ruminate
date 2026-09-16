/**
 * The changelog's format, as data.
 *
 * `CHANGELOG.md` is written by hand (with `.claude/skills/changelog`) and read
 * by three things that must agree about its shape: the CI gate
 * (`npm run check:changelog`), the in-app changelog page, and the "what's new"
 * dialog shown after an update. This module is the one definition of that
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
 * dialog shows leads alone, so an entry whose first sentence needs the rest of
 * the bullet to make sense reads as a fragment there. Anything after it is
 * detail, shown on the changelog page.
 */

/** The categories an entry can sit under, in the order they are written. */
const CATEGORIES = ["Added", "Changed", "Deprecated", "Removed", "Fixed", "Security"] as const

type ChangelogCategory = (typeof CATEGORIES)[number]

/** The longest a lead sentence may be. Long enough for a clause and its point,
 * short enough that a dialog of them is read rather than skimmed. */
export const MAX_LEAD_LENGTH = 140

/** The longest a whole entry may be, lead and detail together. Past this an
 * entry is documentation, and belongs in `docs/`. */
export const MAX_ENTRY_LENGTH = 500

type ChangelogEntry = {
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
