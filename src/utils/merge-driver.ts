/**
 * Custom merge driver for `git pull` and the conflicted-copy policy built on
 * top of it. Pure (no filesystem) so it can be unit-tested directly.
 *
 * Policy:
 * - Non-note files (anything not ending in `.md` — the `.ruminate/` view-state
 *   sidecars, plus any binary/unknown files) merge ours-wins, always clean, so
 *   sync can never dead-end on them.
 * - Notes get a real diff3 merge: non-overlapping edits from both sides both
 *   survive; each genuinely CONFLICTING hunk takes OURS, and the conflict is
 *   recorded so the caller can preserve the full remote version as a
 *   conflicted-copy note. Nothing is ever silently lost.
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

export type MergeOursWinsResult = {
  mergedText: string
  /** True when at least one hunk genuinely conflicted (ours was taken). */
  hadConflict: boolean
}

/**
 * Three-way merge of text contents. Clean merges stay clean (non-overlapping
 * edits from both sides both survive); each conflicting hunk resolves to ours.
 */
export function mergeTextOursWins(base: string, ours: string, theirs: string): MergeOursWinsResult {
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
      mergedText += region.conflict.a.join("")
    }
  }
  return { mergedText, hadConflict }
}

export type RecordedConflict = {
  /** Basename of the conflicted file (all isomorphic-git exposes to the driver). */
  basename: string
  /** The full remote version of the file. */
  theirs: string
  /** The text the merge produced (ours won each conflicting hunk). */
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
 * (both sides modified a file's content).
 */
export function createConflictRecordingMergeDriver(): ConflictRecordingMergeDriver {
  const conflicts: RecordedConflict[] = []

  const mergeDriver: MergeDriverCallback = ({ contents, path }) => {
    const [base, ours, theirs] = contents

    // Non-note files (view-state sidecars, binary/unknown): ours wins, clean.
    if (!path.endsWith(".md")) {
      return { cleanMerge: true, mergedText: ours }
    }

    const { mergedText, hadConflict } = mergeTextOursWins(base, ours, theirs)
    if (hadConflict) {
      conflicts.push({ basename: path, theirs, merged: mergedText })
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

/** Format a date as `yyyymmdd-hhmm` for conflicted-copy note ids. */
export function formatConflictTimestamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(
    date.getHours(),
  )}${pad(date.getMinutes())}`
}

export type ConflictCopy = {
  /** Note id of the conflicted copy, e.g. `notes/foo-conflict-20260827-1432`. */
  id: string
  /** Full content: the remote version, prefixed with a notice line. */
  content: string
}

/**
 * Build the conflicted-copy note preserving the full remote version of a note
 * that had a real conflicting hunk. The id `<originalId>-conflict-<yyyymmdd-hhmm>`
 * only uses characters already valid in the original id plus `-` and digits,
 * so it always satisfies the app's note-id rules. The notice line is inserted
 * after any frontmatter so the copy's metadata still parses.
 */
export function buildConflictCopy(
  originalId: string,
  remoteContent: string,
  date: Date,
): ConflictCopy {
  const id = `${originalId}-conflict-${formatConflictTimestamp(date)}`
  const notice = `Remote copy of [[${originalId}]] from a sync conflict — the local version won; nothing was lost.`

  // Keep frontmatter (if any) at the top so it still parses.
  const frontmatterMatch = remoteContent.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/)
  const content = frontmatterMatch
    ? `${frontmatterMatch[0]}${notice}\n\n${remoteContent.slice(frontmatterMatch[0].length)}`
    : `${notice}\n\n${remoteContent}`

  return { id, content }
}
