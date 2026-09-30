// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { AsyncButton } from "./async-button"
import { Button } from "./button"

afterEach(cleanup)

const button = () => screen.getByRole("button") as HTMLButtonElement

describe("Button loading", () => {
  it("is disabled, busy, and spinning in its icon slot, with its label kept", () => {
    render(
      <Button icon={<svg data-testid="icon" />} loading>
        Share
      </Button>,
    )
    expect(button().disabled).toBe(true)
    expect(button().getAttribute("aria-busy")).toBe("true")
    expect(button().hasAttribute("data-loading")).toBe(true)
    expect(screen.queryByTestId("icon")).toBeNull()
    expect(button().querySelector("svg.animate-spin")).not.toBeNull()
    expect(button().textContent).toBe("Share")
  })

  it("shows its icon, and is pressable, when not loading", () => {
    render(<Button icon={<svg data-testid="icon" />}>Share</Button>)
    expect(button().disabled).toBe(false)
    expect(button().getAttribute("aria-busy")).toBeNull()
    expect(screen.getByTestId("icon")).toBeTruthy()
    expect(button().querySelector("svg.animate-spin")).toBeNull()
  })
})

describe("AsyncButton", () => {
  it("is busy from the click until the click's promise settles, and deaf meanwhile", async () => {
    let resolve!: () => void
    const promise = new Promise<void>((res) => (resolve = res))
    const onClick = vi.fn(() => promise)
    render(<AsyncButton onClick={onClick}>Revoke</AsyncButton>)

    fireEvent.click(button())
    expect(onClick).toHaveBeenCalledTimes(1)
    expect(button().disabled).toBe(true)
    expect(button().getAttribute("aria-busy")).toBe("true")
    expect(button().querySelector("svg.animate-spin")).not.toBeNull()

    fireEvent.click(button())
    expect(onClick).toHaveBeenCalledTimes(1)

    await act(async () => {
      resolve()
      await promise
    })
    expect(button().disabled).toBe(false)
    expect(button().getAttribute("aria-busy")).toBeNull()
  })
})
