import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { GChordMachine, type ChordKey } from "./chords"

function key(k: string, overrides: Partial<ChordKey> = {}): ChordKey {
  return {
    key: k,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    isTyping: false,
    defaultPrevented: false,
    ...overrides,
  }
}

describe("GChordMachine", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("g then d fires the d action (both keys consumed)", () => {
    const d = vi.fn()
    const machine = new GChordMachine({ d })
    expect(machine.handleKey(key("g"))).toBe(true)
    expect(machine.isArmed).toBe(true)
    expect(machine.handleKey(key("d"))).toBe(true)
    expect(d).toHaveBeenCalledTimes(1)
    expect(machine.isArmed).toBe(false)
  })

  it("the window times out and disarms", () => {
    const d = vi.fn()
    const machine = new GChordMachine({ d }, 1500)
    machine.handleKey(key("g"))
    vi.advanceTimersByTime(1600)
    expect(machine.isArmed).toBe(false)
    expect(machine.handleKey(key("d"))).toBe(false)
    expect(d).not.toHaveBeenCalled()
  })

  it("g while typing does nothing", () => {
    const d = vi.fn()
    const machine = new GChordMachine({ d })
    expect(machine.handleKey(key("g", { isTyping: true }))).toBe(false)
    expect(machine.isArmed).toBe(false)
    expect(machine.handleKey(key("d"))).toBe(false)
    expect(d).not.toHaveBeenCalled()
  })

  it("g with a modifier held does nothing", () => {
    const machine = new GChordMachine({})
    expect(machine.handleKey(key("g", { metaKey: true }))).toBe(false)
    expect(machine.isArmed).toBe(false)
  })

  it("an unknown second key disarms without firing", () => {
    const d = vi.fn()
    const machine = new GChordMachine({ d })
    machine.handleKey(key("g"))
    expect(machine.handleKey(key("q"))).toBe(false)
    expect(machine.isArmed).toBe(false)
    // A later d is just a plain keypress.
    expect(machine.handleKey(key("d"))).toBe(false)
    expect(d).not.toHaveBeenCalled()
  })

  it("a second key already consumed upstream disarms without firing", () => {
    const d = vi.fn()
    const machine = new GChordMachine({ d })
    machine.handleKey(key("g"))
    expect(machine.handleKey(key("d", { defaultPrevented: true }))).toBe(false)
    expect(d).not.toHaveBeenCalled()
    expect(machine.isArmed).toBe(false)
  })

  it("g g restarts the window", () => {
    const d = vi.fn()
    const machine = new GChordMachine({ d }, 1500)
    machine.handleKey(key("g"))
    vi.advanceTimersByTime(1000)
    expect(machine.handleKey(key("g"))).toBe(true)
    vi.advanceTimersByTime(1000) // past the first window, inside the second
    expect(machine.isArmed).toBe(true)
    expect(machine.handleKey(key("d"))).toBe(true)
    expect(d).toHaveBeenCalledTimes(1)
  })
})
