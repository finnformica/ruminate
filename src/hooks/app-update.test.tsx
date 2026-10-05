// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react"
import { getDefaultStore } from "jotai"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// The hooks need the atom and the flush seam, and the service worker
// registration (`virtual:pwa-register/react`) is stood in for: it hands back
// the options it was given, so a test can play the registration.
const flush = vi.fn(() => Promise.resolve())
vi.mock("../data/database-mode", () => ({ requestDatabaseFlush: () => flush() }))

type RegisterOptions = { onRegistered?: (registration: unknown) => void }
let registerOptions: RegisterOptions | undefined
vi.mock("virtual:pwa-register/react", () => ({
  useRegisterSW: (options: RegisterOptions) => {
    registerOptions = options
    return {
      needRefresh: [false, () => {}],
      offlineReady: [false, () => {}],
      updateServiceWorker: () => Promise.resolve(),
    }
  },
}))

import { appUpdateAtom, useApplyUpdateShortcut, useRegisterAppUpdate } from "./app-update"

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

function RegisterHarness() {
  useRegisterAppUpdate()
  return null
}

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", { value: state, configurable: true })
  document.dispatchEvent(new Event("visibilitychange"))
}

describe("checking for an update", () => {
  it("asks the service worker again when the app comes back to the foreground", () => {
    const update = vi.fn(() => Promise.resolve())
    render(<RegisterHarness />)
    registerOptions?.onRegistered?.({ update })
    expect(update).not.toHaveBeenCalled()

    setVisibility("hidden")
    expect(update).not.toHaveBeenCalled()

    setVisibility("visible")
    expect(update).toHaveBeenCalledTimes(1)
  })

  it("a check that fails, offline, is not an error", async () => {
    const update = vi.fn(() => Promise.reject(new Error("offline")))
    render(<RegisterHarness />)
    registerOptions?.onRegistered?.({ update })
    expect(() => setVisibility("visible")).not.toThrow()
    await Promise.resolve()
    expect(update).toHaveBeenCalledTimes(1)
  })
})
