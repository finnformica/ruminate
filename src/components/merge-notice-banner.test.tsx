// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { Provider, createStore } from "jotai"
import type { PrimitiveAtom } from "jotai"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

type MergeNotice = { noteId: string; losingSha: string; losingOid: string | null }

const mocks = vi.hoisted(() => ({ navigate: vi.fn() }))

// The banner reads two global-state atoms, navigates via the app router, and
// keys notices via the git layer — all far too heavy for jsdom. The atoms are
// mocked as plain writable Jotai atoms (all the banner needs), the router's
// useNavigate as a spy, and the git layer as just the pure key helper. The
// history-dialog atoms are real (plain Jotai atoms).
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mocks.navigate,
}))

vi.mock("../global-state", async () => {
  const { atom } = await import("jotai")
  return {
    mergeNoticesAtom: atom<MergeNotice[]>([]),
    dismissedMergeNoticeIdsAtom: atom<string[]>([]),
  }
})

vi.mock("../utils/git", () => ({
  mergeNoticeKey: (notice: { noteId: string; losingSha: string }) =>
    `${notice.noteId}@${notice.losingSha}`,
}))

import { dismissedMergeNoticeIdsAtom, mergeNoticesAtom } from "../global-state"
import { MergeNoticeBanner } from "./merge-notice-banner"
import {
  isNoteHistoryDialogOpenAtom,
  noteHistoryInitialVersionAtom,
} from "./note-history-dialog-state"

// The mocked atom is writable (see above), unlike the real read-only selectAtom.
const writableMergeNoticesAtom = mergeNoticesAtom as unknown as PrimitiveAtom<MergeNotice[]>

afterEach(cleanup)
beforeEach(() => {
  mocks.navigate.mockClear()
})

function renderBanner(notices: MergeNotice[]) {
  const store = createStore()
  store.set(writableMergeNoticesAtom, notices)
  render(
    <Provider store={store}>
      <MergeNoticeBanner />
    </Provider>,
  )
  return store
}

describe("MergeNoticeBanner", () => {
  it("renders nothing when there are no merge notices", () => {
    renderBanner([])
    expect(screen.queryByText(/Sync merged conflicting edits/)).toBeNull()
  })

  it("shows one line per notice, each with a view-previous-version action", () => {
    renderBanner([
      { noteId: "foo", losingSha: "sha-foo", losingOid: "oid-foo" },
      { noteId: "bar", losingSha: "sha-bar", losingOid: "oid-bar" },
    ])

    expect(screen.getAllByText(/Sync merged conflicting edits/)).toHaveLength(2)
    expect(screen.getByText("foo")).toBeDefined()
    expect(screen.getByText("bar")).toBeDefined()
    expect(screen.getAllByRole("button", { name: "View previous version" })).toHaveLength(2)
  })

  it("opens the note's history preselected on the losing version", () => {
    const store = renderBanner([
      { noteId: "foo", losingSha: "sha-losing", losingOid: "oid-losing" },
    ])

    fireEvent.click(screen.getByRole("button", { name: "View previous version" }))

    // Navigates to the note (where the dialog is mounted)…
    expect(mocks.navigate).toHaveBeenCalledWith({
      to: "/notes/$",
      params: { _splat: "foo" },
      search: { query: undefined },
    })
    // …and opens the history dialog targeting the losing version.
    expect(store.get(isNoteHistoryDialogOpenAtom)).toBe(true)
    expect(store.get(noteHistoryInitialVersionAtom)).toEqual({
      sha: "sha-losing",
      oid: "oid-losing",
    })
  })

  it("omits the oid from the target when it could not be resolved", () => {
    const store = renderBanner([{ noteId: "foo", losingSha: "sha-losing", losingOid: null }])

    fireEvent.click(screen.getByRole("button", { name: "View previous version" }))
    expect(store.get(noteHistoryInitialVersionAtom)).toEqual({ sha: "sha-losing", oid: undefined })
  })

  it("dismiss hides the banner and never re-raises the same notice", () => {
    const store = renderBanner([{ noteId: "foo", losingSha: "sha-1", losingOid: "oid-1" }])

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }))
    expect(screen.queryByText(/Sync merged conflicting edits/)).toBeNull()
    expect(store.get(dismissedMergeNoticeIdsAtom)).toEqual(["foo@sha-1"])

    // A later pull re-delivering the same accumulated notice stays hidden; a
    // genuinely new conflict shows up.
    act(() =>
      store.set(writableMergeNoticesAtom, [
        { noteId: "foo", losingSha: "sha-1", losingOid: "oid-1" },
        { noteId: "baz", losingSha: "sha-2", losingOid: "oid-2" },
      ]),
    )
    expect(screen.queryByText("foo")).toBeNull()
    expect(screen.getByText("baz")).toBeDefined()
  })
})
