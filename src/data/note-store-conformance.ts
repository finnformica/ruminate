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

    it("delete-rescue: a rescued child keeps its own subtree (multi-level chains)", async () => {
      const store = await makeStore()
      await store.writeNotes({
        a: [
          "- top",
          "  id:: blk_top0000000",
          "  - mid",
          "    id:: blk_mid0000000",
          "    - leaf",
          "      id:: blk_leaf000000",
          "",
        ].join("\n"),
      })
      await store.removeLink("a", "blk_top0000000")

      // top's last occurrence is gone; mid surfaces at the page root with its
      // subtree intact — leaf stays a child of mid, not a second rescue.
      expect(await store.upstream("blk_mid0000000")).toEqual(["a"])
      expect(await store.upstream("blk_leaf000000")).toEqual(["blk_mid0000000"])
      expect(await store.getNote("a")).toBe(
        ["- mid", "  id:: blk_mid0000000", "  - leaf", "    id:: blk_leaf000000", ""].join("\n"),
      )
    })

    it("delete-rescue: multiple rescued children keep their sibling order", async () => {
      const store = await makeStore()
      await store.writeNotes({
        a: [
          "- keep",
          "  id:: blk_keep000000",
          "- gone",
          "  id:: blk_gone000000",
          "  - one",
          "    id:: blk_one0000000",
          "    - one deep",
          "      id:: blk_onedeep000",
          "  - two",
          "    id:: blk_two0000000",
          "    - two deep",
          "      id:: blk_twodeep000",
          "",
        ].join("\n"),
      })
      await store.removeLink("a", "blk_gone000000")

      // Both children — parents themselves — append at the page end, in the
      // order they had under the deleted node, subtrees intact.
      expect(await store.downstream("a")).toEqual([
        "blk_keep000000",
        "blk_one0000000",
        "blk_two0000000",
      ])
      expect(await store.downstream("blk_one0000000")).toEqual(["blk_onedeep000"])
      expect(await store.downstream("blk_two0000000")).toEqual(["blk_twodeep000"])
    })

    it("keeps sibling order through many inserts at the same spot (key growth stays sane)", async () => {
      const store = await makeStore()
      const INSERTS = 16
      const looseIds = Array.from(
        { length: INSERTS },
        (_, i) => `blk_ins${String(i).padStart(7, "0")}`,
      )
      await store.writeNotes({
        a: OUTLINE,
        b: looseIds.map((id, i) => `- loose ${i}\n  id:: ${id}`).join("\n") + "\n",
      })
      // Every insert lands directly after `first` — the worst case for
      // fractional keys (each key is generated inside the previous gap).
      for (const id of looseIds) {
        await store.addLink("blk_root000000", id, { after: "blk_first00000" })
      }
      expect(await store.downstream("blk_root000000")).toEqual([
        "blk_first00000",
        ...[...looseIds].reverse(),
        "blk_second0000",
      ])
    })

    it("a reorder-only save changes link rows, never node rows", async () => {
      const store = await makeStore()
      await store.writeNotes({
        a: "- one\n  id:: blk_one0000000\n- two\n  id:: blk_two0000000\n- three\n  id:: blk_three00000\n",
      })
      const diff = await store.writeNotes({
        a: "- three\n  id:: blk_three00000\n- two\n  id:: blk_two0000000\n- one\n  id:: blk_one0000000\n",
      })

      expect(diff.nodes).toEqual([])
      expect(diff.deleteNodes).toEqual([])
      expect(diff.deleteLinks).toEqual([])
      expect(diff.links.length).toBeGreaterThan(0)
      expect(diff.links.every((link) => link.source_id === "a")).toBe(true)
      expect(await store.downstream("a")).toEqual([
        "blk_three00000",
        "blk_two0000000",
        "blk_one0000000",
      ])
    })

    it("re-mints a block id that claims the note's own id (the page survives)", async () => {
      const store = await makeStore()
      // Block ids and page ids share the nodes table — an `id:: a` line inside
      // note a must not clobber a's page node.
      await store.writeNotes({ a: "- hello\n  id:: a\n" })
      const stored = await store.getNote("a")
      expect(stored).not.toBeNull()
      expect(stored).toContain("- hello")
      expect(parse(stored as string).blocks["a"]).toBeUndefined()
      expect(await store.getAllNotes()).toHaveProperty("a")
    })

    it("re-mints a block id that claims ANOTHER note's id (that page survives)", async () => {
      const store = await makeStore()
      await store.writeNotes({ b: "- b's content\n  id:: blk_bcontent00\n" })
      await store.writeNotes({ a: "- stray claim\n  id:: b\n" })

      // Note b is untouched; note a keeps its content under a fresh id.
      expect(await store.getNote("b")).toBe("- b's content\n  id:: blk_bcontent00\n")
      expect(await store.upstream("b")).toEqual([])
      const stored = await store.getNote("a")
      expect(stored).toContain("- stray claim")
      expect(parse(stored as string).blocks["b"]).toBeUndefined()
    })

    // Mirroring ("paste as link", docs/graph-storage.md): a pasted block keeps
    // its original id in the target note's markdown, so an ordinary save turns
    // it into a second inbound link on the same node. The per-save diff path
    // must treat such nodes exactly like the note-delete path does: unlink,
    // never destroy.

    const MIRRORED_B = [
      "- b's own",
      "  id:: blk_bown000000",
      "- shared",
      "  id:: blk_shared0000",
      "  - inner",
      "    id:: blk_inner00000",
      "",
    ].join("\n")

    it("save-diff: dropping a mirrored block from one note unlinks it there but leaves the mirror whole", async () => {
      const store = await makeStore()
      await store.writeNotes({
        a: "- shared\n  id:: blk_shared0000\n  - inner\n    id:: blk_inner00000\n",
      })
      // Paste-as-link: note b's save carries the same subtree, ids intact.
      await store.writeNotes({ b: MIRRORED_B })
      expect(await store.upstream("blk_shared0000")).toEqual(["a", "b"])

      // Save a WITHOUT the shared block: a's link goes; the node (and its
      // subtree) must survive untouched for b.
      await store.writeNotes({ a: "- a alone\n  id:: blk_aalone0000\n" })
      expect(await store.upstream("blk_shared0000")).toEqual(["b"])
      expect(await store.getNote("a")).toBe("- a alone\n  id:: blk_aalone0000\n")
      expect(await store.getNote("b")).toBe(MIRRORED_B)
    })

    it("save-diff: editing a mirrored block's text in either note updates the other's rollup", async () => {
      const store = await makeStore()
      await store.writeNotes({ a: "- draft\n  id:: blk_shared0000\n" })
      await store.writeNotes({
        b: "- b's own\n  id:: blk_bown000000\n- draft\n  id:: blk_shared0000\n",
      })

      // Edit via a's save…
      await store.writeNotes({ a: "- edited in a\n  id:: blk_shared0000\n" })
      expect(await store.getNote("b")).toBe(
        "- b's own\n  id:: blk_bown000000\n- edited in a\n  id:: blk_shared0000\n",
      )
      // …and back via b's save.
      await store.writeNotes({
        b: "- b's own\n  id:: blk_bown000000\n- edited in b\n  id:: blk_shared0000\n",
      })
      expect(await store.getNote("a")).toBe("- edited in b\n  id:: blk_shared0000\n")
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
