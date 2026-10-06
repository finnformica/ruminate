// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { getDefaultStore } from "jotai"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const flush = vi.fn(() => Promise.resolve())
vi.mock("../data/database-mode", () => ({ requestDatabaseFlush: () => flush() }))

import { appUpdateAtom } from "../hooks/app-update"
import { AppUpdateNotice } from "./app-update-notice"

const store = getDefaultStore()
const apply = vi.fn(() => new Promise<void>(() => {}))

beforeEach(() => {
  flush.mockClear()
  apply.mockClear()
  store.set(appUpdateAtom, { needRefresh: false, apply })
})
afterEach(cleanup)

describe("the phone's update notice", () => {
  it("says nothing while no update is waiting", () => {
    render(<AppUpdateNotice />)
    expect(screen.queryByRole("status")).toBeNull()
  })

  it("says a new version is ready, with Update beside it", () => {
    store.set(appUpdateAtom, { needRefresh: true, apply })
    render(<AppUpdateNotice />)
    expect(screen.getByRole("status").textContent).toContain("A new version of Ruminate is ready.")
    expect(screen.getByRole("button", { name: "Update" })).toBeTruthy()
  })

  it("Update lands the pending edits, then applies, and stays busy", async () => {
    const order: string[] = []
    flush.mockImplementation(() => {
      order.push("flush")
      return Promise.resolve()
    })
    apply.mockImplementation(() => {
      order.push("apply")
      return new Promise<void>(() => {})
    })
    store.set(appUpdateAtom, { needRefresh: true, apply })
    render(<AppUpdateNotice />)

    const button = screen.getByRole("button", { name: "Update" })
    fireEvent.click(button)
    await vi.waitFor(() => expect(apply).toHaveBeenCalledTimes(1))
    expect(order).toEqual(["flush", "apply"])
    // Applying ends in a reload, so the button never settles.
    await vi.waitFor(() => expect(button.getAttribute("aria-busy")).toBe("true"))
  })

  it("Dismiss puts it away", () => {
    store.set(appUpdateAtom, { needRefresh: true, apply })
    render(<AppUpdateNotice />)
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }))
    expect(screen.queryByRole("status")).toBeNull()
  })
})
