/**
 * Custom merge driver for `git pull` and the conflict policy built on top of
 * it. Pure (no filesystem) so it can be unit-tested directly.
 *
 * Policy:
 * - Non-note files (anything not ending in `.md` — the `.ruminate/` view-state
 *   sidecars, plus any binary/unknown files) merge ours-wins, always clean, so
 *   sync can never dead-end on them (view state is low-stakes; no notices).
 * - Notes get a real diff3 merge: non-overlapping edits from both sides both
 *   survive; each genuinely CONFLICTING hunk takes the PREFERRED side (see
 *   `PreferredSide` — newest branch tip wins), and the conflict is recorded so
 *   the caller can point the user at the full LOSING version in the note's git
 *   history (the merge commit keeps both parents, so the losing version stays
 *   reachable). Nothing is ever silently lost.
 *
 * Note: isomorphic-git invokes the driver with the file's *basename*, not its
 * full repo path (see `mergeTree` in isomorphic-git — `path: basename(filepath)`),
 * so the policy is keyed on extension and conflicted files are re-resolved to
 * full paths afterwards by basename + merged content (`matchConflictPaths`).
 */

import diff3Merge from "diff3"
import type { MergeDriverCallback } from "isomorphic-git"

// Same line splitter isomorphic-git's builtin merge driver uses.
const LINEBREAKS = /^.*(\r?\n|$)/gm

/**
 * Which side of a merge wins each genuinely conflicting hunk. Chosen per pull
 * from the two branch tips' commit timestamps (`newerSide`) so a stale device
 * pulling later can never silently revert a fresher edit.
 */
export type PreferredSide = "ours" | "theirs"

/**
 * Extract the commit timestamp (seconds since epoch) from a `git.log` entry:
 * the committer timestamp, falling back to the author's, else 0.
 */
export function commitTimestamp(
  entry:
    | {
        commit?: {
          committer?: { timestamp?: number }
          author?: { timestamp?: number }
        }
      }
    | undefined,
): number {
  return entry?.commit?.committer?.timestamp ?? entry?.commit?.author?.timestamp ?? 0
}

/**
 * Newest-wins: the side whose branch tip was committed later wins conflicting
 * hunks; ties go to ours. Branch-tip committer time is an approximation —
 * device clocks can skew and a tip timestamp says nothing about individual
 * hunks — but it is good enough for a personal app (per-hunk recency is not
 * available from a merge driver), and the losing side always stays reachable
 * in the note's version history anyway.
 */
export function newerSide(oursTimestamp: number, theirsTimestamp: number): PreferredSide {
  return theirsTimestamp > oursTimestamp ? "theirs" : "ours"
}

export type MergeTextResult = {
  mergedText: string
  /** True when at least one hunk genuinely conflicted (the preferred side was taken). */
  hadConflict: boolean
}

/**
 * Three-way merge of text contents. Clean merges stay clean (non-overlapping
 * edits from both sides both survive); each conflicting hunk resolves to the
 * preferred side.
 */
export function mergeTextPreferring(
  base: string,
  ours: string,
  theirs: string,
  prefer: PreferredSide,
): MergeTextResult {
  const baseLines = base.match(LINEBREAKS) ?? []
  const ourLines = ours.match(LINEBREAKS) ?? []
  const theirLines = theirs.match(LINEBREAKS) ?? []

  const regions = diff3Merge(ourLines, baseLines, theirLines)

  let mergedText = ""
  let hadConflict = false
  for (const region of regions) {
    if (region.ok) {
      mergedText += region.ok.join("")
    }
    if (region.conflict) {
      hadConflict = true
      // `a` is ours (first argument to diff3Merge), `b` is theirs.
      mergedText += (prefer === "ours" ? region.conflict.a : region.conflict.b).join("")
    }
  }
  return { mergedText, hadConflict }
}

export type RecordedConflict = {
  /** Basename of the conflicted file (all isomorphic-git exposes to the driver). */
  basename: string
  /** Which side LOST the conflicting hunks (its full version is `preserved`). */
  preservedSide: PreferredSide
  /** The full content of the losing side of the merge. */
  preserved: string
  /** The text the merge produced (the preferred side won each conflicting hunk). */
  merged: string
}

export type ConflictRecordingMergeDriver = {
  mergeDriver: MergeDriverCallback
  /** Conflicts recorded so far; reset with `conflicts.length = 0` before a retry. */
  conflicts: RecordedConflict[]
}

/**
 * Build the merge driver passed to `git.merge`. It never reports an unclean
 * merge, so `abortOnConflict` can never fire for the cases the driver handles
 * (both sides modified a file's content). `prefer` decides which side wins
 * conflicting hunks in notes; each conflict is recorded so the caller can
 * surface the losing version (via the note's git history) to the user.
 */
export function createConflictRecordingMergeDriver(
  prefer: PreferredSide = "ours",
): ConflictRecordingMergeDriver {
  const conflicts: RecordedConflict[] = []

  const mergeDriver: MergeDriverCallback = ({ contents, path }) => {
    const [base, ours, theirs] = contents

    // Non-note files (view-state sidecars, binary/unknown): ours wins, clean,
    // regardless of preference — view state is low-stakes and gets no copies.
    if (!path.endsWith(".md")) {
      return { cleanMerge: true, mergedText: ours }
    }

    const { mergedText, hadConflict } = mergeTextPreferring(base, ours, theirs, prefer)
    if (hadConflict) {
      conflicts.push({
        basename: path,
        preservedSide: prefer === "ours" ? "theirs" : "ours",
        preserved: prefer === "ours" ? theirs : ours,
        merged: mergedText,
      })
    }
    return { cleanMerge: true, mergedText }
  }

  return { mergeDriver, conflicts }
}

/**
 * Resolve a recorded conflict back to full repo paths: the driver only saw the
 * basename, so match against all note paths, disambiguating by the merged
 * content that checkout just wrote.
 */
export function matchConflictPath(
  conflict: RecordedConflict,
  allPaths: string[],
  readContent: (path: string) => string | undefined,
): string | null {
  const candidates = allPaths.filter((p) => p.split("/").pop() === conflict.basename)
  if (candidates.length === 0) return null
  if (candidates.length === 1) return candidates[0]
  return candidates.find((p) => readContent(p) === conflict.merged) ?? candidates[0]
}

/** Format a date as `yyyymmdd-hhmm` for conflicted-copy note ids (local-backup restores). */
export function formatConflictTimestamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(
    date.getHours(),
  )}${pad(date.getMinutes())}`
}

export type ConflictCopy = {
  /** Note id of the conflicted copy, e.g. `notes/foo-conflict-20260827-1432`. */
  id: string
  /** Full content: the losing version, prefixed with a notice line. */
  content: string
}

/**
 * Build a conflicted-copy note preserving the full content of another version
 * of a note (used by the local-backup restore path — sync merges no longer
 * create copy notes; their losing versions live in the note's git history).
 * The id `<originalId>-conflict-<yyyymmdd-hhmm>` only uses characters already
 * valid in the original id plus `-` and digits, so it always satisfies the
 * app's note-id rules. The notice line is inserted after any frontmatter so
 * the copy's metadata still parses.
 */
export function buildConflictCopy(
  originalId: string,
  preservedContent: string,
  date: Date,
  notice: string,
): ConflictCopy {
  const id = `${originalId}-conflict-${formatConflictTimestamp(date)}`

  // Keep frontmatter (if any) at the top so it still parses.
  const frontmatterMatch = preservedContent.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/)
  const content = frontmatterMatch
    ? `${frontmatterMatch[0]}${notice}\n\n${preservedContent.slice(frontmatterMatch[0].length)}`
    : `${notice}\n\n${preservedContent}`

  return { id, content }
}
