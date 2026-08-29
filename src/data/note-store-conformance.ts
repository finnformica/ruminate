import { describe, expect, it } from "vitest"
import { parse } from "../blocks/parse"
import type { NoteStore } from "./note-store"

/**
 * The `NoteStore` contract, as an executable specification.
 *
 * Every implementation must pass this suite unchanged. Run it from a spec
 * file with a factory that returns a fresh, empty store per test:
 *
 *   describeNoteStoreConformance("sql-backed store", () => makeStore())
 *
 * Alongside the note read/write/delete round-trips, this pins the schema v2
 * graph semantics (docs/graph-schema-v2.md): containment queries, multi-parent
 * links, ordered insertion, cycle rejection at write, and delete-rescue.
 */
export function describeNoteStoreConformance(
  name: string,
  makeStore: () => NoteStore | Promise<NoteStore>,
) {
  describe(`NoteStore conformance: ${name}`, () => {
    it("reads back a written note by id", async () => {
      const store = await makeStore()
      await store.writeNotes({ "1234": "# Hello\n  id:: blk_aaaaaaaaaa\n" })
      expect(await store.getNote("1234")).toBe("# Hello\n  id:: blk_aaaaaaaaaa\n")
    })

    it("returns null for a note that does not exist", async () => {
      const store = await makeStore()
      expect(await store.getNote("missing")).toBeNull()
    })

    it("overwrites an existing note", async () => {
      const store = await makeStore()
      await store.writeNotes({ a: "first\n  id:: blk_aaaaaaaaaa\n" })
      await store.writeNotes({ a: "second\n  id:: blk_aaaaaaaaaa\n" })
      expect(await store.getNote("a")).toBe("second\n  id:: blk_aaaaaaaaaa\n")
    })

    it("writes a batch of notes in one call", async () => {
      const store = await makeStore()
      await store.writeNotes({ a: "A\n  id:: blk_aaaaaaaaaa\n", b: "B\n  id:: blk_bbbbbbbbbb\n" })
      expect(await store.getAllNotes()).toEqual({
        a: "A\n  id:: blk_aaaaaaaaaa\n",
        b: "B\n  id:: blk_bbbbbbbbbb\n",
      })
    })

    it("canonicalizes id-less markdown on write (ids are minted by ingest)", async () => {
      const store = await makeStore()
      await store.writeNotes({ a: "# Hello\n- World\n" })
      const stored = await store.getNote("a")
      expect(stored).not.toBeNull()
      const doc = parse(stored as string)
      expect(doc.rootBlockIds).toHaveLength(2)
      expect(stored).toContain("id:: ")
      expect(stored).toContain("# Hello")
      expect(stored).toContain("- World")
    })

    it("deletes a note via a null value in writeNotes", async () => {
      const store = await makeStore()
      await store.writeNotes({ a: "A\n  id:: blk_aaaaaaaaaa\n", b: "B\n  id:: blk_bbbbbbbbbb\n" })
      await store.writeNotes({ a: null })
      expect(await store.getNote("a")).toBeNull()
      expect(await store.getAllNotes()).toEqual({ b: "B\n  id:: blk_bbbbbbbbbb\n" })
    })

    it("deletes a note via deleteNote", async () => {
      const store = await makeStore()
      await store.writeNotes({ a: "A\n  id:: blk_aaaaaaaaaa\n" })
      await store.deleteNote("a")
      expect(await store.getNote("a")).toBeNull()
      expect(await store.getAllNotes()).toEqual({})
    })

    it("is keyed by note id, not display name or path", async () => {
      const store = await makeStore()
      // Ids that look like dates, weeks, and nested-ish names must all work.
      await store.writeNotes({
        "2026-01-01": "daily\n  id:: blk_aaaaaaaaaa\n",
        "2026-W01": "weekly\n  id:: blk_bbbbbbbbbb\n",
        "project-notes": "# Project\n  id:: blk_cccccccccc\n",
      })
      expect(await store.getNote("2026-01-01")).toBe("daily\n  id:: blk_aaaaaaaaaa\n")
      expect(await store.getNote("2026-W01")).toBe("weekly\n  id:: blk_bbbbbbbbbb\n")
      expect(await store.getNote("project-notes")).toBe("# Project\n  id:: blk_cccccccccc\n")
    })

    // -------------------------------------------------------------------------
    // Graph operations
    // -------------------------------------------------------------------------

    const OUTLINE = [
      "- root",
      "  id:: blk_root000000",
      "  - first",
      "    id:: blk_first00000",
      "  - second",
      "    id:: blk_second0000",
      "",
    ].join("\n")

    it("answers upstream and downstream containment queries", async () => {
      const store = await makeStore()
      await store.writeNotes({ a: OUTLINE })
      expect(await store.downstream("a")).toEqual(["blk_root000000"])
      expect(await store.downstream("blk_root000000")).toEqual(["blk_first00000", "blk_second0000"])
      expect(await store.upstream("blk_first00000")).toEqual(["blk_root000000"])
      expect(await store.upstream("blk_root000000")).toEqual(["a"])
      expect(await store.upstream("a")).toEqual([])
      expect(await store.downstream("blk_first00000")).toEqual([])
    })

    it("multi-parent: addLink renders the shared node in both notes", async () => {
      const store = await makeStore()
      await store.writeNotes({
        a: "- shared\n  id:: blk_shared0000\n  - inner\n    id:: blk_inner00000\n",
        b: "- b's own\n  id:: blk_bown000000\n",
      })
      await store.addLink("b", "blk_shared0000")

      expect(await store.upstream("blk_shared0000")).toEqual(["a", "b"])
      expect(await store.downstream("b")).toEqual(["blk_bown000000", "blk_shared0000"])
      // The shared node renders fully — children included — in note b too.
      expect(await store.getNote("b")).toBe(
        [
          "- b's own",
          "  id:: blk_bown000000",
          "- shared",
          "  id:: blk_shared0000",
          "  - inner",
          "    id:: blk_inner00000",
          "",
        ].join("\n"),
      )
    })

    it("multi-parent: removing one occurrence leaves the other intact", async () => {
      const store = await makeStore()
      await store.writeNotes({
        a: "- shared\n  id:: blk_shared0000\n",
        b: "- b's own\n  id:: blk_bown000000\n",
      })
      await store.addLink("b", "blk_shared0000")
      await store.removeLink("b", "blk_shared0000")

      expect(await store.upstream("blk_shared0000")).toEqual(["a"])
      expect(await store.getNote("a")).toBe("- shared\n  id:: blk_shared0000\n")
      expect(await store.getNote("b")).toBe("- b's own\n  id:: blk_bown000000\n")
    })

    it("ordered insertion: addLink positions siblings by `after`", async () => {
      const store = await makeStore()
      await store.writeNotes({
        a: OUTLINE,
        b: [
          "- loose one",
          "  id:: blk_loose00001",
          "- loose two",
          "  id:: blk_loose00002",
          "",
        ].join("\n"),
      })
      // Between first and second, then at the very front.
      await store.addLink("blk_root000000", "blk_loose00001", { after: "blk_first00000" })
      await store.addLink("blk_root000000", "blk_loose00002", { after: null })
      expect(await store.downstream("blk_root000000")).toEqual([
        "blk_loose00002",
        "blk_first00000",
        "blk_loose00001",
        "blk_second0000",
      ])
    })

    it("rejects a link that would create a cycle", async () => {
      const store = await makeStore()
      await store.writeNotes({ a: OUTLINE })
      await expect(store.addLink("blk_first00000", "blk_root000000")).rejects.toThrow(/cycle/i)
      await expect(store.addLink("blk_root000000", "blk_root000000")).rejects.toThrow(/cycle/i)
      // The failed writes changed nothing.
      expect(await store.downstream("blk_root000000")).toEqual(["blk_first00000", "blk_second0000"])
    })

    it("delete-rescue: unlinking a node's last occurrence re-parents its orphans to the page root", async () => {
      const store = await makeStore()
      await store.writeNotes({ a: OUTLINE })
      await store.removeLink("a", "blk_root000000")

      // root is gone; its children surface at the end of the page.
      expect(await store.upstream("blk_first00000")).toEqual(["a"])
      expect(await store.upstream("blk_second0000")).toEqual(["a"])
      expect(await store.getNote("a")).toBe(
        ["- first", "  id:: blk_first00000", "- second", "  id:: blk_second0000", ""].join("\n"),
      )
    })

    it("delete-rescue: multi-homed children stay where they are", async () => {
      const store = await makeStore()
      await store.writeNotes({
        a: "- holder\n  id:: blk_holder0000\n  - kept\n    id:: blk_kept000000\n",
        b: "- b root\n  id:: blk_broot00000\n",
      })
      await store.addLink("blk_broot00000", "blk_kept000000")
      await store.removeLink("a", "blk_holder0000")

      // holder's last occurrence went away; "kept" already lives under b's
      // root, so it is left there rather than rescued into a.
      expect(await store.upstream("blk_kept000000")).toEqual(["blk_broot00000"])
      // a still exists, as an empty page (the canonical empty serialization).
      expect(await store.getNote("a")).toBe("\n")
      expect(await store.getNote("b")).toBe(
        ["- b root", "  id:: blk_broot00000", "  - kept", "    id:: blk_kept000000", ""].join("\n"),
      )
    })

    it("deleting a note removes its exclusive nodes but spares multi-homed ones", async () => {
      const store = await makeStore()
      await store.writeNotes({
        a: "- only in a\n  id:: blk_onlya00000\n- shared\n  id:: blk_shared0000\n",
        b: "- b root\n  id:: blk_broot00000\n",
      })
      await store.addLink("blk_broot00000", "blk_shared0000")
      await store.deleteNote("a")

      expect(await store.getNote("a")).toBeNull()
      expect(await store.upstream("blk_shared0000")).toEqual(["blk_broot00000"])
      expect(await store.downstream("blk_broot00000")).toEqual(["blk_shared0000"])
      expect(await store.upstream("blk_onlya00000")).toEqual([])
      expect(await store.downstream("b")).toEqual(["blk_broot00000"])
    })
  })
}
