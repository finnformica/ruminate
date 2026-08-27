// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react"
import { Provider, createStore } from "jotai"
import { afterEach, describe, expect, it, vi } from "vitest"

// The component needs only the router's navigate/history and the help-panel
// atom — everything else about the app is irrelevant here.
const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  back: vi.fn(),
  forward: vi.fn(),
}))

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mocks.navigate,
  useRouter: () => ({ history: { back: mocks.back, forward: mocks.forward } }),
}))

vi.mock("../global-state", async () => {
  const { atom } = await import("jotai")
  return { isHelpPanelOpenAtom: atom(false) }
})

import { isHelpPanelOpenAtom } from "../global-state"
import { GlobalShortcuts } from "./global-shortcuts"

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function renderShortcuts() {
  const store = createStore()
  const utils = render(
    <Provider store={store}>
      <GlobalShortcuts />
      {/* Stand-ins for the app's focus targets. The div mimics the block
          editor's select-mode container (a focusable non-input that lets
          unbound keys bubble); the textarea mimics edit mode. */}
      <div tabIndex={-1} data-testid="select-container" />
      <textarea data-testid="edit-textarea" />
      <input data-testid="text-input" />
    </Provider>,
  )
  return { store, ...utils }
}

describe("? shortcut reference", () => {
  it("opens from a plain page context", () => {
    const { store } = renderShortcuts()
    fireEvent.keyDown(document.body, { key: "?", shiftKey: true })
    expect(store.get(isHelpPanelOpenAtom)).toBe(true)
    // Pressing again toggles it closed.
    fireEvent.keyDown(document.body, { key: "?", shiftKey: true })
    expect(store.get(isHelpPanelOpenAtom)).toBe(false)
  })

  it("opens from the editor's select-mode container (event bubbles up)", () => {
    const { store, getByTestId } = renderShortcuts()
    const container = getByTestId("select-container")
    container.focus()
    fireEvent.keyDown(container, { key: "?", shiftKey: true })
    expect(store.get(isHelpPanelOpenAtom)).toBe(true)
  })

  it("does NOT open while typing in a textarea (edit mode) or input", () => {
    const { store, getByTestId } = renderShortcuts()
    fireEvent.keyDown(getByTestId("edit-textarea"), { key: "?", shiftKey: true })
    fireEvent.keyDown(getByTestId("text-input"), { key: "?", shiftKey: true })
    expect(store.get(isHelpPanelOpenAtom)).toBe(false)
  })

  it("handles the Shift+/ spelling (layouts that report '/' with shift)", () => {
    const { store } = renderShortcuts()
    fireEvent.keyDown(document.body, { key: "/", shiftKey: true })
    expect(store.get(isHelpPanelOpenAtom)).toBe(true)
  })

  it("ignores ? with a modifier held", () => {
    const { store } = renderShortcuts()
    fireEvent.keyDown(document.body, { key: "?", shiftKey: true, metaKey: true })
    expect(store.get(isHelpPanelOpenAtom)).toBe(false)
  })
})

describe("g chords", () => {
  it("g then d navigates to today's daily note", () => {
    renderShortcuts()
    fireEvent.keyDown(document.body, { key: "g" })
    fireEvent.keyDown(document.body, { key: "d" })
    expect(mocks.navigate).toHaveBeenCalledTimes(1)
    const call = mocks.navigate.mock.calls[0][0]
    expect(call.to).toBe("/notes/$")
    expect(call.params._splat).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it("g then n / t / s navigate to notes, tags, settings", () => {
    renderShortcuts()
    fireEvent.keyDown(document.body, { key: "g" })
    fireEvent.keyDown(document.body, { key: "n" })
    expect(mocks.navigate).toHaveBeenLastCalledWith(expect.objectContaining({ to: "/" }))
    fireEvent.keyDown(document.body, { key: "g" })
    fireEvent.keyDown(document.body, { key: "t" })
    expect(mocks.navigate).toHaveBeenLastCalledWith(expect.objectContaining({ to: "/tags" }))
    fireEvent.keyDown(document.body, { key: "g" })
    fireEvent.keyDown(document.body, { key: "s" })
    expect(mocks.navigate).toHaveBeenLastCalledWith(expect.objectContaining({ to: "/settings" }))
  })

  it("works from the editor's select-mode container", () => {
    const { getByTestId } = renderShortcuts()
    const container = getByTestId("select-container")
    container.focus()
    fireEvent.keyDown(container, { key: "g" })
    fireEvent.keyDown(container, { key: "d" })
    expect(mocks.navigate).toHaveBeenCalledTimes(1)
  })

  it("does nothing while typing", () => {
    const { getByTestId } = renderShortcuts()
    const textarea = getByTestId("edit-textarea")
    fireEvent.keyDown(textarea, { key: "g" })
    fireEvent.keyDown(textarea, { key: "d" })
    expect(mocks.navigate).not.toHaveBeenCalled()
  })
})

describe("⌘[ / ⌘] history", () => {
  it("walk the router history back and forward", () => {
    renderShortcuts()
    fireEvent.keyDown(document.body, { key: "[", metaKey: true })
    expect(mocks.back).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(document.body, { key: "]", metaKey: true })
    expect(mocks.forward).toHaveBeenCalledTimes(1)
  })
})
