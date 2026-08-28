// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { Provider, createStore } from "jotai"
import type { PrimitiveAtom } from "jotai"
import * as React from "react"
import { afterEach, describe, expect, it, vi } from "vitest"

// The banner reads two global-state atoms and links via the app router — both
// far too heavy for jsdom. The atoms are mocked as plain writable Jotai atoms
// (all the banner needs) and the router Link as a plain anchor.
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children?: React.ReactNode }) => <a href="#note">{children}</a>,
}))

vi.mock("../global-state", async () => {
  const { atom } = await import("jotai")
  return {
    mergeNoticesAtom: atom<{ noteId: string; copyId: string }[]>([]),
    dismissedMergeNoticeIdsAtom: atom<string[]>([]),
  }
})

import { dismissedMergeNoticeIdsAtom, mergeNoticesAtom } from "../global-state"
import { MergeNoticeBanner } from "./merge-notice-banner"

// The mocked atom is writable (see above), unlike the real read-only selectAtom.
const writableMergeNoticesAtom = mergeNoticesAtom as unknown as PrimitiveAtom<
  { noteId: string; copyId: string }[]
>

afterEach(cleanup)

function renderBanner(notices: { noteId: string; copyId: string }[]) {
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

  it("shows one line per notice, with the copy id as a link", () => {
    renderBanner([
      { noteId: "foo", copyId: "foo-conflict-20260828-0900" },
      { noteId: "bar", copyId: "bar-conflict-20260828-0901" },
    ])

    expect(screen.getAllByText(/Sync merged conflicting edits/)).toHaveLength(2)
    expect(screen.getByText("foo")).toBeDefined()
    const copyLink = screen.getByText("foo-conflict-20260828-0900")
    expect(copyLink.closest("a")).not.toBeNull()
  })

  it("dismiss hides the banner and never re-raises the same copy id", () => {
    const store = renderBanner([{ noteId: "foo", copyId: "foo-conflict-20260828-0900" }])

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }))
    expect(screen.queryByText(/Sync merged conflicting edits/)).toBeNull()
    expect(store.get(dismissedMergeNoticeIdsAtom)).toEqual(["foo-conflict-20260828-0900"])

    // A later pull re-delivering the same accumulated notice stays hidden; a
    // genuinely new copy shows up.
    act(() =>
      store.set(writableMergeNoticesAtom, [
        { noteId: "foo", copyId: "foo-conflict-20260828-0900" },
        { noteId: "baz", copyId: "baz-conflict-20260828-0902" },
      ]),
    )
    expect(screen.queryByText("foo-conflict-20260828-0900")).toBeNull()
    expect(screen.getByText("baz-conflict-20260828-0902")).toBeDefined()
  })
})
