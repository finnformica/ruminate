// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { FloatingBar } from "./floating-bar"
import { FloatingHostContext } from "./layer"

afterEach(cleanup)

describe("FloatingBar", () => {
  it("is a named toolbar over the window where no page hosts it, with its children on the surface", () => {
    render(
      <FloatingBar open label="Add images" data-testid="bar">
        <button>Photos</button>
      </FloatingBar>,
    )
    const bar = screen.getByRole("toolbar", { name: "Add images" })
    expect(bar.parentElement).toBe(document.body)
    expect(bar.classList.contains("fixed")).toBe(true)
    expect(bar.classList.contains("hidden")).toBe(false)
    expect(screen.getByRole("button", { name: "Photos" })).toBeTruthy()
  })

  it("sits in the page's box when one is provided, so it clears what is drawn beneath the page", () => {
    const host = document.createElement("div")
    document.body.appendChild(host)
    render(
      <FloatingHostContext.Provider value={host}>
        <FloatingBar open label="Add images" data-testid="bar">
          <button>Photos</button>
        </FloatingBar>
      </FloatingHostContext.Provider>,
    )
    const bar = screen.getByTestId("bar")
    expect(bar.parentElement).toBe(host)
    expect(bar.classList.contains("absolute")).toBe(true)
    host.remove()
  })

  it("stays mounted but hidden when closed, so the exit has something to play on", () => {
    render(
      <FloatingBar open={false} label="Add images" data-testid="bar">
        <button>Photos</button>
      </FloatingBar>,
    )
    const bar = screen.getByTestId("bar")
    expect(bar.classList.contains("hidden")).toBe(true)
    expect(bar.getAttribute("aria-hidden")).toBe("true")
  })
})
