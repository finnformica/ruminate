import { describe, expect, it, vi } from "vitest"

// lightning-fs opens indexedDB (absent in node) as soon as it's constructed;
// these tests only exercise the pure notice-resolution logic (deps injected),
// so the browser filesystem is stubbed out.
vi.mock("./fs", () => ({ fs: {}, fsWipe: vi.fn() }))

import { MergeNoticeDeps, mergeNoticeKey, resolveMergeNotices } from "./git"
import { RecordedConflict } from "./merge-driver"

const conflict = (basename: string, merged = "merged\n"): RecordedConflict => ({
  basename,
  preservedSide: "theirs",
  preserved: "losing content\n",
  merged,
})

function fakeDeps(overrides: Partial<MergeNoticeDeps> = {}): MergeNoticeDeps {
  return {
    listNotePaths: vi.fn().mockResolvedValue(["notes/foo.md", "bar.md"]),
    readNote: vi.fn().mockResolvedValue(""),
    fileOidAt: vi.fn().mockResolvedValue("blob-losing"),
    ...overrides,
  }
}

describe("mergeNoticeKey", () => {
  it("keys a notice by note id and losing commit", () => {
    expect(mergeNoticeKey({ noteId: "notes/foo", losingSha: "abc123", losingOid: "def" })).toBe(
      "notes/foo@abc123",
    )
  })
})

describe("resolveMergeNotices", () => {
  it("returns no notices when there were no conflicts", async () => {
    const deps = fakeDeps()
    expect(await resolveMergeNotices([], "losing-sha", deps)).toEqual([])
    expect(deps.listNotePaths).not.toHaveBeenCalled()
  })

  it("returns no notices when the losing tip is unknown", async () => {
    expect(await resolveMergeNotices([conflict("foo.md")], null, fakeDeps())).toEqual([])
  })

  it("resolves the losing version's identity (sha + blob oid) without writing anything", async () => {
    // No write/commit dependency even exists here — a merge notice only points
    // at the losing version already reachable through the merge commit; no
    // conflicted-copy note is created.
    const deps = fakeDeps()
    const notices = await resolveMergeNotices([conflict("foo.md")], "losing-sha", deps)

    expect(notices).toEqual([
      { noteId: "notes/foo", losingSha: "losing-sha", losingOid: "blob-losing" },
    ])
    // The blob oid is looked up in the LOSING commit's tree, at the note's
    // full repo path.
    expect(deps.fileOidAt).toHaveBeenCalledWith("losing-sha", "notes/foo.md")
    // A unique basename needs no content read to disambiguate.
    expect(deps.readNote).not.toHaveBeenCalled()
  })

  it("disambiguates duplicate basenames by the merged content on disk", async () => {
    const contents: Record<string, string> = {
      "work/foo.md": "other\n",
      "personal/foo.md": "merged\n",
    }
    const deps = fakeDeps({
      listNotePaths: vi.fn().mockResolvedValue(["work/foo.md", "personal/foo.md"]),
      readNote: vi.fn().mockImplementation((path: string) => Promise.resolve(contents[path])),
    })

    const notices = await resolveMergeNotices([conflict("foo.md")], "losing-sha", deps)
    expect(notices).toEqual([
      { noteId: "personal/foo", losingSha: "losing-sha", losingOid: "blob-losing" },
    ])
  })

  it("skips conflicts whose basename matches no note", async () => {
    const notices = await resolveMergeNotices([conflict("missing.md")], "losing-sha", fakeDeps())
    expect(notices).toEqual([])
  })

  it("records a null oid when the note is absent from the losing commit's tree", async () => {
    const deps = fakeDeps({ fileOidAt: vi.fn().mockResolvedValue(null) })
    const notices = await resolveMergeNotices([conflict("foo.md")], "losing-sha", deps)
    expect(notices).toEqual([{ noteId: "notes/foo", losingSha: "losing-sha", losingOid: null }])
  })

  it("resolves one notice per conflicted note", async () => {
    const deps = fakeDeps({
      fileOidAt: vi
        .fn()
        .mockImplementation((_sha: string, filepath: string) =>
          Promise.resolve(`blob-${filepath}`),
        ),
    })
    const notices = await resolveMergeNotices(
      [conflict("foo.md"), conflict("bar.md")],
      "losing-sha",
      deps,
    )
    expect(notices).toEqual([
      { noteId: "notes/foo", losingSha: "losing-sha", losingOid: "blob-notes/foo.md" },
      { noteId: "bar", losingSha: "losing-sha", losingOid: "blob-bar.md" },
    ])
  })
})
