// @vitest-environment jsdom
import { beforeEach, describe, expect, test } from "vitest"
import type { Note } from "../schema"
import {
  RECENT_LIMIT,
  RECENT_STORAGE_KEY,
  TOUCH_COALESCE_MS,
  loadRecentTouches,
  recentNotes,
  saveRecentTouches,
  touchRecent,
} from "./recent-notes"

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

describe("touchRecent", () => {
  test("a touch moves the note to the front, once; the list is capped at five", () => {
    let touches = touchRecent([], "a", 1000)
    for (const [id, at] of [
      ["b", 2000],
      ["c", 3000],
      ["a", 4000],
      ["d", 5000],
      ["e", 6000],
      ["f", 7000],
    ] as const) {
      touches = touchRecent(touches, id, at)
    }
    expect(touches).toHaveLength(RECENT_LIMIT)
    expect(touches.map((touch) => touch.id)).toEqual(["f", "e", "d", "a", "c"])
    // `a` is there once, at its latest touch; `b` fell off the end.
    expect(touches.find((touch) => touch.id === "a")?.at).toBe(4000)
  })

  test("a note already at the top is bumped at most once a second", () => {
    const first = touchRecent([], "a", 1000)
    // The same list back: nothing to write.
    expect(touchRecent(first, "a", 1000 + TOUCH_COALESCE_MS - 1)).toBe(first)
    const later = touchRecent(first, "a", 1000 + TOUCH_COALESCE_MS)
    expect(later).not.toBe(first)
    expect(later[0].at).toBe(1000 + TOUCH_COALESCE_MS)
  })
})

describe("recentNotes", () => {
  test("merges touches with the graph's updatedAt, most recent first, each note once", () => {
    const notes = [note("edited", 5000), note("old", 1000), note("never"), note("opened", 2000)]
    const touches = [
      { id: "opened", at: 6000 },
      { id: "old", at: 500 }, // touched before its last edit: the edit wins
    ]
    expect(recentNotes(touches, notes).map((n) => n.id)).toEqual(["opened", "edited", "old"])
  })

  test("lists at most five, and skips a touch of a note that is gone", () => {
    const notes = Array.from({ length: 8 }, (_, i) => note(`n${i}`, i * 100))
    const touches = [{ id: "deleted", at: 99999 }]
    expect(recentNotes(touches, notes).map((n) => n.id)).toEqual(["n7", "n6", "n5", "n4", "n3"])
  })
})

describe("storage round-trip", () => {
  beforeEach(() => localStorage.clear())

  test("saves under the one key and loads back what it saved", () => {
    const touches = [
      { id: "a", at: 2 },
      { id: "b", at: 1 },
    ]
    saveRecentTouches(localStorage, touches)
    expect(Object.keys(localStorage)).toEqual([RECENT_STORAGE_KEY])
    expect(loadRecentTouches(localStorage)).toEqual(touches)
    // Overwritten whole, never appended.
    saveRecentTouches(localStorage, [{ id: "c", at: 3 }])
    expect(loadRecentTouches(localStorage)).toEqual([{ id: "c", at: 3 }])
    expect(Object.keys(localStorage)).toEqual([RECENT_STORAGE_KEY])
  })

  test("reads nothing from a missing, malformed or over-long entry", () => {
    expect(loadRecentTouches(localStorage)).toEqual([])
    localStorage.setItem(RECENT_STORAGE_KEY, "not json")
    expect(loadRecentTouches(localStorage)).toEqual([])
    localStorage.setItem(RECENT_STORAGE_KEY, JSON.stringify({ id: "a" }))
    expect(loadRecentTouches(localStorage)).toEqual([])
    localStorage.setItem(
      RECENT_STORAGE_KEY,
      JSON.stringify(Array.from({ length: 9 }, (_, i) => ({ id: `n${i}`, at: i }))),
    )
    expect(loadRecentTouches(localStorage)).toHaveLength(RECENT_LIMIT)
    expect(loadRecentTouches(null)).toEqual([])
  })
})
