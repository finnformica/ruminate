// @vitest-environment jsdom
import { beforeEach, describe, expect, test } from "vitest"
import type { Note } from "../schema"
import {
  RECENT_HALF_LIFE_MS,
  RECENT_KEEP,
  RECENT_LIMIT,
  RECENT_STORAGE_KEY,
  TOUCH_COALESCE_MS,
  VISIT_WINDOW_MS,
  loadRecentVisits,
  rankRecents,
  saveRecentVisits,
  touchRecent,
  type RecentVisit,
} from "./recents"

const note = (id: string, updatedAt: number | null = null): Note =>
  ({
    id,
    type: "note",
    displayName: id,
    props: {},
    title: id,
    pinned: false,
    updatedAt,
    dates: [],
    tasks: [],
    headings: [],
    text: "",
  }) as unknown as Note

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const noBlocks = () => false
const ids = (destinations: { id: string }[]) => destinations.map((d) => d.id)

/** The visits after touching each `[id, noteId, at]` in turn. */
function visit(...touches: [string, string, number][]): readonly RecentVisit[] {
  return touches.reduce<readonly RecentVisit[]>(
    (visits, [id, noteId, at]) => touchRecent(visits, { id, noteId }, at),
    [],
  )
}

describe("touchRecent", () => {
  test("a first touch is one visit, to the destination it names", () => {
    expect(visit(["fashion", "personal", 1000])).toEqual([
      { id: "fashion", noteId: "personal", at: 1000, score: 1 },
    ])
  })

  test("touches within the visit window are the same visit; after it, another", () => {
    const once = visit(["a", "a", 0], ["a", "a", HOUR / 4], ["a", "a", HOUR / 3])
    expect(once[0].score).toBeCloseTo(1, 2)
    expect(once[0].at).toBe(HOUR / 3)
    const twice = touchRecent(once, { id: "a", noteId: "a" }, HOUR / 3 + VISIT_WINDOW_MS)
    expect(twice[0].score).toBeCloseTo(2, 2)
  })

  test("a score halves every half-life before the next visit adds to it", () => {
    const visits = visit(["a", "a", 0], ["a", "a", RECENT_HALF_LIFE_MS])
    expect(visits[0].score).toBeCloseTo(1.5, 6)
  })

  test("a destination is written at most once a second", () => {
    const first = visit(["a", "a", 1000])
    // The same list back: nothing to write.
    expect(touchRecent(first, { id: "a", noteId: "a" }, 1000 + TOUCH_COALESCE_MS - 1)).toBe(first)
    const later = touchRecent(first, { id: "a", noteId: "a" }, 1000 + TOUCH_COALESCE_MS)
    expect(later).not.toBe(first)
    expect(later[0].at).toBe(1000 + TOUCH_COALESCE_MS)
  })

  test("keeps at most RECENT_KEEP destinations, dropping the lowest scores", () => {
    // `often` is visited three times, a day apart, at the start; then more
    // than RECENT_KEEP one-off visits follow within the hour.
    let visits = visit(["often", "often", 0], ["often", "often", DAY], ["often", "often", 2 * DAY])
    for (let i = 0; i <= RECENT_KEEP; i++) {
      visits = touchRecent(visits, { id: `n${i}`, noteId: `n${i}` }, 2 * DAY + i * 1000)
    }
    expect(visits).toHaveLength(RECENT_KEEP)
    expect(visits.some((v) => v.id === "often")).toBe(true)
    // The oldest one-off went.
    expect(visits.some((v) => v.id === "n0")).toBe(false)
  })
})

describe("rankRecents", () => {
  test("ranks by frecency: a place come back to outranks one visited once, more lately", () => {
    const notes = [note("personal"), note("ruminate"), note("once")]
    const visits = visit(
      ["fashion", "personal", 0],
      ["fashion", "personal", DAY],
      ["fashion", "personal", 2 * DAY],
      ["once", "once", 3 * DAY],
    )
    const has = (id: string) => id === "fashion"
    expect(rankRecents(visits, notes, has, 3 * DAY + HOUR)).toEqual([
      { id: "fashion", noteId: "personal" },
      { id: "once", noteId: "once" },
    ])
  })

  test("a tie goes to the latest", () => {
    const notes = [note("a"), note("b")]
    const visits = visit(["a", "a", 0], ["b", "b", 0])
    expect(ids(rankRecents(visits, notes, noBlocks, HOUR))).toEqual(["b", "a"])
  })

  test("an edit made elsewhere counts as a visit to its note; one made here does not twice", () => {
    const now = 10 * DAY
    const notes = [
      note("elsewhere", now - HOUR), // edited on another device, never opened here
      note("here", now - 2 * DAY + 1000), // edited just after this device touched it
      note("never"),
    ]
    const visits = visit(["here", "here", now - 2 * DAY])
    const ranked = rankRecents(visits, notes, noBlocks, now)
    expect(ids(ranked)).toEqual(["elsewhere", "here"])
    const here = rankRecents(visits, [notes[1]], noBlocks, now)
    expect(here).toEqual([{ id: "here", noteId: "here" }])
  })

  test("an edit elsewhere after the last visit here adds to that note's score", () => {
    const now = 10 * DAY
    const visits = visit(["a", "a", now - 3 * DAY], ["b", "b", now - 3 * DAY])
    const notes = [note("a", now - DAY), note("b")]
    expect(ids(rankRecents(visits, notes, noBlocks, now))).toEqual(["a", "b"])
  })

  test("lists at most five, and skips a destination that is gone", () => {
    const notes = Array.from({ length: 8 }, (_, i) => note(`n${i}`, i * 100))
    const visits = visit(["deleted", "deleted", 99999], ["gone-block", "n1", 99999])
    const ranked = rankRecents(visits, notes, noBlocks, 100000)
    expect(ranked).toHaveLength(RECENT_LIMIT)
    expect(ids(ranked)).toEqual(["n7", "n6", "n5", "n4", "n3"])
  })
})

describe("storage round-trip", () => {
  beforeEach(() => localStorage.clear())

  test("saves under the one key and loads back what it saved", () => {
    const visits = visit(["a", "a", 1], ["blk", "b", 2])
    saveRecentVisits(localStorage, visits)
    expect(Object.keys(localStorage)).toEqual([RECENT_STORAGE_KEY])
    expect(loadRecentVisits(localStorage)).toEqual(visits)
    // Overwritten whole, never appended.
    saveRecentVisits(localStorage, visit(["c", "c", 3]))
    expect(ids(loadRecentVisits(localStorage))).toEqual(["c"])
    expect(Object.keys(localStorage)).toEqual([RECENT_STORAGE_KEY])
  })

  test("carries over the notes-only list an older build saved, then removes it", () => {
    localStorage.setItem(
      "recent-notes",
      JSON.stringify([
        { id: "a", at: 2 },
        { id: "b", at: 1 },
      ]),
    )
    const visits = loadRecentVisits(localStorage)
    expect(visits).toEqual([
      { id: "a", noteId: "a", at: 2, score: 1 },
      { id: "b", noteId: "b", at: 1, score: 1 },
    ])
    saveRecentVisits(localStorage, visits)
    expect(Object.keys(localStorage)).toEqual([RECENT_STORAGE_KEY])
  })

  test("reads nothing from a missing, malformed or over-long entry", () => {
    expect(loadRecentVisits(localStorage)).toEqual([])
    localStorage.setItem(RECENT_STORAGE_KEY, "not json")
    expect(loadRecentVisits(localStorage)).toEqual([])
    localStorage.setItem(RECENT_STORAGE_KEY, JSON.stringify({ id: "a" }))
    expect(loadRecentVisits(localStorage)).toEqual([])
    localStorage.setItem(RECENT_STORAGE_KEY, JSON.stringify([{ id: "a", at: 1 }]))
    expect(loadRecentVisits(localStorage)).toEqual([])
    localStorage.setItem(
      RECENT_STORAGE_KEY,
      JSON.stringify(
        Array.from({ length: RECENT_KEEP + 5 }, (_, i) => ({
          id: `n${i}`,
          noteId: `n${i}`,
          at: i,
          score: 1,
        })),
      ),
    )
    expect(loadRecentVisits(localStorage)).toHaveLength(RECENT_KEEP)
    expect(loadRecentVisits(null)).toEqual([])
  })
})
