import { getDefaultStore } from "jotai"
import { afterEach, describe, expect, it } from "vitest"
import type { NoteId } from "../schema"
import { createNodeSqlDriver } from "./sql-node-test-driver"
import { openSqlNoteStore, type SqlNoteStore } from "./sql-note-store"
import {
  flushStorageMirror,
  mirrorDeleteFile,
  mirrorFileWrites,
  startStorageMirror,
  stopStorageMirror,
  storageDiagnosticsAtom,
  verifyStorageMirror,
} from "./storage-mirror"

/** Start the mirror against an in-memory SQL store and a mutable file map. */
async function startTestMirror(initialFiles: Record<string, string> = {}) {
  let files = { ...initialFiles }
  const gitWrites: Record<NoteId, string>[] = []
  let sqlStore: SqlNoteStore | null = null

  startStorageMirror({
    getFiles: () => ({ ...files }),
    writeNotes: (updates) => {
      gitWrites.push(updates)
      for (const [id, content] of Object.entries(updates)) files[`${id}.md`] = content
    },
    openStore: async () => {
      sqlStore = await openSqlNoteStore(createNodeSqlDriver())
      return { store: sqlStore, persistence: "memory" as const }
    },
  })
  await flushStorageMirror()

  return {
    get store() {
      return sqlStore!
    },
    gitWrites,
    setFiles: (next: Record<string, string>) => {
      files = { ...next }
    },
    getFiles: () => ({ ...files }),
  }
}

const diagnostics = () => getDefaultStore().get(storageDiagnosticsAtom)

afterEach(async () => {
  stopStorageMirror()
  await flushStorageMirror()
})

describe("storage mirror", () => {
  it("ingests the worktree on start and reports diagnostics", async () => {
    const mirror = await startTestMirror({
      "a.md": "# A\n  id:: blk_aaaaaaaaaa\n",
      ".ruminate/view-state/a.json": '["blk_aaaaaaaaaa"]',
      "image.png": "not a note",
    })

    expect(await mirror.store.getAllNotes()).toEqual({ a: "# A\n  id:: blk_aaaaaaaaaa\n" })
    expect(await mirror.store.getViewState("a")).toEqual(["blk_aaaaaaaaaa"])
    expect(diagnostics().status).toBe("ready")
    expect(diagnostics().engine).toBe("database")
    expect(diagnostics().ingestedNotes).toBe(1)
    expect(diagnostics().lastIngestMs).not.toBeNull()
  })

  it("persists collision re-keys back through the git save path", async () => {
    const content = "# Dupe\n  id:: blk_dupe000000\n"
    const mirror = await startTestMirror({ "a.md": content, "b.md": content })

    expect(mirror.gitWrites).toHaveLength(1)
    const rewritten = mirror.gitWrites[0]["b"]
    expect(rewritten).toMatch(/^# Dupe\n {2}id:: blk_(?!dupe000000)[0-9a-z]{10}\n$/)
    expect(await mirror.store.getNote("b")).toBe(rewritten)
    expect(await mirror.store.getNote("a")).toBe(content)
    expect(diagnostics().rekeyCount).toBe(1)
    expect(diagnostics().rekeys[0].noteId).toBe("b")
  })

  it("dual-writes note and view-state writes into the SQL store", async () => {
    const mirror = await startTestMirror({ "a.md": "A\n" })

    mirrorFileWrites({
      "a.md": "A edited\n",
      "b.md": "B\n",
      ".ruminate/view-state/a.json": '["blk_aaaaaaaaaa"]',
    })
    await flushStorageMirror()

    expect(await mirror.store.getNote("a")).toBe("A edited\n")
    expect(await mirror.store.getNote("b")).toBe("B\n")
    expect(await mirror.store.getViewState("a")).toEqual(["blk_aaaaaaaaaa"])

    mirrorFileWrites({ "b.md": null, ".ruminate/view-state/a.json": null })
    await flushStorageMirror()
    expect(await mirror.store.getNote("b")).toBeNull()
    expect(await mirror.store.getViewState("a")).toEqual([])

    mirrorDeleteFile("a.md")
    await flushStorageMirror()
    expect(await mirror.store.getNote("a")).toBeNull()
  })

  it("verify: a dual-written save that matches git records no divergence", async () => {
    const mirror = await startTestMirror({ "a.md": "A\n" })

    mirrorFileWrites({ "a.md": "A edited\n" })
    mirror.setFiles({ "a.md": "A edited\n" })
    verifyStorageMirror(mirror.getFiles())
    await flushStorageMirror()

    expect(diagnostics().divergenceCount).toBe(0)
    expect(diagnostics().reconciledFromSync).toBe(0)
  })

  it("verify: external git changes (pulls) reconcile silently into SQL", async () => {
    const mirror = await startTestMirror({ "a.md": "A\n", "b.md": "B\n" })

    // A pull rewrites one note, adds one, and deletes one — none via dual-write.
    mirror.setFiles({ "a.md": "A from other device\n", "c.md": "C\n" })
    verifyStorageMirror(mirror.getFiles())
    await flushStorageMirror()

    expect(diagnostics().divergenceCount).toBe(0)
    expect(diagnostics().reconciledFromSync).toBe(3)
    expect(await mirror.store.getAllNotes()).toEqual({
      a: "A from other device\n",
      c: "C\n",
    })
  })

  it("verify: a SQL/git mismatch with no git change is a divergence — and is healed", async () => {
    const mirror = await startTestMirror({ "a.md": "A\n" })

    // Corrupt the SQL side out of band; git did not change.
    await mirror.store.writeNotes({ a: "corrupted\n" })
    verifyStorageMirror(mirror.getFiles())
    await flushStorageMirror()

    expect(diagnostics().divergenceCount).toBe(1)
    expect(diagnostics().divergences[0]).toMatchObject({ noteId: "a", kind: "mismatch" })
    // Git is canonical: the divergence is healed back to git's content.
    expect(await mirror.store.getNote("a")).toBe("A\n")
  })

  it("verify: a note missing from SQL is a divergence, an extra note is a divergence", async () => {
    const mirror = await startTestMirror({ "a.md": "A\n" })

    await mirror.store.deleteNote("a")
    await mirror.store.writeNotes({ ghost: "not in git\n" })
    verifyStorageMirror(mirror.getFiles())
    await flushStorageMirror()

    const kinds = diagnostics()
      .divergences.map((d) => `${d.noteId}:${d.kind}`)
      .sort()
    expect(kinds).toEqual(["a:missing-in-sql", "ghost:extra-in-sql"])
    expect(await mirror.store.getAllNotes()).toEqual({ a: "A\n" })
  })

  it("records SQL write failures without affecting the git path", async () => {
    const mirror = await startTestMirror({ "a.md": "A\n  id:: blk_aaaaaaaaaa\n" })

    // A note claiming a block id already homed in another note fails the SQL
    // batch (PK violation) — the error must be recorded, not thrown. The git
    // side of the write (canonical) succeeded, as `setFiles` reflects.
    mirror.setFiles({ ...mirror.getFiles(), "b.md": "B\n  id:: blk_aaaaaaaaaa\n" })
    mirrorFileWrites({ "b.md": "B\n  id:: blk_aaaaaaaaaa\n" })
    await flushStorageMirror()
    // The repair re-ingest (rekey pass) runs on the same queue.
    await flushStorageMirror()

    expect(diagnostics().writeErrorCount).toBeGreaterThan(0)
    // The repair re-keyed the collision and both notes made it into SQL.
    expect(Object.keys(await mirror.store.getAllNotes()).sort()).toEqual(["a", "b"])
  })

  it("is inert while stopped", async () => {
    mirrorFileWrites({ "a.md": "A\n" })
    verifyStorageMirror({ "a.md": "A\n" })
    await flushStorageMirror()
    expect(diagnostics().status).toBe("off")
  })

  it("stop resets diagnostics and closes the store", async () => {
    await startTestMirror({ "a.md": "A\n" })
    expect(diagnostics().status).toBe("ready")
    stopStorageMirror()
    await flushStorageMirror()
    expect(diagnostics()).toMatchObject({ engine: "git", status: "off", ingestedNotes: 0 })
  })
})
