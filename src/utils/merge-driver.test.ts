import { describe, expect, it } from "vitest"
import {
  buildConflictCopy,
  commitTimestamp,
  conflictCopyNotice,
  createConflictRecordingMergeDriver,
  formatConflictTimestamp,
  matchConflictPath,
  mergeTextPreferring,
  newerSide,
} from "./merge-driver"
import { isValidNoteId } from "./note-id"

const BASE = "one\ntwo\nthree\nfour\nfive\n"

describe("newerSide", () => {
  it("prefers ours when the local tip is newer", () => {
    expect(newerSide(2000, 1000)).toBe("ours")
  })

  it("prefers theirs when the remote tip is newer", () => {
    expect(newerSide(1000, 2000)).toBe("theirs")
  })

  it("breaks ties toward ours", () => {
    expect(newerSide(1500, 1500)).toBe("ours")
  })
})

describe("commitTimestamp", () => {
  // Shaped like isomorphic-git's `git.log` entries.
  it("reads the committer timestamp", () => {
    const entry = { commit: { committer: { timestamp: 123 }, author: { timestamp: 456 } } }
    expect(commitTimestamp(entry)).toBe(123)
  })

  it("falls back to the author timestamp", () => {
    expect(commitTimestamp({ commit: { author: { timestamp: 456 } } })).toBe(456)
  })

  it("returns 0 for a missing entry", () => {
    expect(commitTimestamp(undefined)).toBe(0)
    expect(commitTimestamp({})).toBe(0)
  })
})

describe("mergeTextPreferring", () => {
  it("keeps clean merges clean: non-overlapping edits from both sides both survive", () => {
    const ours = "ONE\ntwo\nthree\nfour\nfive\n" // edited line 1
    const theirs = "one\ntwo\nthree\nfour\nFIVE\n" // edited line 5
    for (const prefer of ["ours", "theirs"] as const) {
      const result = mergeTextPreferring(BASE, ours, theirs, prefer)
      expect(result.hadConflict).toBe(false)
      expect(result.mergedText).toBe("ONE\ntwo\nthree\nfour\nFIVE\n")
    }
  })

  it("takes ours for each conflicting hunk when ours is preferred", () => {
    const ours = "one\nOURS\nthree\nfour\nfive\n"
    const theirs = "one\nTHEIRS\nthree\nfour\nfive\n"
    const result = mergeTextPreferring(BASE, ours, theirs, "ours")
    expect(result.hadConflict).toBe(true)
    expect(result.mergedText).toBe("one\nOURS\nthree\nfour\nfive\n")
    expect(result.mergedText).not.toContain("<<<<<<<")
  })

  it("takes theirs for each conflicting hunk when theirs is preferred", () => {
    const ours = "one\nOURS\nthree\nfour\nfive\n"
    const theirs = "one\nTHEIRS\nthree\nfour\nfive\n"
    const result = mergeTextPreferring(BASE, ours, theirs, "theirs")
    expect(result.hadConflict).toBe(true)
    expect(result.mergedText).toBe("one\nTHEIRS\nthree\nfour\nfive\n")
    expect(result.mergedText).not.toContain("<<<<<<<")
  })

  it("mixes clean hunks and conflicting hunks: clean parts from both sides survive", () => {
    const ours = "one\nOURS\nthree\nfour\nfive\n"
    const theirs = "one\nTHEIRS\nthree\nfour\nFIVE\n"
    const oursWins = mergeTextPreferring(BASE, ours, theirs, "ours")
    expect(oursWins.hadConflict).toBe(true)
    // Conflicting hunk (line 2) takes ours; their clean edit (line 5) survives.
    expect(oursWins.mergedText).toBe("one\nOURS\nthree\nfour\nFIVE\n")

    const theirsWins = mergeTextPreferring(BASE, ours, theirs, "theirs")
    expect(theirsWins.hadConflict).toBe(true)
    expect(theirsWins.mergedText).toBe("one\nTHEIRS\nthree\nfour\nFIVE\n")
  })

  it("is a no-op when neither side changed", () => {
    const result = mergeTextPreferring(BASE, BASE, BASE, "ours")
    expect(result.hadConflict).toBe(false)
    expect(result.mergedText).toBe(BASE)
  })

  it("handles empty base (both sides created content)", () => {
    expect(mergeTextPreferring("", "ours\n", "theirs\n", "ours")).toEqual({
      hadConflict: true,
      mergedText: "ours\n",
    })
    expect(mergeTextPreferring("", "ours\n", "theirs\n", "theirs")).toEqual({
      hadConflict: true,
      mergedText: "theirs\n",
    })
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

  it("merges non-note files ours-wins and always clean, regardless of preference", () => {
    for (const prefer of ["ours", "theirs"] as const) {
      const driver = createConflictRecordingMergeDriver(prefer)
      const result = call(driver, "foo.json", `["blk_base"]`, `["blk_ours"]`, `["blk_theirs"]`)
      expect(result).toEqual({ cleanMerge: true, mergedText: `["blk_ours"]` })
      expect(driver.conflicts).toEqual([])

      const binary = call(driver, "image.png", "\x89PNG-base", "\x89PNG-ours", "\x89PNG-theirs")
      expect(binary).toEqual({ cleanMerge: true, mergedText: "\x89PNG-ours" })
      expect(driver.conflicts).toEqual([])
    }
  })

  it("preferring ours: keeps ours in place and records theirs as the preserved side", () => {
    const driver = createConflictRecordingMergeDriver("ours")
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
        preservedSide: "theirs",
        preserved: "one\nTHEIRS\nthree\nfour\nfive\n",
        merged: "one\nOURS\nthree\nfour\nfive\n",
      },
    ])
  })

  it("preferring theirs: keeps theirs in place and records ours as the preserved side", () => {
    const driver = createConflictRecordingMergeDriver("theirs")
    const result = call(
      driver,
      "foo.md",
      BASE,
      "one\nOURS\nthree\nfour\nfive\n",
      "one\nTHEIRS\nthree\nfour\nfive\n",
    )
    expect(result.cleanMerge).toBe(true)
    expect(result.mergedText).toBe("one\nTHEIRS\nthree\nfour\nfive\n")
    expect(driver.conflicts).toEqual([
      {
        basename: "foo.md",
        preservedSide: "ours",
        preserved: "one\nOURS\nthree\nfour\nfive\n",
        merged: "one\nTHEIRS\nthree\nfour\nfive\n",
      },
    ])
  })

  it("does not record notes that merged without conflicting hunks", () => {
    for (const prefer of ["ours", "theirs"] as const) {
      const driver = createConflictRecordingMergeDriver(prefer)
      const result = call(
        driver,
        "foo.md",
        BASE,
        "ONE\ntwo\nthree\nfour\nfive\n",
        "one\ntwo\nthree\nfour\nFIVE\n",
      )
      expect(result.cleanMerge).toBe(true)
      expect(result.mergedText).toBe("ONE\ntwo\nthree\nfour\nFIVE\n")
      expect(driver.conflicts).toEqual([])
    }
  })

  it("defaults to preferring ours", () => {
    const driver = createConflictRecordingMergeDriver()
    const result = call(driver, "foo.md", BASE, "one\nOURS\n", "one\nTHEIRS\n")
    expect(result.mergedText).toContain("OURS")
    expect(driver.conflicts[0].preservedSide).toBe("theirs")
  })
})

describe("matchConflictPath", () => {
  const conflict = {
    basename: "foo.md",
    preservedSide: "theirs" as const,
    preserved: "theirs\n",
    merged: "merged\n",
  }

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

describe("conflictCopyNotice", () => {
  it("says the copy holds this device's version when ours lost", () => {
    const notice = conflictCopyNotice("foo", "ours")
    expect(notice).toContain("[[foo]]")
    expect(notice).toContain("this device's copy")
    expect(notice).toContain("nothing was lost")
  })

  it("says the copy holds the other device's version when theirs lost", () => {
    const notice = conflictCopyNotice("foo", "theirs")
    expect(notice).toContain("[[foo]]")
    expect(notice).toContain("other device's copy")
    expect(notice).toContain("nothing was lost")
  })
})

describe("buildConflictCopy", () => {
  const date = new Date(2026, 7, 27, 14, 5)
  const notice = conflictCopyNotice("foo", "theirs")

  it("builds a valid, readable note id", () => {
    const copy = buildConflictCopy(
      "work/projects",
      "remote content\n",
      date,
      conflictCopyNotice("work/projects", "theirs"),
    )
    expect(copy.id).toBe("work/projects-conflict-20260827-1405")
    expect(isValidNoteId(copy.id)).toBe(true)
  })

  it("prefixes the notice line and preserves the full losing content", () => {
    const copy = buildConflictCopy("foo", "remote line 1\nremote line 2\n", date, notice)
    const [firstLine] = copy.content.split("\n")
    expect(firstLine).toContain("Older version of [[foo]]")
    expect(firstLine).toContain("sync merge")
    expect(copy.content).toContain("remote line 1\nremote line 2\n")
  })

  it("keeps frontmatter at the top so the copy's metadata still parses", () => {
    const remote = "---\npinned: true\n---\nremote body\n"
    const copy = buildConflictCopy("foo", remote, date, notice)
    expect(copy.content.startsWith("---\npinned: true\n---\n")).toBe(true)
    expect(copy.content).toContain("Older version of [[foo]]")
    expect(copy.content).toContain("remote body\n")
  })
})
