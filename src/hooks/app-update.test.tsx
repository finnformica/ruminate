// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react"
import { getDefaultStore } from "jotai"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// The hook only needs the atom and the flush seam; the service worker
// registration (`virtual:pwa-register/react`) never runs here.
const flush = vi.fn(() => Promise.resolve())
vi.mock("../data/database-mode", () => ({ requestDatabaseFlush: () => flush() }))

import { appUpdateAtom, useApplyUpdateShortcut } from "./app-update"

function Harness() {
  useApplyUpdateShortcut()
  return null
}

const store = getDefaultStore()
const apply = vi.fn()

// react-hotkeys-hook spells the combo `mod+shift+u`; on a non-mac jsdom that
// is Ctrl.
const pressShortcut = () =>
  fireEvent.keyDown(document.body, { key: "u", code: "KeyU", ctrlKey: true, shiftKey: true })

beforeEach(() => {
  flush.mockClear()
  apply.mockClear()
  store.set(appUpdateAtom, { needRefresh: false, apply })
})
afterEach(cleanup)

describe("the Update Ruminate shortcut (⌘⇧U)", () => {
  it("does nothing when no update is waiting", async () => {
    render(<Harness />)
    pressShortcut()
    await Promise.resolve()
    expect(flush).not.toHaveBeenCalled()
    expect(apply).not.toHaveBeenCalled()
  })

  it("lands the pending ops before applying a waiting update", async () => {
    const order: string[] = []
    flush.mockImplementation(() => {
      order.push("flush")
      return Promise.resolve()
    })
    apply.mockImplementation(() => order.push("apply"))
    store.set(appUpdateAtom, { needRefresh: true, apply })

    render(<Harness />)
    pressShortcut()
    await vi.waitFor(() => expect(apply).toHaveBeenCalledTimes(1))
    expect(order).toEqual(["flush", "apply"])
  })
})
