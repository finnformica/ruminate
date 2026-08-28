/**
 * Per-note version history, reconstructed from git.
 *
 * Pure walk logic: everything here runs against the tiny `GitHistoryApi`
 * abstraction so it can be unit-tested without a real repo. The wiring to
 * isomorphic-git + lightning-fs lives in `src/data/note-history.ts`.
 *
 * The walk starts from a cursor (default HEAD) and visits commits newest-first
 * across ALL parents — not just first parents. Sync resolves cross-device
 * conflicts with real merge commits, so the losing side's version of a note
 * exists only on a merge's second-parent chain; a first-parent-only walk would
 * hide exactly the versions users most need to recover. A commit is kept as a
 * version only when the file's blob oid differs from its first parent's — i.e.
 * it actually changed this note. Commits that only touched other files
 * (view-state sidecars, other notes, merges that didn't change this file) are
 * dropped. Versions reached only through a merge's second parent are flagged
 * `mergeSide` so the UI can label them ("merged from another device").
 *
 * `nextCursor` serializes the walk frontier (the commits seen but not yet
 * examined), so the next page resumes with no gaps and no duplicates even
 * across diamond-shaped history. History is read-only here; restoring a
 * version is a normal forward save, never a rewrite.
 */

/** The minimal read-only git surface the walk needs. */
export type GitHistoryApi = {
  /** The sha of the current HEAD commit. */
  resolveHead(): Promise<string>
  /** First-parent-relevant commit metadata. */
  readCommit(sha: string): Promise<{ parents: string[]; timestamp: number }>
  /** Blob oid of `filepath` in the commit's tree, or null when absent. */
  resolveFileOid(sha: string, filepath: string): Promise<string | null>
  /** UTF-8 content of a blob. */
  readBlobText(oid: string): Promise<string>
}

export type NoteVersion = {
  /** The commit that changed the file. */
  sha: string
  /** Commit time, unix seconds. */
  timestamp: number
  /** Blob oid of the file at this commit; null when this commit deleted it. */
  oid: string | null
  /** Blob oid in the commit's first parent (the previous version); null when created. */
  parentOid: string | null
  /**
   * True when this version is reachable only through a merge's second parent —
   * an edit made on another device that a newest-wins merge may have replaced.
   */
  mergeSide: boolean
}

export type NoteVersionsPage = {
  versions: NoteVersion[]
  /** Opaque cursor to resume the walk from, or null when history is exhausted. */
  nextCursor: string | null
}

const DEFAULT_PAGE_LIMIT = 20
const PAGE_CACHE_LIMIT = 64
const BLOB_CACHE_LIMIT = 64

/**
 * One unexamined commit on the walk frontier. `spine` marks first-parent
 * reachability from the starting commit — the local timeline; everything else
 * arrived through a merge's second parent (another device's chain).
 */
type FrontierEntry = { sha: string; spine: boolean }

function serializeCursor(frontier: FrontierEntry[]): string | null {
  if (frontier.length === 0) return null
  return JSON.stringify(frontier)
}

function parseCursor(cursor: string): FrontierEntry[] {
  try {
    const parsed: unknown = JSON.parse(cursor)
    if (Array.isArray(parsed)) {
      return parsed.map((entry) => ({
        sha: String((entry as FrontierEntry).sha),
        spine: Boolean((entry as FrontierEntry).spine),
      }))
    }
  } catch {
    // Fall through: treat the cursor as a bare sha (a spine frontier of one).
  }
  return [{ sha: cursor, spine: true }]
}

/** Insert into a Map used as a FIFO cache, evicting the oldest entry over `limit`. */
function cacheSet<K, V>(cache: Map<K, V>, key: K, value: V, limit: number) {
  cache.set(key, value)
  if (cache.size > limit) {
    cache.delete(cache.keys().next().value as K)
  }
}

export function createNoteHistory(api: GitHistoryApi) {
  // Pages are cached keyed by filepath + HEAD + cursor, so a sync (which moves
  // HEAD) invalidates naturally and reopening the dialog is instant.
  const pageCache = new Map<string, NoteVersionsPage>()
  // Blobs are content-addressed, so this cache never goes stale.
  const blobCache = new Map<string, string>()

  /**
   * One page of the note's versions, walking commits newest-first from
   * `cursor` (default HEAD) toward the root across ALL parents. Each hop is
   * one commit read plus at most one tree resolution per commit (parent
   * resolutions are reused when that commit is examined), so a page's cost is
   * proportional to the number of commits between its versions — never the
   * whole history at once.
   *
   * No commit is ever examined twice: parents are enqueued with dedup, and
   * because a parent is always older than its children, every child has been
   * popped (newest-first order) before the parent can be reached again —
   * including across page boundaries, where the frontier snapshot in the
   * cursor carries the dedup forward.
   */
  async function listNoteVersions(params: {
    filepath: string
    cursor?: string
    limit?: number
  }): Promise<NoteVersionsPage> {
    const { filepath, cursor, limit = DEFAULT_PAGE_LIMIT } = params
    const head = await api.resolveHead()
    const cacheKey = `${filepath}@${head}#${cursor ?? ""}#${limit}`
    const cached = pageCache.get(cacheKey)
    if (cached) return cached

    // Per-walk memos. Each commit's tree is resolved at most once even though
    // it's consulted twice (as a parent, then when examined itself).
    const fileOidBySha = new Map<string, string | null>()
    const fileOidAt = async (sha: string): Promise<string | null> => {
      if (fileOidBySha.has(sha)) return fileOidBySha.get(sha)!
      const oid = await api.resolveFileOid(sha, filepath)
      fileOidBySha.set(sha, oid)
      return oid
    }
    const commitBySha = new Map<string, { parents: string[]; timestamp: number }>()
    const commitAt = async (sha: string) => {
      let commit = commitBySha.get(sha)
      if (!commit) {
        commit = await api.readCommit(sha)
        commitBySha.set(sha, commit)
      }
      return commit
    }

    // The frontier holds commits seen but not yet examined. `spineBySha` is
    // both the enqueue-dedup set and the spine flag store: a commit reachable
    // as a first parent of a spine commit is spine, however it was first
    // enqueued (diamonds can enqueue it from the side chain first; children
    // are always examined before their parents, so flags settle in time).
    const frontier: string[] = []
    const spineBySha = new Map<string, boolean>()
    for (const entry of cursor ? parseCursor(cursor) : [{ sha: head, spine: true }]) {
      if (!spineBySha.has(entry.sha)) {
        frontier.push(entry.sha)
        spineBySha.set(entry.sha, entry.spine)
      }
    }

    const versions: NoteVersion[] = []

    while (frontier.length > 0 && versions.length < limit) {
      // Pop the newest frontier commit (ties: spine first, then sha — purely
      // for determinism). The frontier is at most a few concurrent branches
      // wide, so a linear scan is fine.
      let bestIndex = 0
      for (let i = 1; i < frontier.length; i++) {
        const best = await commitAt(frontier[bestIndex])
        const candidate = await commitAt(frontier[i])
        const bestSpine = spineBySha.get(frontier[bestIndex])!
        const candidateSpine = spineBySha.get(frontier[i])!
        if (
          candidate.timestamp > best.timestamp ||
          (candidate.timestamp === best.timestamp &&
            (candidateSpine !== bestSpine ? candidateSpine : frontier[i] > frontier[bestIndex]))
        ) {
          bestIndex = i
        }
      }
      const sha = frontier[bestIndex]
      frontier.splice(bestIndex, 1)
      const spine = spineBySha.get(sha)!

      const commit = await commitAt(sha)
      const oid = await fileOidAt(sha)
      const firstParent: string | null = commit.parents[0] ?? null
      const parentOid = firstParent ? await fileOidAt(firstParent) : null

      // Created (null -> oid), deleted (oid -> null), and modified all differ.
      if (oid !== parentOid) {
        versions.push({ sha, timestamp: commit.timestamp, oid, parentOid, mergeSide: !spine })
      }

      commit.parents.forEach((parent, index) => {
        const parentSpine = spine && index === 0
        if (spineBySha.has(parent)) {
          // Already enqueued via another child: first-parent-of-spine wins.
          if (parentSpine) spineBySha.set(parent, true)
        } else {
          spineBySha.set(parent, parentSpine)
          frontier.push(parent)
        }
      })
    }

    const page: NoteVersionsPage = {
      versions,
      nextCursor: serializeCursor(frontier.map((sha) => ({ sha, spine: spineBySha.get(sha)! }))),
    }
    cacheSet(pageCache, cacheKey, page, PAGE_CACHE_LIMIT)
    return page
  }

  /** The full file content of one version, by its blob oid. */
  async function readNoteVersion(params: { oid: string }): Promise<string> {
    const cached = blobCache.get(params.oid)
    if (cached !== undefined) return cached
    const text = await api.readBlobText(params.oid)
    cacheSet(blobCache, params.oid, text, BLOB_CACHE_LIMIT)
    return text
  }

  return { listNoteVersions, readNoteVersion }
}

export type LineDiffSummary = {
  added: number
  removed: number
  /** True when the counts came from the order-insensitive fallback (huge diffs). */
  approximate: boolean
}

/** Above this many DP cells (after trimming), fall back to the multiset count. */
const LCS_CELL_LIMIT = 1_000_000

const splitLines = (text: string): string[] => (text === "" ? [] : text.split("\n"))

/**
 * Cheap line-level +N/−M summary between two versions of a file.
 *
 * Exact (LCS-based) for typical note sizes; common leading/trailing lines are
 * trimmed first so ordinary edits stay tiny regardless of note length. For
 * pathological inputs (both sides changed thousands of lines) it falls back
 * to an order-insensitive multiset count and flags `approximate`.
 */
export function diffLineCounts(before: string, after: string): LineDiffSummary {
  if (before === after) return { added: 0, removed: 0, approximate: false }

  const a = splitLines(before)
  const b = splitLines(after)

  // Trim common prefix and suffix — the DP only sees the changed middle.
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }

  const midA = a.slice(start, endA)
  const midB = b.slice(start, endB)

  if (midA.length * midB.length > LCS_CELL_LIMIT) {
    // Multiset approximation: counts matched lines regardless of order, so a
    // pure reorder reads as unchanged. Only reachable for enormous diffs.
    const counts = new Map<string, number>()
    for (const line of midA) counts.set(line, (counts.get(line) ?? 0) + 1)
    let common = 0
    for (const line of midB) {
      const count = counts.get(line) ?? 0
      if (count > 0) {
        counts.set(line, count - 1)
        common++
      }
    }
    return { added: midB.length - common, removed: midA.length - common, approximate: true }
  }

  const lcs = lcsLength(midA, midB)
  return { added: midB.length - lcs, removed: midA.length - lcs, approximate: false }
}

/** Classic two-row LCS length over lines. */
function lcsLength(a: string[], b: string[]): number {
  let prev: number[] = new Array(b.length + 1).fill(0)
  let curr: number[] = new Array(b.length + 1).fill(0)
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      curr[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], curr[j - 1])
    }
    const swap = prev
    prev = curr
    curr = swap
  }
  return prev[b.length]
}
