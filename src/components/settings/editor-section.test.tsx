// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { Provider, createStore } from "jotai"
import { afterEach, describe, expect, it } from "vitest"
import { pageWidthAtom } from "../../global-state"
import { EditorSection } from "./editor-section"

/** The app-wide page width setting (H, page width): Settings → Editor,
 * `fixed` by default, held per device. */

afterEach(cleanup)

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
