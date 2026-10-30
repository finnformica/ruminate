// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { Provider, createStore } from "jotai"
import { afterEach, describe, expect, it } from "vitest"
import { pageWidthAtom, rootTapAtom } from "../../global-state"
import { EditorSection } from "./editor-section"

/** The app-wide page width setting (H, page width): Settings → Editor,
 * `fixed` by default, held per device. */

afterEach(() => {
  cleanup()
  localStorage.clear()
})

describe("the page width setting", () => {
  it("defaults to Fixed, and Full width sets the app setting", () => {
    const store = createStore()
    render(
      <Provider store={store}>
        <EditorSection />
      </Provider>,
    )
    expect(screen.getByRole("button", { name: /Fixed/ }).getAttribute("aria-pressed")).toBe("true")
    fireEvent.click(screen.getByRole("button", { name: /Full width/ }))
    expect(store.get(pageWidthAtom)).toBe("full")
    expect(screen.getByRole("button", { name: /Full width/ }).getAttribute("aria-pressed")).toBe(
      "true",
    )
  })
})

describe("the tap on a block of the notes page", () => {
  it("opens on a phone only by default, and each choice sets the app setting", () => {
    const store = createStore()
    render(
      <Provider store={store}>
        <EditorSection />
      </Provider>,
    )
    const group = screen.getByRole("group", { name: "Tap a block on the notes page to open it" })
    expect(group).toBeTruthy()
    expect(screen.getByRole("button", { name: "Phone only" }).getAttribute("aria-pressed")).toBe(
      "true",
    )
    fireEvent.click(screen.getByRole("button", { name: "Every device" }))
    expect(store.get(rootTapAtom)).toBe("always")
    fireEvent.click(screen.getByRole("button", { name: "Never" }))
    expect(store.get(rootTapAtom)).toBe("never")
    expect(localStorage.getItem("root-tap")).toBe(JSON.stringify("never"))
  })

  it("reads a value this build does not know as the default", () => {
    localStorage.setItem("root-tap", JSON.stringify("sometimes"))
    const store = createStore()
    render(
      <Provider store={store}>
        <EditorSection />
      </Provider>,
    )
    expect(store.get(rootTapAtom)).toBe("phone")
    expect(screen.getByRole("button", { name: "Phone only" }).getAttribute("aria-pressed")).toBe(
      "true",
    )
  })
})
