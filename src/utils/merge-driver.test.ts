import { describe, expect, it } from "vitest"
import {
  buildConflictCopy,
  createConflictRecordingMergeDriver,
  formatConflictTimestamp,
  matchConflictPath,
  mergeTextOursWins,
} from "./merge-driver"
import { isValidNoteId } from "./note-id"

const BASE = "one\ntwo\nthree\nfour\nfive\n"

describe("mergeTextOursWins", () => {
  it("keeps clean merges clean: non-overlapping edits from both sides both survive", () => {
    const ours = "ONE\ntwo\nthree\nfour\nfive\n" // edited line 1
    const theirs = "one\ntwo\nthree\nfour\nFIVE\n" // edited line 5
    const result = mergeTextOursWins(BASE, ours, theirs)
    expect(result.hadConflict).toBe(false)
    expect(result.mergedText).toBe("ONE\ntwo\nthree\nfour\nFIVE\n")
  })

  it("takes ours for each conflicting hunk and flags the conflict", () => {
    const ours = "one\nOURS\nthree\nfour\nfive\n"
    const theirs = "one\nTHEIRS\nthree\nfour\nfive\n"
    const result = mergeTextOursWins(BASE, ours, theirs)
    expect(result.hadConflict).toBe(true)
    expect(result.mergedText).toBe("one\nOURS\nthree\nfour\nfive\n")
    expect(result.mergedText).not.toContain("<<<<<<<")
  })

  it("mixes clean hunks and conflicting hunks: clean parts from both sides survive", () => {
    const ours = "one\nOURS\nthree\nfour\nfive\n"
    const theirs = "one\nTHEIRS\nthree\nfour\nFIVE\n"
    const result = mergeTextOursWins(BASE, ours, theirs)
    expect(result.hadConflict).toBe(true)
    // Conflicting hunk (line 2) takes ours; their clean edit (line 5) survives.
    expect(result.mergedText).toBe("one\nOURS\nthree\nfour\nFIVE\n")
  })

  it("is a no-op when neither side changed", () => {
    const result = mergeTextOursWins(BASE, BASE, BASE)
    expect(result.hadConflict).toBe(false)
    expect(result.mergedText).toBe(BASE)
  })

  it("handles empty base (both sides created content)", () => {
    const result = mergeTextOursWins("", "ours\n", "theirs\n")
    expect(result.hadConflict).toBe(true)
    expect(result.mergedText).toBe("ours\n")
  })
})

describe("createConflictRecordingMergeDriver", () => {
  // isomorphic-git calls the driver with contents [base, ours, theirs] and the
  // file's *basename* as `path`.
  const call = (
    driver: ReturnType<typeof createConflictRecordingMergeDriver>,
    path: string,
    base: string,
    ours: string,
    theirs: string,
  ) =>
    driver.mergeDriver({
      branches: ["base", "main", "origin/main"],
      contents: [base, ours, theirs],
      path,
    }) as { cleanMerge: boolean; mergedText: string }

  it("merges non-note files ours-wins and always clean (view-state sidecars, binary/unknown)", () => {
    const driver = createConflictRecordingMergeDriver()
    const result = call(driver, "foo.json", `["blk_base"]`, `["blk_ours"]`, `["blk_theirs"]`)
    expect(result).toEqual({ cleanMerge: true, mergedText: `["blk_ours"]` })
    expect(driver.conflicts).toEqual([])

    const binary = call(driver, "image.png", "\x89PNG-base", "\x89PNG-ours", "\x89PNG-theirs")
    expect(binary).toEqual({ cleanMerge: true, mergedText: "\x89PNG-ours" })
    expect(driver.conflicts).toEqual([])
  })

  it("reports notes as cleanly merged (never aborts the pull) and records real conflicts", () => {
    const driver = createConflictRecordingMergeDriver()
    const result = call(
      driver,
      "foo.md",
      BASE,
      "one\nOURS\nthree\nfour\nfive\n",
      "one\nTHEIRS\nthree\nfour\nfive\n",
    )
    expect(result.cleanMerge).toBe(true)
    expect(result.mergedText).toBe("one\nOURS\nthree\nfour\nfive\n")
    expect(driver.conflicts).toEqual([
      {
        basename: "foo.md",
        theirs: "one\nTHEIRS\nthree\nfour\nfive\n",
        merged: "one\nOURS\nthree\nfour\nfive\n",
      },
    ])
  })

  it("does not record notes that merged without conflicting hunks", () => {
    const driver = createConflictRecordingMergeDriver()
    const result = call(
      driver,
      "foo.md",
      BASE,
      "ONE\ntwo\nthree\nfour\nfive\n",
      "one\ntwo\nthree\nfour\nFIVE\n",
    )
    expect(result.cleanMerge).toBe(true)
    expect(driver.conflicts).toEqual([])
  })
})

describe("matchConflictPath", () => {
  const conflict = { basename: "foo.md", theirs: "theirs\n", merged: "merged\n" }

  it("matches a unique basename", () => {
    expect(matchConflictPath(conflict, ["a.md", "notes/foo.md"], () => undefined)).toBe(
      "notes/foo.md",
    )
  })

  it("disambiguates duplicate basenames by merged content", () => {
    const contents: Record<string, string> = {
      "work/foo.md": "other\n",
      "personal/foo.md": "merged\n",
    }
    expect(
      matchConflictPath(conflict, ["work/foo.md", "personal/foo.md"], (p) => contents[p]),
    ).toBe("personal/foo.md")
  })

  it("returns null when nothing matches", () => {
    expect(matchConflictPath(conflict, ["bar.md"], () => undefined)).toBeNull()
  })
})

describe("formatConflictTimestamp", () => {
  it("formats as yyyymmdd-hhmm", () => {
    expect(formatConflictTimestamp(new Date(2026, 7, 27, 14, 5))).toBe("20260827-1405")
  })
})

describe("buildConflictCopy", () => {
  const date = new Date(2026, 7, 27, 14, 5)

  it("builds a valid, readable note id", () => {
    const copy = buildConflictCopy("work/projects", "remote content\n", date)
    expect(copy.id).toBe("work/projects-conflict-20260827-1405")
    expect(isValidNoteId(copy.id)).toBe(true)
  })

  it("prefixes a notice line and preserves the full remote content", () => {
    const copy = buildConflictCopy("foo", "remote line 1\nremote line 2\n", date)
    const [firstLine] = copy.content.split("\n")
    expect(firstLine).toContain("Remote copy of [[foo]]")
    expect(firstLine).toContain("sync conflict")
    expect(copy.content).toContain("remote line 1\nremote line 2\n")
  })

  it("keeps frontmatter at the top so the copy's metadata still parses", () => {
    const remote = "---\npinned: true\n---\nremote body\n"
    const copy = buildConflictCopy("foo", remote, date)
    expect(copy.content.startsWith("---\npinned: true\n---\n")).toBe(true)
    expect(copy.content).toContain("Remote copy of [[foo]]")
    expect(copy.content).toContain("remote body\n")
  })
})
