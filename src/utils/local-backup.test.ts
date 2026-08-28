// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// lightning-fs needs indexedDB (absent in jsdom); these tests only exercise
// the pure diff/stash/restore helpers, so the fs/git integration is stubbed.
vi.mock("./fs", () => ({ fs: {} }))
vi.mock("./git", () => ({ REPO_DIR: "/repo", gitAdd: vi.fn(), gitCommit: vi.fn() }))

import {
  MAX_BACKUP_BYTES,
  buildBackupRestoreWrites,
  clearUnpushedBackup,
  collectBackupFiles,
  peekUnpushedBackup,
  stashUnpushedBackup,
} from "./local-backup"

beforeEach(() => window.localStorage.clear())
afterEach(() => {
  vi.restoreAllMocks()
  window.localStorage.clear()
})

describe("collectBackupFiles (ahead-detection diff)", () => {
  it("picks notes that differ from the remote tree", () => {
    const local = {
      "same.md": "unchanged",
      "modified.md": "local version",
      "new-note.md": "only exists locally",
    }
    const remote = {
      "same.md": "unchanged",
      "modified.md": "remote version",
    }
    expect(collectBackupFiles(local, remote)).toEqual({
      "modified.md": "local version",
      "new-note.md": "only exists locally",
    })
  })

  it("ignores non-note files (view-state sidecars etc.)", () => {
    const local = {
      ".ruminate/view-state/foo.json": '{"collapsed":["a"]}',
      "note.md": "changed",
    }
    expect(collectBackupFiles(local, {})).toEqual({ "note.md": "changed" })
  })

  it("returns nothing when local matches remote", () => {
    const files = { "a.md": "x", "b.md": "y" }
    expect(collectBackupFiles(files, { ...files })).toEqual({})
  })
})

describe("stashUnpushedBackup / peekUnpushedBackup", () => {
  it("round-trips a backup through localStorage", () => {
    expect(stashUnpushedBackup({ "a.md": "content a" }, 123)).toBe(true)
    const backup = peekUnpushedBackup()
    expect(backup).toEqual({ createdAt: 123, files: { "a.md": "content a" } })
    clearUnpushedBackup()
    expect(peekUnpushedBackup()).toBeNull()
  })

  it("skips the backup entirely when there is nothing to stash", () => {
    expect(stashUnpushedBackup({})).toBe(false)
    expect(peekUnpushedBackup()).toBeNull()
  })

  it("bounds the payload, keeping the smallest notes first", () => {
    const big = "x".repeat(MAX_BACKUP_BYTES) // alone exceeds the budget
    expect(stashUnpushedBackup({ "big.md": big, "small.md": "tiny" }, 1)).toBe(true)
    expect(peekUnpushedBackup()).toEqual({ createdAt: 1, files: { "small.md": "tiny" } })
  })

  it("degrades to no backup when localStorage is full (never throws)", () => {
    vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new DOMException("quota", "QuotaExceededError")
    })
    expect(stashUnpushedBackup({ "a.md": "content" })).toBe(false)
    vi.restoreAllMocks()
    expect(peekUnpushedBackup()).toBeNull()
  })

  it("ignores a malformed stash", () => {
    window.localStorage.setItem("ruminate_unpushed_backup", "not json")
    expect(peekUnpushedBackup()).toBeNull()
    window.localStorage.setItem("ruminate_unpushed_backup", JSON.stringify({ files: {} }))
    expect(peekUnpushedBackup()).toBeNull()
  })
})

describe("buildBackupRestoreWrites", () => {
  it("restores stashed notes as conflicted-copy notes", () => {
    const date = new Date(2026, 7, 27, 14, 30) // 2026-08-27 14:30 local
    const writes = buildBackupRestoreWrites(
      { "notes/foo.md": "local content", "bar.md": "other content" },
      date,
    )
    expect(Object.keys(writes).sort()).toEqual([
      "bar-conflict-20260827-1430.md",
      "notes/foo-conflict-20260827-1430.md",
    ])
    // The full local content survives, prefixed with the reset notice.
    expect(writes["notes/foo-conflict-20260827-1430.md"]).toContain("local content")
    expect(writes["notes/foo-conflict-20260827-1430.md"]).toContain("[[notes/foo]]")
    expect(writes["notes/foo-conflict-20260827-1430.md"]).toMatch(/before this browser's notes/)
  })

  it("keeps frontmatter at the top of restored copies", () => {
    const content = "---\npinned: true\n---\nbody text"
    const writes = buildBackupRestoreWrites({ "a.md": content }, new Date(2026, 0, 1, 0, 0))
    const restored = writes["a-conflict-20260101-0000.md"]
    expect(restored.startsWith("---\npinned: true\n---\n")).toBe(true)
    expect(restored).toContain("body text")
  })
})
