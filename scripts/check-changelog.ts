/**
 * The changelog gate, as a CI check.
 *
 *   npm run check:changelog
 *
 * The changelog is a folder of files — `changelog/<week>/<change>.md` — read by
 * the app to build the changelog page and the what's-new card. A malformed
 * entry is a broken page, not just an untidy document, so this parses them with
 * the very module the app uses (`src/utils/changelog.ts`) and then applies the
 * house rules on top: the shape of an entry, and the words it may not use.
 *
 * The rules exist because a changelog drifts towards being a commit log. They
 * are deliberately mechanical — whether an entry is worth a user's attention
 * at all is a judgement, and lives in `.claude/skills/changelog`.
 */
import {
  collateFiles,
  MAX_ENTRY_LENGTH,
  MAX_LEAD_LENGTH,
  visibleLength,
  type ChangelogProblem,
  type ChangelogSection,
} from "../src/utils/changelog"

// `node:fs` via `getBuiltinModule`, dodging the vite node-polyfills alias
// (same trick as scripts/check-queries.ts).
const builtin = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process
  ?.getBuiltinModule as (id: string) => unknown
const { readdirSync, readFileSync } = builtin("node:fs") as {
  readdirSync: (path: string, options?: { withFileTypes: true }) => string[]
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

/**
 * The admin's surfaces are not the changelog's business.
 *
 * Ruminate's changelog is read by everybody, and almost nobody using it is the
 * admin: an entry about the Admin page, the allowlist or a feature flag tells
 * the overwhelming majority of readers about a door they cannot open. Worse,
 * it quietly advertises where the controls are. Changes to those surfaces go
 * in `docs/`, or in the pull request that makes them, and nowhere else.
 */
const ADMIN = /\badmins?\b|\ballowlist\b|\bfeature flags?\b/i

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
  if (ADMIN.test(text)) {
    fault(
      "The changelog is read by everybody, and the admin's surfaces are not its business. " +
        "Put this in docs/ or in the pull request instead.",
    )
  }
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

const CHANGELOG = "changelog"

/** Every entry file, as `changelog/<week>/<change>.md`. */
function changelogFiles(): { path: string; text: string }[] {
  const files: { path: string; text: string }[] = []
  for (const week of readdirSync(CHANGELOG).sort()) {
    let names: string[]
    try {
      names = readdirSync(`${CHANGELOG}/${week}`).sort()
    } catch {
      // Not a folder — a stray file beside the weeks, which is reported below.
      files.push({ path: `${CHANGELOG}/${week}`, text: "" })
      continue
    }
    for (const name of names) {
      if (!name.endsWith(".md")) continue
      const path = `${CHANGELOG}/${week}/${name}`
      files.push({ path, text: readFileSync(path, "utf8") })
    }
  }
  return files
}

const files = changelogFiles()
const problems = new Map<string, ChangelogProblem[]>()
const report = (path: string, found: ChangelogProblem[]) => {
  if (found.length > 0) problems.set(path, [...(problems.get(path) ?? []), ...found])
}

if (files.length === 0) {
  report(CHANGELOG, [{ line: 1, message: "There are no changelog files at all." }])
}

// Each file on its own, so a fault is reported against the file that holds it.
for (const file of files) {
  const found: ChangelogProblem[] = []
  const { releases } = collateFiles([file])
  const week = releases[0]?.week
  if (!week) {
    found.push({
      line: 1,
      message: `Not in a week's folder. An entry file is "${CHANGELOG}/2026-W38/<change>.md".`,
    })
  }
  found.push(...collateFiles([file]).problems)
  checkSections(releases[0]?.sections ?? [], found, week ?? "this file")
  report(
    file.path,
    found.sort((a, b) => a.line - b.line),
  )
}

const total = [...problems.values()].reduce((count, found) => count + found.length, 0)

if (total === 0) {
  console.log(`${files.length} changelog file${files.length === 1 ? "" : "s"} \u2014 no problems.`)
} else {
  for (const [path, found] of problems) {
    for (const { line, message } of found) console.error(`${path}:${line}  ${message}`)
  }
  console.error(`\n${total} problem${total === 1 ? "" : "s"}.`)
  ;(globalThis as { process?: { exitCode?: number } }).process!.exitCode = 1
}
