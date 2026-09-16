import {
  mergeFragments,
  parseChangelog,
  parseFragment,
  toReleaseWeek,
  type ChangelogRelease,
} from "./changelog"

/**
 * The changelog as the app reads it: the released weeks, plus whatever is
 * still sitting in `changelog.d/` waiting to be folded.
 *
 * The pending fragments matter more than they look. A branch writes its entries
 * to `changelog.d/` and they are folded into `CHANGELOG.md` only once it lands
 * on `main` and the collation workflow runs. A build taken before that — or
 * while collation is blocked — would otherwise ship an app whose changelog
 * says nothing about the very changes in it, and the reader who has just
 * pressed **Update Ruminate** would be told there was nothing new.
 *
 * So the fold happens twice: for real on `main`, and here in memory at build
 * time, using the same `mergeFragments` both times. The two agree, so folding
 * later changes nothing a reader sees.
 */

/** Bundled at build time, so a fragment written this morning is in tonight's
 * app. They are small; the changelog itself is fetched separately. */
const PENDING = import.meta.glob("../../changelog.d/*.md", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>

/** The directory's own explanation, which is not a fragment. */
function isFragment(path: string): boolean {
  return !path.endsWith("/README.md")
}

export async function loadChangelog(): Promise<ChangelogRelease[]> {
  // Dynamic, so `CHANGELOG.md` lands in the chunk of whoever asked for it
  // rather than in the app bundle. It only grows, and most visits never open
  // a changelog at all.
  const { default: source } = await import("../../CHANGELOG.md?raw")
  const { releases } = parseChangelog(source)

  const sections = Object.entries(PENDING)
    .filter(([path]) => isFragment(path))
    .sort(([a], [b]) => a.localeCompare(b))
    // A fragment that does not parse is left out rather than allowed to break
    // the page. CI refuses to let one through, so this is belt and braces.
    .flatMap(([, text]) => {
      const { sections, problems } = parseFragment(text)
      return problems.length > 0 ? [] : sections
    })

  return mergeFragments(releases, sections, toReleaseWeek(new Date()))
}
