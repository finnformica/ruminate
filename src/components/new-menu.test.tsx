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
})

async function openMenu() {
  fireEvent.click(screen.getByRole("button", { name: "New" }))
  await waitFor(() => expect(screen.getByRole("menu")).toBeTruthy())
}

describe("NewMenu", () => {
  it("offers a note and a board under one button", async () => {
    render(
      <Provider store={createStore()}>
        <NewMenu />
      </Provider>,
    )
    await openMenu()
    expect(screen.getByRole("menuitem", { name: /New note/ })).toBeTruthy()
    expect(screen.getByRole("menuitem", { name: /New board/ })).toBeTruthy()
  })

  it("New note opens a fresh note", async () => {
    render(
      <Provider store={createStore()}>
        <NewMenu />
      </Provider>,
    )
    await openMenu()
    fireEvent.click(screen.getByRole("menuitem", { name: /New note/ }))
    expect(mocks.navigate).toHaveBeenCalledWith(
      expect.objectContaining({ to: "/views/$", params: { _splat: expect.any(String) } }),
    )
  })

  it("New board opens the name dialog", async () => {
    const store = createStore()
    render(
      <Provider store={store}>
        <NewMenu />
      </Provider>,
    )
    await openMenu()
    fireEvent.click(screen.getByRole("menuitem", { name: /New board/ }))
    expect(store.get(newBoardDialogAtom)).toEqual({})
    expect(mocks.navigate).not.toHaveBeenCalled()
  })
})
