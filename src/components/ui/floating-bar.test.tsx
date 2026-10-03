// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { FloatingBar } from "./floating-bar"
import { FloatingHostContext } from "./layer"

afterEach(cleanup)

describe("FloatingBar", () => {
  it("is a named toolbar over the window where no page hosts it, with its children on the pill", () => {
    render(
      <FloatingBar open label="Add images" data-testid="bar">
        <button>Photos</button>
      </FloatingBar>,
    )
    const bar = screen.getByRole("toolbar", { name: "Add images" })
    expect(bar.parentElement).toBe(document.body)
    expect(bar.classList.contains("fixed")).toBe(true)
    expect(bar.hasAttribute("data-open")).toBe(true)
    expect(screen.getByRole("button", { name: "Photos" })).toBeTruthy()
    // As wide as its contents unless asked for the page's width.
    expect(bar.firstElementChild?.classList.contains("w-auto")).toBe(true)
  })

  it("spans the page when asked to", () => {
    render(
      <FloatingBar open width="full" label="Editing" data-testid="bar">
        <button>Bold</button>
      </FloatingBar>,
    )
    expect(screen.getByTestId("bar").firstElementChild?.classList.contains("w-full")).toBe(true)
  })

  it("stays mounted but out of sight and reach when closed, so the exit has something to play on", () => {
    render(
      <FloatingBar open={false} label="Add images" data-testid="bar">
        <button>Photos</button>
      </FloatingBar>,
    )
    const bar = screen.getByTestId("bar")
    expect(bar.hasAttribute("data-open")).toBe(false)
    expect(bar.getAttribute("aria-hidden")).toBe("true")
    expect(bar.firstElementChild?.classList.contains("invisible")).toBe(true)
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
})
