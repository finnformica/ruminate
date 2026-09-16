/**
 * The changelog gate, as a CI check.
 *
 *   npm run check:changelog
 *
 * `CHANGELOG.md` is read by the app — the changelog page, and the what's-new
 * card shown after an update — so a malformed file is a broken page, not just
 * an untidy document. This script parses it with the very module the app uses
 * (`src/utils/changelog.ts`), so CI and the app cannot disagree about what the
 * format is, and then applies the house rules on top: the shape of an entry,
 * and the words it may not use.
 *
 * The rules exist because a changelog drifts towards being a commit log. They
 * are deliberately mechanical — whether an entry is worth a user's attention
 * at all is a judgement, and lives in `.claude/skills/changelog`.
 */
import {
  MAX_ENTRY_LENGTH,
  MAX_LEAD_LENGTH,
  parseChangelog,
  parseFragment,
  visibleLength,
  type ChangelogProblem,
  type ChangelogSection,
} from "../src/utils/changelog"

// `node:fs` via `getBuiltinModule`, dodging the vite node-polyfills alias
// (same trick as scripts/check-queries.ts).
const builtin = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process
  ?.getBuiltinModule as (id: string) => unknown
const { readdirSync, readFileSync } = builtin("node:fs") as {
  readdirSync: (path: string) => string[]
  readFileSync: (path: string, encoding: string) => string
}

/**
 * Spellings to write the British way. The app is written in British English
 * and a changelog that mixes the two reads as two authors.
 */
const SPELLINGS: Record<string, string> = {
  analyze: "analyse",
  behavior: "behaviour",
  canceled: "cancelled",
  center: "centre",
  centered: "centred",
  color: "colour",
  colored: "coloured",
  colors: "colours",
  customize: "customise",
  gray: "grey",
  initialize: "initialise",
  labeled: "labelled",
  labeling: "labelling",
  maximize: "maximise",
  minimize: "minimise",
  normalize: "normalise",
  organize: "organise",
  recolors: "recolours",
}

/**
 * Words that mean nothing to a reader of the changelog. Each names something
 * only a contributor can see: a deployment step, a storage engine, a term of
 * art from the code. An entry that needs one is describing the implementation
 * rather than the change.
 */
const JARGON: Record<string, string> = {
  idempotent: "say what happens when it runs twice",
  localStorage: "say “on this device”",
  micromark: "name the behaviour, not the parser",
  OPFS: "say “on this device”",
  subtree: "say “the block and everything under it”",
  wrangler: "a deployment step belongs in docs/, not the changelog",
}

const MEASUREMENT = /\b\d+px\b/
const SECRET = /\b[A-Z][A-Z0-9]*_SECRET\b/
const FENCE = /```/

function checkEntryText(text: string, line: number, problems: ChangelogProblem[]) {
  const fault = (message: string) => problems.push({ line, message })

  if (FENCE.test(text)) fault("An entry cannot hold a fenced code block. Use a code span.")
  // A backtick named as a key (`<kbd>` + backtick + `</kbd>`) is a keycap, not
  // the start of a code span, so it is not counted.
  const spans = text.replace(/<kbd>.*?<\/kbd>/g, "")
  if ((spans.match(/`/g)?.length ?? 0) % 2 !== 0)
    fault("An unclosed code span: the backticks do not pair up.")
  if (MEASUREMENT.test(text))
    fault("A pixel measurement says nothing to a reader. Describe what moved.")
  if (SECRET.test(text)) fault("A deployment secret belongs in docs/, not the changelog.")

  for (const [wrong, right] of Object.entries(SPELLINGS)) {
    if (new RegExp(`\\b${wrong}\\b`, "i").test(text))
      fault(`"${wrong}" is American. Write "${right}".`)
  }
  for (const [word, advice] of Object.entries(JARGON)) {
    if (new RegExp(`\\b${word}\\b`, "i").test(text)) fault(`"${word}" is jargon: ${advice}.`)
  }
}

/** The rules every entry answers to, wherever it is written. */
function checkSections(sections: ChangelogSection[], problems: ChangelogProblem[], where: string) {
  for (const section of sections) {
    if (section.entries.length === 0) {
      problems.push({
        line: section.line,
        message: `"${section.category}" in ${where} has no entries. Leave the heading out.`,
      })
    }
    for (const entry of section.entries) {
      const fault = (message: string) => problems.push({ line: entry.line, message })
      if (!entry.lead.endsWith(".")) {
        fault("The lead sentence must end in a full stop, so the card can show it alone.")
      }
      const lead = visibleLength(entry.lead)
      const whole = visibleLength(entry.text)
      if (lead > MAX_LEAD_LENGTH) {
        fault(`The lead sentence reads as ${lead} characters; the limit is ${MAX_LEAD_LENGTH}.`)
      }
      if (whole > MAX_ENTRY_LENGTH) {
        fault(`The entry reads as ${whole} characters; the limit is ${MAX_ENTRY_LENGTH}.`)
      }
      checkEntryText(entry.text, entry.line, problems)
    }
  }
}

function checkChangelog(source: string): ChangelogProblem[] {
  const { releases, problems } = parseChangelog(source)
  for (const release of releases) {
    if (release.sections.length === 0) {
      problems.push({ line: release.line, message: `${release.week} has no categories.` })
    }
    checkSections(release.sections, problems, release.week)
  }
  return problems.sort((a, b) => a.line - b.line)
}

/** A fragment is a release's entries with the week left off, so it answers to
 * the same rules — it is about to become part of the changelog. */
function checkFragment(source: string): ChangelogProblem[] {
  const { sections, problems } = parseFragment(source)
  if (sections.length === 0 && problems.length === 0) {
    problems.push({ line: 1, message: "The fragment holds no entries." })
  }
  checkSections(sections, problems, "this fragment")
  return problems.sort((a, b) => a.line - b.line)
}

const FRAGMENTS = "changelog.d"

function fragmentPaths(): string[] {
  try {
    return readdirSync(FRAGMENTS)
      .filter((name) => name.endsWith(".md") && name !== "README.md")
      .sort()
      .map((name) => `${FRAGMENTS}/${name}`)
  } catch {
    return []
  }
}

const reports: [string, ChangelogProblem[]][] = [
  ["CHANGELOG.md", checkChangelog(readFileSync("CHANGELOG.md", "utf8"))],
  ...fragmentPaths().map((path): [string, ChangelogProblem[]] => [
    path,
    checkFragment(readFileSync(path, "utf8")),
  ]),
]

const total = reports.reduce((count, [, problems]) => count + problems.length, 0)

if (total === 0) {
  const checked =
    reports.length === 1
      ? "CHANGELOG.md"
      : `CHANGELOG.md and ${reports.length - 1} fragment${reports.length === 2 ? "" : "s"}`
  console.log(`${checked} \u2014 no problems.`)
} else {
  for (const [path, problems] of reports) {
    for (const { line, message } of problems) console.error(`${path}:${line}  ${message}`)
  }
  console.error(`\n${total} problem${total === 1 ? "" : "s"}.`)
  ;(globalThis as { process?: { exitCode?: number } }).process!.exitCode = 1
}
