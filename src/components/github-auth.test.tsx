// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { SignInButton } from "./github-auth"

// jsdom cannot leave for GitHub ("Not implemented: navigation"), which is
// the point: the page stays, and so does the button's flight.
afterEach(cleanup)

const button = () => screen.getByRole("button") as HTMLButtonElement

describe("SignInButton", () => {
  it("is busy from the press until the page has gone, and pressable again if it comes back", async () => {
    render(<SignInButton />)
    expect(button().textContent).toBe("Sign in with GitHub")
    expect(button().disabled).toBe(false)

    await act(async () => {
      fireEvent.click(button())
    })
    // The page is leaving for GitHub: nothing settles it while it is here.
    expect(button().disabled).toBe(true)
    expect(button().getAttribute("aria-busy")).toBe("true")
    expect(button().querySelector("svg.animate-spin")).not.toBeNull()

    // Back from GitHub into this page as it was (bfcache): pressable again.
    await act(async () => {
      window.dispatchEvent(new Event("pageshow"))
      await Promise.resolve()
    })
    expect(button().disabled).toBe(false)
  })

  it("takes its own words", () => {
    render(<SignInButton>Sign in with GitHub to join</SignInButton>)
    expect(button().textContent).toBe("Sign in with GitHub to join")
  })
})
