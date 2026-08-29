import { describe, expect, it } from "vitest"
import type { NoteStore } from "./note-store"

/**
 * The `NoteStore` contract, as an executable specification.
 *
 * Every implementation must pass this suite unchanged. Run it from a spec
 * file with a factory that returns a fresh, empty store per test:
 *
 *   describeNoteStoreConformance("sql-backed store", () => makeStore())
 */
export function describeNoteStoreConformance(
  name: string,
  makeStore: () => NoteStore | Promise<NoteStore>,
) {
  describe(`NoteStore conformance: ${name}`, () => {
    it("reads back a written note by id", async () => {
      const store = await makeStore()
      await store.writeNotes({ "1234": "# Hello\n" })
      expect(await store.getNote("1234")).toBe("# Hello\n")
    })

    it("returns null for a note that does not exist", async () => {
      const store = await makeStore()
      expect(await store.getNote("missing")).toBeNull()
    })

    it("overwrites an existing note", async () => {
      const store = await makeStore()
      await store.writeNotes({ a: "first\n" })
      await store.writeNotes({ a: "second\n" })
      expect(await store.getNote("a")).toBe("second\n")
    })

    it("writes a batch of notes in one call", async () => {
      const store = await makeStore()
      await store.writeNotes({ a: "A\n", b: "B\n" })
      expect(await store.getAllNotes()).toEqual({ a: "A\n", b: "B\n" })
    })

    it("deletes a note via a null value in writeNotes", async () => {
      const store = await makeStore()
      await store.writeNotes({ a: "A\n", b: "B\n" })
      await store.writeNotes({ a: null })
      expect(await store.getNote("a")).toBeNull()
      expect(await store.getAllNotes()).toEqual({ b: "B\n" })
    })

    it("deletes a note via deleteNote", async () => {
      const store = await makeStore()
      await store.writeNotes({ a: "A\n" })
      await store.deleteNote("a")
      expect(await store.getNote("a")).toBeNull()
      expect(await store.getAllNotes()).toEqual({})
    })

    it("is keyed by note id, not display name or path", async () => {
      const store = await makeStore()
      // Ids that look like dates, weeks, and nested-ish names must all work.
      await store.writeNotes({
        "2026-01-01": "daily\n",
        "2026-W01": "weekly\n",
        "project-notes": "# Project\n",
      })
      expect(await store.getNote("2026-01-01")).toBe("daily\n")
      expect(await store.getNote("2026-W01")).toBe("weekly\n")
      expect(await store.getNote("project-notes")).toBe("# Project\n")
    })

    it("keeps view-state out of the note namespace", async () => {
      const store = await makeStore()
      await store.writeNotes({ a: "A\n" })
      await store.setViewState("a", ["blk_1111111111"])
      // Persisting view state must never surface extra "notes".
      expect(Object.keys(await store.getAllNotes())).toEqual(["a"])
    })

    it("round-trips view state per note", async () => {
      const store = await makeStore()
      await store.setViewState("a", ["blk_bbbbbbbbbb", "blk_aaaaaaaaaa"])
      await store.setViewState("b", ["blk_cccccccccc"])
      // Canonical order (sorted) and per-note isolation.
      expect(await store.getViewState("a")).toEqual(["blk_aaaaaaaaaa", "blk_bbbbbbbbbb"])
      expect(await store.getViewState("b")).toEqual(["blk_cccccccccc"])
    })

    it("de-duplicates collapsed ids", async () => {
      const store = await makeStore()
      await store.setViewState("a", ["blk_aaaaaaaaaa", "blk_aaaaaaaaaa"])
      expect(await store.getViewState("a")).toEqual(["blk_aaaaaaaaaa"])
    })

    it("returns empty view state for an unknown note", async () => {
      const store = await makeStore()
      expect(await store.getViewState("missing")).toEqual([])
    })

    it("clears view state when set to empty", async () => {
      const store = await makeStore()
      await store.setViewState("a", ["blk_aaaaaaaaaa"])
      await store.setViewState("a", [])
      expect(await store.getViewState("a")).toEqual([])
    })
  })
}
