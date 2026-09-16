/**
 * Fold the pending changelog fragments into this week's release.
 *
 *   npm run changelog:collate
 *
 * `CHANGELOG.md` is one file that every branch wants to write to, at the top,
 * where a new release goes — so two pull requests in the same week conflict
 * over entries that have nothing to do with one another. A branch therefore
 * never edits `CHANGELOG.md` at all. It drops one file in `changelog.d/`, and
 * two branches touching two different files have nothing to conflict over.
 *
 * This script is the other half: it merges every fragment into the release for
 * the current ISO week, creating that release if the week is new, sorts the
 * categories into their canonical order, and deletes the fragments it folded.
 * It runs once per push to `main` (.github/workflows/changelog.yml), so the
 * merge happens in one place rather than in every branch.
 *
 * It refuses to touch anything it does not understand: a fault in the
 * changelog or in any fragment stops the run with nothing written.
 */
import {
  mergeFragments,
  parseChangelog,
  parseFragment,
  renderRelease,
  toReleaseWeek,
  type ChangelogSection,
} from "../src/utils/changelog"

const builtin = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process
  ?.getBuiltinModule as (id: string) => unknown
const { readdirSync, readFileSync, writeFileSync, unlinkSync } = builtin("node:fs") as {
  readdirSync: (path: string) => string[]
  readFileSync: (path: string, encoding: string) => string
  writeFileSync: (path: string, data: string) => void
  unlinkSync: (path: string) => void
}

const CHANGELOG = "CHANGELOG.md"
const FRAGMENTS = "changelog.d"
/** The directory's own explanation, which is not a fragment. */
const NOT_A_FRAGMENT = new Set(["README.md"])

function fail(message: string): never {
  console.error(message)
  ;(globalThis as { process?: { exit?: (code: number) => never } }).process!.exit!(1)
}

function pendingFragments(): string[] {
  let names: string[]
  try {
    names = readdirSync(FRAGMENTS)
  } catch {
    return []
  }
  return names
    .filter((name) => name.endsWith(".md") && !NOT_A_FRAGMENT.has(name))
    .sort()
    .map((name) => `${FRAGMENTS}/${name}`)
}

const paths = pendingFragments()
if (paths.length === 0) {
  console.log("No fragments to fold.")
} else {
  const source = readFileSync(CHANGELOG, "utf8")
  const { releases, problems } = parseChangelog(source)
  if (problems.length > 0) {
    fail(
      `${CHANGELOG} has problems, so nothing was folded. Run \`npm run check:changelog\`.\n` +
        problems.map(({ line, message }) => `  ${CHANGELOG}:${line}  ${message}`).join("\n"),
    )
  }

  // Every fragment is read before anything is written, so one bad file leaves
  // the changelog and the other fragments untouched.
  const incoming: ChangelogSection[] = []
  for (const path of paths) {
    const fragment = parseFragment(readFileSync(path, "utf8"))
    if (fragment.problems.length > 0) {
      fail(
        `${path} has problems, so nothing was folded. Run \`npm run check:changelog\`.\n` +
          fragment.problems.map(({ line, message }) => `  ${path}:${line}  ${message}`).join("\n"),
      )
    }
    if (fragment.sections.length === 0) fail(`${path} holds no entries.`)
    incoming.push(...fragment.sections)
  }

  const week = toReleaseWeek(new Date())
  const existing = releases.find((release) => release.week === week)
  const added = incoming.reduce((count, section) => count + section.entries.length, 0)
  // The same fold the app does in memory at build time, so a reader sees the
  // same release either side of collation.
  const merged = mergeFragments(releases, incoming, week).find((release) => release.week === week)!

  const lines = source.split("\n")
  const rendered = renderRelease(merged)
  let next: string
  if (existing) {
    // Replace the week's section: everything from its heading to the next
    // release, or to the end of the file.
    const start = existing.line - 1
    const following = releases.find((release) => release.line > existing.line)
    const end = following ? following.line - 1 : lines.length
    next = [...lines.slice(0, start), ...rendered.split("\n"), ...lines.slice(end)].join("\n")
  } else {
    // A new week goes directly below the title, above every older release.
    const title = lines.findIndex((line) => line.startsWith("# "))
    const at = title + 2
    next = [...lines.slice(0, at), ...rendered.split("\n"), ...lines.slice(at)].join("\n")
  }

  writeFileSync(CHANGELOG, next.replace(/\n{3,}/g, "\n\n").replace(/\n*$/, "\n"))
  for (const path of paths) unlinkSync(path)

  const entries = `${added} ${added === 1 ? "entry" : "entries"}`
  const files = `${paths.length} ${paths.length === 1 ? "fragment" : "fragments"}`
  console.log(`Folded ${entries} from ${files} into ${week}${existing ? "" : " (a new release)"}.`)
}
