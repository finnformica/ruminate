import { collateFiles, type ChangelogRelease } from "./changelog"

/**
 * The changelog as the app reads it: every file under `changelog/`, collated
 * into releases at the point of reading.
 *
 * There is no single changelog document in the repository, and nothing folds
 * one together. Each change's entries stay in the file the branch that made it
 * wrote, under the week it was written in, so two branches open at once write
 * two different files and never conflict. What a reader sees is assembled
 * here, which means it is always complete: there is no step between a change
 * landing and its entry being readable, and so no window in which someone who
 * has just pressed **Update Ruminate** is told nothing changed.
 */

/**
 * Bundled at build time. They are plain text and small — the whole changelog
 * is a fraction of one note — and being eager means the collation is a pure
 * function of what shipped, with nothing to fetch and nothing to fail.
 */
const FILES = import.meta.glob("../../changelog/*/*.md", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>

export function loadChangelog(): ChangelogRelease[] {
  return collateFiles(Object.entries(FILES).map(([path, text]) => ({ path, text }))).releases
}
