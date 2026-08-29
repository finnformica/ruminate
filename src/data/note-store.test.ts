import { describe, expect, it } from "vitest"
import { LEGACY_VIEW_STATE_PATH, viewStatePath } from "./paths"
import { createGitNoteStore, type GitStoreBackend } from "./note-store"
import { describeNoteStoreConformance } from "./note-store-conformance"

/**
 * An in-memory `GitStoreBackend` with the same semantics as the machine's file
 * handling: `writeFiles` applies a batch (null deletes), `deleteFile` removes
 * one path. Lets the git-backed `NoteStore` adapter run without a browser fs.
 */
function makeMemoryBackend(initialFiles: Record<string, string> = {}): GitStoreBackend {
  const files: Record<string, string> = { ...initialFiles }
  return {
    getFiles: () => ({ ...files }),
    writeFiles: (updates) => {
      for (const [path, content] of Object.entries(updates)) {
        if (content === null) delete files[path]
        else files[path] = content
      }
    },
    deleteFile: (path) => {
      delete files[path]
    },
  }
}

describeNoteStoreConformance("git-backed store", () => createGitNoteStore(makeMemoryBackend()))

describe("createGitNoteStore (git-specific behavior)", () => {
  it("excludes non-note repo files from getAllNotes", async () => {
    const store = createGitNoteStore(
      makeMemoryBackend({
        "a.md": "A\n",
        ".ruminate/view-state/a.json": '["blk_aaaaaaaaaa"]',
        "image.png": "binary",
        ".gitignore": "dist\n",
      }),
    )
    expect(await store.getAllNotes()).toEqual({ a: "A\n" })
  })

  it("reads view state from the per-note sidecar file", async () => {
    const store = createGitNoteStore(
      makeMemoryBackend({ [viewStatePath("a")]: '["blk_aaaaaaaaaa"]' }),
    )
    expect(await store.getViewState("a")).toEqual(["blk_aaaaaaaaaa"])
  })

  it("falls back to the legacy single-file sidecar and migrates it on write", async () => {
    const backend = makeMemoryBackend({
      [LEGACY_VIEW_STATE_PATH]: JSON.stringify({
        a: ["blk_aaaaaaaaaa"],
        b: ["blk_bbbbbbbbbb"],
      }),
    })
    const store = createGitNoteStore(backend)
    expect(await store.getViewState("a")).toEqual(["blk_aaaaaaaaaa"])

    // The first write migrates: per-note files split out, legacy file deleted.
    await store.setViewState("a", ["blk_cccccccccc"])
    const files = backend.getFiles()
    expect(files[LEGACY_VIEW_STATE_PATH]).toBeUndefined()
    expect(await store.getViewState("a")).toEqual(["blk_cccccccccc"])
    expect(await store.getViewState("b")).toEqual(["blk_bbbbbbbbbb"])
  })

  it("skips the write entirely when view state is unchanged (no empty commits)", async () => {
    let writes = 0
    const inner = makeMemoryBackend()
    const backend: typeof inner = {
      ...inner,
      writeFiles: (files, msg) => {
        writes += 1
        inner.writeFiles(files, msg)
      },
    }
    const store = createGitNoteStore(backend)
    await store.setViewState("a", ["blk_aaaaaaaaaa"])
    expect(writes).toBe(1)
    // Same set again (different order, with a duplicate) → same bytes → no write.
    await store.setViewState("a", ["blk_aaaaaaaaaa", "blk_aaaaaaaaaa"])
    expect(writes).toBe(1)
  })

  it("deleteNote only touches the note file", async () => {
    const backend = makeMemoryBackend({
      "a.md": "A\n",
      [viewStatePath("a")]: '["blk_aaaaaaaaaa"]',
    })
    const store = createGitNoteStore(backend)
    await store.deleteNote("a")
    const files = backend.getFiles()
    expect(files["a.md"]).toBeUndefined()
    // Matches current app behavior: the sidecar is left behind (harmless, and
    // cleaned up naturally if the note id is ever reused).
    expect(files[viewStatePath("a")]).toBe('["blk_aaaaaaaaaa"]')
  })
})
