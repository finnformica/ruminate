import { describe, expect, it } from "vitest"
import { GitHistoryApi, NoteVersion, createNoteHistory, diffLineCounts } from "./note-history"

/**
 * Declarative repo fixture: an ordered list of commits (newest first is not
 * required — linked by `parent`), each with a snapshot of file -> blob oid.
 * Blob contents are provided separately, keyed by oid.
 */
type FixtureCommit = {
  sha: string
  parent?: string
  parents?: string[]
  timestamp?: number
  files: Record<string, string>
}

function createFixtureApi({
  commits,
  head,
  blobs = {},
}: {
  commits: FixtureCommit[]
  head: string
  blobs?: Record<string, string>
}) {
  const bySha = new Map(commits.map((c) => [c.sha, c]))
  const calls = { readCommit: 0, resolveFileOid: 0, readBlobText: 0 }

  const api: GitHistoryApi = {
    resolveHead: async () => head,
    async readCommit(sha) {
      calls.readCommit++
      const commit = bySha.get(sha)
      if (!commit) throw new Error(`No such commit: ${sha}`)
      return {
        parents: commit.parents ?? (commit.parent ? [commit.parent] : []),
        timestamp: commit.timestamp ?? 0,
      }
    },
    async resolveFileOid(sha, filepath) {
      calls.resolveFileOid++
      const commit = bySha.get(sha)
      if (!commit) throw new Error(`No such commit: ${sha}`)
      return commit.files[filepath] ?? null
    },
    async readBlobText(oid) {
      calls.readBlobText++
      if (!(oid in blobs)) throw new Error(`No such blob: ${oid}`)
      return blobs[oid]
    },
  }

  return { api, calls }
}

const shas = (versions: NoteVersion[]) => versions.map((v) => v.sha)

describe("listNoteVersions", () => {
  it("keeps only commits that changed the file, dropping interleaved noise", async () => {
    const { api } = createFixtureApi({
      head: "c5",
      commits: [
        // c5 only touched the view-state sidecar — dropped.
        { sha: "c5", parent: "c4", timestamp: 50, files: { "note.md": "b2", "note.json": "s2" } },
        // c4 changed the note — kept.
        { sha: "c4", parent: "c3", timestamp: 40, files: { "note.md": "b2", "note.json": "s1" } },
        // c3 only touched another note — dropped.
        { sha: "c3", parent: "c2", timestamp: 30, files: { "note.md": "b1", "other.md": "x2" } },
        // c2 changed the note — kept.
        { sha: "c2", parent: "c1", timestamp: 20, files: { "note.md": "b1", "other.md": "x1" } },
        // c1 created other files only — dropped.
        { sha: "c1", timestamp: 10, files: { "other.md": "x1" } },
      ],
    })

    const { listNoteVersions } = createNoteHistory(api)
    const page = await listNoteVersions({ filepath: "note.md" })

    expect(shas(page.versions)).toEqual(["c4", "c2"])
    expect(page.versions[0]).toEqual({
      sha: "c4",
      timestamp: 40,
      oid: "b2",
      parentOid: "b1",
      mergeSide: false,
    })
    expect(page.nextCursor).toBeNull()
  })

  it("keeps the commit that created the file (null parent oid)", async () => {
    const { api } = createFixtureApi({
      head: "c2",
      commits: [
        { sha: "c2", parent: "c1", timestamp: 20, files: { "note.md": "b1", "other.md": "x1" } },
        { sha: "c1", timestamp: 10, files: { "other.md": "x1" } },
      ],
    })

    const { listNoteVersions } = createNoteHistory(api)
    const page = await listNoteVersions({ filepath: "note.md" })

    expect(page.versions).toEqual([
      { sha: "c2", timestamp: 20, oid: "b1", parentOid: null, mergeSide: false },
    ])
  })

  it("keeps the commit that created the file in the root commit", async () => {
    const { api } = createFixtureApi({
      head: "c1",
      commits: [{ sha: "c1", timestamp: 10, files: { "note.md": "b1" } }],
    })

    const { listNoteVersions } = createNoteHistory(api)
    const page = await listNoteVersions({ filepath: "note.md" })

    expect(page.versions).toEqual([
      { sha: "c1", timestamp: 10, oid: "b1", parentOid: null, mergeSide: false },
    ])
    expect(page.nextCursor).toBeNull()
  })

  it("keeps a deletion commit, with a null oid", async () => {
    const { api } = createFixtureApi({
      head: "c3",
      commits: [
        { sha: "c3", parent: "c2", timestamp: 30, files: {} }, // deleted here
        { sha: "c2", parent: "c1", timestamp: 20, files: { "note.md": "b1" } }, // created here
        { sha: "c1", timestamp: 10, files: {} },
      ],
    })

    const { listNoteVersions } = createNoteHistory(api)
    const page = await listNoteVersions({ filepath: "note.md" })

    expect(page.versions).toEqual([
      { sha: "c3", timestamp: 30, oid: null, parentOid: "b1", mergeSide: false },
      { sha: "c2", timestamp: 20, oid: "b1", parentOid: null, mergeSide: false },
    ])
  })

  it("respects the limit and resumes from nextCursor without gaps or duplicates", async () => {
    // 6 commits alternating the note's oid — every commit is a version.
    const commits: FixtureCommit[] = []
    for (let i = 6; i >= 1; i--) {
      commits.push({
        sha: `c${i}`,
        parent: i > 1 ? `c${i - 1}` : undefined,
        timestamp: i * 10,
        files: { "note.md": `b${i}` },
      })
    }
    const { api } = createFixtureApi({ head: "c6", commits })
    const { listNoteVersions } = createNoteHistory(api)

    const page1 = await listNoteVersions({ filepath: "note.md", limit: 2 })
    expect(shas(page1.versions)).toEqual(["c6", "c5"])
    expect(page1.nextCursor).toBeTruthy()

    const page2 = await listNoteVersions({
      filepath: "note.md",
      cursor: page1.nextCursor!,
      limit: 2,
    })
    expect(shas(page2.versions)).toEqual(["c4", "c3"])
    expect(page2.nextCursor).toBeTruthy()

    const page3 = await listNoteVersions({
      filepath: "note.md",
      cursor: page2.nextCursor!,
      limit: 2,
    })
    expect(shas(page3.versions)).toEqual(["c2", "c1"])
    expect(page3.nextCursor).toBeNull()

    // Paged shas concatenate to exactly the full walk: no gaps, no duplicates.
    const all = await listNoteVersions({ filepath: "note.md", limit: 10 })
    expect([...shas(page1.versions), ...shas(page2.versions), ...shas(page3.versions)]).toEqual(
      shas(all.versions),
    )
  })

  it("resumes across a page boundary that ends mid-run of unchanged commits", async () => {
    // c4 and c3 don't change the note; a page ending at c5 must resume at c4
    // and still find c2 without re-reporting c5.
    const { api } = createFixtureApi({
      head: "c5",
      commits: [
        { sha: "c5", parent: "c4", timestamp: 50, files: { "note.md": "b2" } },
        { sha: "c4", parent: "c3", timestamp: 40, files: { "note.md": "b1", "other.md": "x2" } },
        { sha: "c3", parent: "c2", timestamp: 30, files: { "note.md": "b1", "other.md": "x1" } },
        { sha: "c2", parent: "c1", timestamp: 20, files: { "note.md": "b1" } },
        { sha: "c1", timestamp: 10, files: {} },
      ],
    })
    const { listNoteVersions } = createNoteHistory(api)

    const page1 = await listNoteVersions({ filepath: "note.md", limit: 1 })
    expect(shas(page1.versions)).toEqual(["c5"])
    expect(page1.nextCursor).toBeTruthy()

    const page2 = await listNoteVersions({
      filepath: "note.md",
      cursor: page1.nextCursor!,
      limit: 5,
    })
    expect(shas(page2.versions)).toEqual(["c2"])
    expect(page2.nextCursor).toBeNull()
  })

  // The newest-wins sync merge shape: base -> local edit (A) + other-device
  // edit (B) -> merge that kept A. B's version exists only on the merge's
  // second-parent chain.
  const NEWEST_WINS_MERGE: FixtureCommit[] = [
    { sha: "m", parents: ["a1", "b1"], timestamp: 40, files: { "note.md": "vA" } },
    { sha: "b1", parent: "base", timestamp: 30, files: { "note.md": "vB" } },
    { sha: "a1", parent: "base", timestamp: 20, files: { "note.md": "vA" } },
    { sha: "base", timestamp: 10, files: { "note.md": "v0" } },
  ]

  it("surfaces the losing side of a merge as its own labeled version", async () => {
    const { api } = createFixtureApi({ head: "m", commits: NEWEST_WINS_MERGE })
    const { listNoteVersions } = createNoteHistory(api)
    const page = await listNoteVersions({ filepath: "note.md" })

    // The merge kept A, so the merge commit itself isn't a version; B's edit
    // appears exactly once, flagged as coming from the merged-in side.
    expect(page.versions).toEqual([
      { sha: "b1", timestamp: 30, oid: "vB", parentOid: "v0", mergeSide: true },
      { sha: "a1", timestamp: 20, oid: "vA", parentOid: "v0", mergeSide: false },
      { sha: "base", timestamp: 10, oid: "v0", parentOid: null, mergeSide: false },
    ])
    expect(page.nextCursor).toBeNull()
  })

  it("keeps the merge commit as a version when it changed the file vs its first parent", async () => {
    // Same shape, but the merge kept B (the other device won newest-wins).
    const { api } = createFixtureApi({
      head: "m",
      commits: [
        { sha: "m", parents: ["a1", "b1"], timestamp: 40, files: { "note.md": "vB" } },
        ...NEWEST_WINS_MERGE.slice(1),
      ],
    })
    const { listNoteVersions } = createNoteHistory(api)
    const page = await listNoteVersions({ filepath: "note.md" })

    expect(shas(page.versions)).toEqual(["m", "b1", "a1", "base"])
    // The merge is on the local spine; the original other-device commit is not.
    expect(page.versions.map((v) => v.mergeSide)).toEqual([false, true, false, false])
  })

  it("paginates across a merge without duplicates and with spine labels intact", async () => {
    const { api } = createFixtureApi({ head: "m", commits: NEWEST_WINS_MERGE })
    const { listNoteVersions } = createNoteHistory(api)

    const collected: NoteVersion[] = []
    let cursor: string | undefined
    let pages = 0
    do {
      const page: Awaited<ReturnType<typeof listNoteVersions>> = await listNoteVersions({
        filepath: "note.md",
        cursor,
        limit: 1,
      })
      collected.push(...page.versions)
      cursor = page.nextCursor ?? undefined
      pages++
    } while (cursor && pages < 10)

    const all = await listNoteVersions({ filepath: "note.md", limit: 10 })
    // One-at-a-time paging visits the diamond exactly once per version, in the
    // same order and with the same labels as a single big walk.
    expect(collected).toEqual(all.versions)
    expect(shas(collected)).toEqual(["b1", "a1", "base"])
    // "base" is reached from both sides of the diamond, across page
    // boundaries, and still comes out spine-labeled (via a1's first-parent
    // link) and only once.
    expect(collected[2].mergeSide).toBe(false)
  })

  it("caches pages per filepath + HEAD and invalidates when HEAD moves", async () => {
    let head = "c2"
    const commits: FixtureCommit[] = [
      { sha: "c3", parent: "c2", timestamp: 30, files: { "note.md": "b2" } },
      { sha: "c2", parent: "c1", timestamp: 20, files: { "note.md": "b1" } },
      { sha: "c1", timestamp: 10, files: {} },
    ]
    const { api, calls } = createFixtureApi({ head, commits })
    api.resolveHead = async () => head

    const { listNoteVersions } = createNoteHistory(api)

    const first = await listNoteVersions({ filepath: "note.md" })
    const readsAfterFirst = calls.readCommit
    const again = await listNoteVersions({ filepath: "note.md" })
    expect(again).toBe(first) // cached — no re-walk
    expect(calls.readCommit).toBe(readsAfterFirst)

    // A sync moves HEAD: the same call re-walks and sees the new version.
    head = "c3"
    const afterSync = await listNoteVersions({ filepath: "note.md" })
    expect(shas(afterSync.versions)).toEqual(["c3", "c2"])
    expect(calls.readCommit).toBeGreaterThan(readsAfterFirst)
  })

  it("resolves each commit's file oid at most once per walk", async () => {
    const commits: FixtureCommit[] = []
    for (let i = 4; i >= 1; i--) {
      commits.push({
        sha: `c${i}`,
        parent: i > 1 ? `c${i - 1}` : undefined,
        timestamp: i,
        files: { "note.md": `b${i}` },
      })
    }
    const { api, calls } = createFixtureApi({ head: "c4", commits })
    const { listNoteVersions } = createNoteHistory(api)

    await listNoteVersions({ filepath: "note.md" })
    // 4 commits examined; each resolved once (the parent resolution is reused
    // when that commit becomes current).
    expect(calls.resolveFileOid).toBe(4)
  })
})

describe("readNoteVersion", () => {
  it("returns blob content and caches by oid", async () => {
    const { api, calls } = createFixtureApi({
      head: "c1",
      commits: [{ sha: "c1", timestamp: 10, files: { "note.md": "b1" } }],
      blobs: { b1: "# Hello\n" },
    })
    const { readNoteVersion } = createNoteHistory(api)

    expect(await readNoteVersion({ oid: "b1" })).toBe("# Hello\n")
    expect(await readNoteVersion({ oid: "b1" })).toBe("# Hello\n")
    expect(calls.readBlobText).toBe(1)
  })
})

describe("diffLineCounts", () => {
  it("reports 0/0 for identical content", () => {
    expect(diffLineCounts("a\nb\nc", "a\nb\nc")).toEqual({
      added: 0,
      removed: 0,
      approximate: false,
    })
  })

  it("counts pure additions", () => {
    expect(diffLineCounts("a\nb", "a\nb\nc\nd")).toEqual({
      added: 2,
      removed: 0,
      approximate: false,
    })
  })

  it("counts pure removals", () => {
    expect(diffLineCounts("a\nb\nc", "b")).toEqual({ added: 0, removed: 2, approximate: false })
  })

  it("counts a modified line as one added and one removed", () => {
    expect(diffLineCounts("a\nb\nc", "a\nX\nc")).toEqual({
      added: 1,
      removed: 1,
      approximate: false,
    })
  })

  it("treats creation from empty as all lines added", () => {
    expect(diffLineCounts("", "a\nb\nc")).toEqual({ added: 3, removed: 0, approximate: false })
  })

  it("treats deletion to empty as all lines removed", () => {
    expect(diffLineCounts("a\nb", "")).toEqual({ added: 0, removed: 2, approximate: false })
  })

  it("counts a swap of two adjacent lines as +1/−1", () => {
    expect(diffLineCounts("a\nb\nc\nd", "a\nc\nb\nd")).toEqual({
      added: 1,
      removed: 1,
      approximate: false,
    })
  })

  it("handles repeated lines exactly", () => {
    expect(diffLineCounts("x\nx\nx", "x\nx")).toEqual({ added: 0, removed: 1, approximate: false })
  })

  it("stays exact for a small edit in a very long note (prefix/suffix trimming)", () => {
    const lines = Array.from({ length: 5000 }, (_, i) => `line ${i}`)
    const before = lines.join("\n")
    const after = [...lines.slice(0, 2500), "inserted", ...lines.slice(2500)].join("\n")
    expect(diffLineCounts(before, after)).toEqual({ added: 1, removed: 0, approximate: false })
  })

  it("falls back to an approximate multiset count for enormous diffs", () => {
    const before = Array.from({ length: 1100 }, (_, i) => `a${i}`).join("\n")
    const after = Array.from({ length: 1100 }, (_, i) => `b${i}`).join("\n")
    expect(diffLineCounts(before, after)).toEqual({
      added: 1100,
      removed: 1100,
      approximate: true,
    })
  })

  it("labels the fallback approximate because it ignores line order", () => {
    const lines = Array.from({ length: 1100 }, (_, i) => `l${i}`)
    const before = lines.join("\n")
    const after = [...lines].reverse().concat("extra").join("\n")
    // A full reversal reads as unchanged in the multiset view — hence the flag.
    expect(diffLineCounts(before, after)).toEqual({ added: 1, removed: 0, approximate: true })
  })
})
