// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { Provider, createStore } from "jotai"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// The dialog's data layer (isomorphic-git over lightning-fs, which needs
// indexedDB), the save hook (global state machine), and the block editor
// (view-state sidecars) are all far too heavy for jsdom — the tests exercise
// the dialog's own behavior: listing, pagination, preview, restore, copy.
const mocks = vi.hoisted(() => ({
  listNoteVersions: vi.fn(),
  readNoteVersion: vi.fn(),
  saveNote: vi.fn(),
}))

vi.mock("../data/note-history", () => ({
  listNoteVersions: mocks.listNoteVersions,
  readNoteVersion: mocks.readNoteVersion,
}))

vi.mock("../hooks/note", () => ({
  useSaveNote: () => mocks.saveNote,
}))

vi.mock("./block-editor/block-note-editor", () => ({
  BlockNoteEditor: ({ value }: { value: string }) => <pre data-testid="preview">{value}</pre>,
}))

import { NoteHistoryDialog } from "./note-history-dialog"
import { isNoteHistoryDialogOpenAtom } from "./note-history-dialog-state"

afterEach(cleanup)
beforeEach(() => {
  vi.clearAllMocks()
})

const V_NEWEST = {
  sha: "c3",
  timestamp: 1700000300,
  oid: "blob-new",
  parentOid: "blob-old",
  mergeSide: false,
}
const V_OLDER = {
  sha: "c2",
  timestamp: 1700000200,
  oid: "blob-old",
  parentOid: null,
  mergeSide: false,
}
const V_OLDEST = {
  sha: "c1",
  timestamp: 1700000100,
  oid: "blob-first",
  parentOid: null,
  mergeSide: false,
}
const V_MERGE_SIDE = {
  sha: "b1",
  timestamp: 1700000400,
  oid: "blob-other-device",
  parentOid: "blob-old",
  mergeSide: true,
}

const CONTENT: Record<string, string> = {
  "blob-new": "newest content",
  "blob-old": "older content",
  "blob-first": "first content",
  "blob-other-device": "other device content",
}

function setupHistory({ nextCursor = null }: { nextCursor?: string | null } = {}) {
  mocks.listNoteVersions.mockResolvedValue({ versions: [V_NEWEST, V_OLDER], nextCursor })
  mocks.readNoteVersion.mockImplementation(({ oid }: { oid: string }) =>
    Promise.resolve(CONTENT[oid] ?? ""),
  )
}

function renderDialog(props: Partial<Parameters<typeof NoteHistoryDialog>[0]> = {}) {
  const store = createStore()
  store.set(isNoteHistoryDialogOpenAtom, true)
  render(
    <Provider store={store}>
      <NoteHistoryDialog noteId="note-1" currentContent="current" {...props} />
    </Provider>,
  )
  return store
}

describe("NoteHistoryDialog", () => {
  it("lists the note's versions with the newest marked as current, and previews it", async () => {
    setupHistory()
    renderDialog()

    // Only commits the walk returned are listed (two versions).
    await waitFor(() => {
      expect(screen.getAllByRole("option")).toHaveLength(2)
    })
    expect(screen.getByText("Current")).toBeTruthy()
    expect(mocks.listNoteVersions).toHaveBeenCalledWith({ filepath: "note-1.md", limit: 20 })

    // The newest version is selected and previewed by default.
    await waitFor(() => {
      expect(screen.getByTestId("preview").textContent).toBe("newest content")
    })
    expect(screen.getByText("No earlier versions")).toBeTruthy()
  })

  it("shows more versions when the cursor continues, resuming the walk", async () => {
    setupHistory({ nextCursor: "c1" })
    renderDialog()

    const showMore = await screen.findByText("Show more")
    mocks.listNoteVersions.mockResolvedValueOnce({ versions: [V_OLDEST], nextCursor: null })
    fireEvent.click(showMore)

    await waitFor(() => {
      expect(screen.getAllByRole("option")).toHaveLength(3)
    })
    expect(mocks.listNoteVersions).toHaveBeenLastCalledWith({
      filepath: "note-1.md",
      cursor: "c1",
      limit: 20,
    })
    // Exhausted now: the button is replaced by the end-of-history marker.
    expect(screen.queryByText("Show more")).toBeNull()
    expect(screen.getByText("No earlier versions")).toBeTruthy()
  })

  it("previews an older version when selected", async () => {
    setupHistory()
    renderDialog()

    const options = await screen.findAllByRole("option")
    fireEvent.click(options[1])

    await waitFor(() => {
      expect(screen.getByTestId("preview").textContent).toBe("older content")
    })
  })

  it("restores the selected version through onRestore after an inline confirmation", async () => {
    setupHistory()
    const onRestore = vi.fn()
    const store = renderDialog({ onRestore })

    const options = await screen.findAllByRole("option")
    fireEvent.click(options[1])
    await waitFor(() => {
      expect(screen.getByTestId("preview").textContent).toBe("older content")
    })

    fireEvent.click(screen.getByText("Restore this version"))
    // Nothing saved yet — the inline confirmation explains the forward-only save.
    expect(onRestore).not.toHaveBeenCalled()
    expect(
      screen.getByText("This saves the old version as the newest — nothing in history is lost."),
    ).toBeTruthy()

    fireEvent.click(screen.getByText("Restore"))
    expect(onRestore).toHaveBeenCalledWith("older content")
    // The dialog closes after restoring.
    expect(store.get(isNoteHistoryDialogOpenAtom)).toBe(false)
  })

  it("falls back to saving directly when no onRestore is provided", async () => {
    setupHistory()
    renderDialog()

    const options = await screen.findAllByRole("option")
    fireEvent.click(options[1])
    await waitFor(() => {
      expect(screen.getByTestId("preview").textContent).toBe("older content")
    })

    fireEvent.click(screen.getByText("Restore this version"))
    fireEvent.click(screen.getByText("Restore"))
    expect(mocks.saveNote).toHaveBeenCalledWith({ id: "note-1", content: "older content" })
  })

  it("disables restoring a version identical to the current content", async () => {
    setupHistory()
    renderDialog({ currentContent: "newest content" })

    await waitFor(() => {
      expect(screen.getByTestId("preview").textContent).toBe("newest content")
    })

    const restoreButton = screen.getByText("Restore this version").closest("button")!
    expect(restoreButton.disabled).toBe(true)
  })

  it("labels a merge-side version and restores it like any other", async () => {
    // The other-device edit is newer than the surviving local version, so it
    // sorts first — the "Current" marker must stay on the first-parent version.
    mocks.listNoteVersions.mockResolvedValue({
      versions: [V_MERGE_SIDE, V_NEWEST, V_OLDER],
      nextCursor: null,
    })
    mocks.readNoteVersion.mockImplementation(({ oid }: { oid: string }) =>
      Promise.resolve(CONTENT[oid] ?? ""),
    )
    const onRestore = vi.fn()
    renderDialog({ onRestore })

    const options = await screen.findAllByRole("option")
    expect(screen.getByText("Merged from another device")).toBeTruthy()
    // "Current" marks the newest first-parent version (index 1), not the
    // merge-side entry above it.
    expect(options[1].textContent).toContain("Current")
    expect(options[0].textContent).not.toContain("Current")

    fireEvent.click(options[0])
    await waitFor(() => {
      expect(screen.getByTestId("preview").textContent).toBe("other device content")
    })
    fireEvent.click(screen.getByText("Restore this version"))
    fireEvent.click(screen.getByText("Restore"))
    expect(onRestore).toHaveBeenCalledWith("other device content")
  })

  it("preselects and previews an initialSha, fetching extra pages to find it", async () => {
    mocks.listNoteVersions.mockImplementation(({ cursor }: { cursor?: string }) =>
      Promise.resolve(
        cursor === "cur1"
          ? { versions: [V_OLDEST], nextCursor: null }
          : { versions: [V_NEWEST, V_OLDER], nextCursor: "cur1" },
      ),
    )
    mocks.readNoteVersion.mockImplementation(({ oid }: { oid: string }) =>
      Promise.resolve(CONTENT[oid] ?? ""),
    )
    renderDialog({ initialSha: "c1" })

    // The target is on page 2 — the dialog walks until it finds it.
    await waitFor(() => {
      expect(screen.getAllByRole("option")).toHaveLength(3)
    })
    const options = screen.getAllByRole("option")
    expect(options[2].getAttribute("aria-selected")).toBe("true")
    await waitFor(() => {
      expect(screen.getByTestId("preview").textContent).toBe("first content")
    })
    expect(screen.queryByText(/Version not found/)).toBeNull()
  })

  it("falls back to the newest version, with a note, when initialSha is not found", async () => {
    setupHistory()
    renderDialog({ initialSha: "no-such-sha" })

    await waitFor(() => {
      expect(screen.getAllByRole("option")).toHaveLength(2)
    })
    expect(screen.getByText(/Version not found in recent history/)).toBeTruthy()
    const options = screen.getAllByRole("option")
    expect(options[0].getAttribute("aria-selected")).toBe("true")
    await waitFor(() => {
      expect(screen.getByTestId("preview").textContent).toBe("newest content")
    })
  })

  it("bounds the initialSha search to 10 pages", async () => {
    let pageCount = 0
    mocks.listNoteVersions.mockImplementation(() => {
      pageCount++
      return Promise.resolve({
        versions: [{ ...V_OLDER, sha: `page-${pageCount}` }],
        nextCursor: `cur-${pageCount}`,
      })
    })
    mocks.readNoteVersion.mockResolvedValue("content")
    renderDialog({ initialSha: "unreachable" })

    await screen.findByText(/Version not found in recent history/)
    expect(mocks.listNoteVersions).toHaveBeenCalledTimes(10)
  })

  it("shows the empty state when the note has no git history", async () => {
    mocks.listNoteVersions.mockResolvedValue({ versions: [], nextCursor: null })
    renderDialog()

    expect(
      await screen.findByText("No history yet — this note hasn’t been saved to git."),
    ).toBeTruthy()
  })

  it("surfaces walk errors", async () => {
    mocks.listNoteVersions.mockRejectedValue(new Error("object not found"))
    renderDialog()

    expect(await screen.findByText(/Couldn’t load history: object not found/)).toBeTruthy()
  })
})
