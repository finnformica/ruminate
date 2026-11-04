// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { Provider, createStore } from "jotai"
import { afterEach, describe, expect, it, vi } from "vitest"
import { newBoardDialogAtom } from "./new-board-dialog"
import { NewMenu } from "./new-menu"

const mocks = vi.hoisted(() => ({ navigate: vi.fn() }))

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mocks.navigate,
}))

afterEach(() => {
  cleanup()
  mocks.navigate.mockReset()
  vi.unstubAllGlobals()
})

/** A screen `width` px wide, as far as `(min-width: …)` queries go. */
function stubWidth(width: number) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: width >= Number(/min-width: (\d+)px/.exec(query)?.[1] ?? Infinity),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }))
}

async function openMenu() {
  fireEvent.click(screen.getByRole("button", { name: "New" }))
  await waitFor(() => expect(screen.getByRole("menu")).toBeTruthy())
}

describe("NewMenu", () => {
  it("offers a note and a board under one button", async () => {
    render(
      <Provider store={createStore()}>
        <NewMenu on="wide" />
      </Provider>,
    )
    await openMenu()
    expect(screen.getByRole("menuitem", { name: /New note/ })).toBeTruthy()
    expect(screen.getByRole("menuitem", { name: /New board/ })).toBeTruthy()
  })

  it("New note opens a fresh note", async () => {
    render(
      <Provider store={createStore()}>
        <NewMenu on="wide" />
      </Provider>,
    )
    await openMenu()
    fireEvent.click(screen.getByRole("menuitem", { name: /New note/ }))
    expect(mocks.navigate).toHaveBeenCalledWith(
      expect.objectContaining({ to: "/notes/$", params: { _splat: expect.any(String) } }),
    )
  })

  it("New board opens the name dialog", async () => {
    const store = createStore()
    render(
      <Provider store={store}>
        <NewMenu on="wide" />
      </Provider>,
    )
    await openMenu()
    fireEvent.click(screen.getByRole("menuitem", { name: /New board/ }))
    expect(store.get(newBoardDialogAtom)).toBe(true)
    expect(mocks.navigate).not.toHaveBeenCalled()
  })

  // A copy hidden only by a class is still in the page, and a menu opened
  // from it anchors to the window's top left: off its screen it is not drawn.
  it.each([
    { width: 390, on: "phone", drawn: true },
    { width: 390, on: "wide", drawn: false },
    { width: 1440, on: "phone", drawn: false },
    { width: 1440, on: "wide", drawn: true },
  ] as const)("on=$on at $width px is drawn: $drawn", ({ width, on, drawn }) => {
    stubWidth(width)
    render(
      <Provider store={createStore()}>
        <NewMenu on={on} />
      </Provider>,
    )
    expect(screen.queryByRole("button", { name: "New" }) !== null).toBe(drawn)
  })
})
