import { describe, expect, it } from "vitest"
import { compareHlc, decodeHlc, encodeHlc, receiveHlc, tickHlc, type Hlc } from "./hlc"

const DEVICE = "8mteggg4.wulluf"
const OTHER = "zz000000.aaaaaa"
const T = 1792540800000

/** A small seeded generator, so a failure replays. */
function random(seed: number): () => number {
  let state = seed
  return () => {
    state = (state * 1103515245 + 12345) % 2 ** 31
    return state / 2 ** 31
  }
}

const sign = (n: number) => Math.sign(n)

describe("tickHlc", () => {
  it("starts at the clock with counter 0", () => {
    expect(tickHlc(null, T, DEVICE)).toEqual({ ms: T, counter: 0, device: DEVICE })
  })

  it("counts up inside one ms and starts over in the next", () => {
    const a = tickHlc(null, T, DEVICE)
    const b = tickHlc(a, T, DEVICE)
    const c = tickHlc(b, T + 5, DEVICE)
    expect([b.ms, b.counter]).toEqual([T, 1])
    expect([c.ms, c.counter]).toEqual([T + 5, 0])
  })

  it("gives rising stamps when the clock goes back", () => {
    const clock = [T, T + 10, T - 60_000, T - 60_000, T + 3, T + 11, T + 11]
    const stamps: Hlc[] = []
    for (const now of clock) stamps.push(tickHlc(stamps.at(-1) ?? null, now, DEVICE))
    for (let i = 1; i < stamps.length; i++) {
      expect(compareHlc(stamps[i], stamps[i - 1])).toBeGreaterThan(0)
    }
    expect(stamps[2]).toEqual({ ms: T + 10, counter: 1, device: DEVICE })
  })

  it("carries a full counter into the next ms", () => {
    const full: Hlc = { ms: T, counter: 0xffff, device: DEVICE }
    const next = tickHlc(full, T, DEVICE)
    expect(next).toEqual({ ms: T + 1, counter: 0, device: DEVICE })
    expect(compareHlc(next, full)).toBeGreaterThan(0)
  })
})

describe("receiveHlc", () => {
  it("moves the last stamp up to a higher pulled stamp", () => {
    const last = tickHlc(null, T, DEVICE)
    const remote: Hlc = { ms: T + 60_000, counter: 4, device: OTHER }
    expect(receiveHlc(last, remote)).toEqual(remote)
    expect(receiveHlc(null, remote)).toEqual(remote)
  })

  it("keeps the last stamp when the pulled one is lower", () => {
    const last = tickHlc(null, T, DEVICE)
    expect(receiveHlc(last, { ms: T - 1, counter: 9, device: OTHER })).toBe(last)
  })

  it("makes the next local stamp come after a pulled edit from a clock ahead", () => {
    const remote: Hlc = { ms: T + 60_000, counter: 4, device: OTHER }
    const next = tickHlc(receiveHlc(tickHlc(null, T, DEVICE), remote), T + 1, DEVICE)
    expect(next).toEqual({ ms: T + 60_000, counter: 5, device: DEVICE })
    expect(compareHlc(next, remote)).toBeGreaterThan(0)
  })
})

describe("encodeHlc and decodeHlc", () => {
  it("encodes at a fixed width", () => {
    expect(encodeHlc({ ms: T, counter: 3, device: DEVICE })).toBe(
      "001792540800000-0003-8mteggg4.wulluf",
    )
    expect(encodeHlc({ ms: 0, counter: 0xffff, device: "seq:12" })).toBe(
      "000000000000000-ffff-seq:12",
    )
  })

  it("round-trips", () => {
    const next = random(1)
    const devices = [DEVICE, OTHER, "seq:42", "server:mcp", "migration", "a-b-c"]
    for (let i = 0; i < 500; i++) {
      const stamp: Hlc = {
        ms: Math.floor(next() * 4e12),
        counter: Math.floor(next() * 0x10000),
        device: devices[Math.floor(next() * devices.length)],
      }
      expect(decodeHlc(encodeHlc(stamp))).toEqual(stamp)
    }
  })

  it("refuses what is not a stamp", () => {
    for (const bad of [
      "",
      "1792540800000-0003-x",
      "001792540800000-03-x",
      "001792540800000-0003-",
    ]) {
      expect(decodeHlc(bad)).toBeNull()
    }
    expect(decodeHlc("001792540800000-000G-x")).toBeNull()
    expect(() => encodeHlc({ ms: -1, counter: 0, device: DEVICE })).toThrow(RangeError)
    expect(() => encodeHlc({ ms: T, counter: 0x10000, device: DEVICE })).toThrow(RangeError)
    expect(() => encodeHlc({ ms: T, counter: 0, device: "" })).toThrow(RangeError)
  })
})

describe("compareHlc", () => {
  it("orders by ms, then counter, then device", () => {
    const base: Hlc = { ms: T, counter: 5, device: DEVICE }
    expect(compareHlc(base, { ...base })).toBe(0)
    expect(compareHlc(base, { ...base, ms: T + 1, counter: 0 })).toBeLessThan(0)
    expect(compareHlc(base, { ...base, counter: 6 })).toBeLessThan(0)
    expect(compareHlc(base, { ...base, device: OTHER })).toBeLessThan(0)
  })

  it("gives the same order as the encoded strings", () => {
    const next = random(7)
    const devices = [DEVICE, OTHER, "seq:9", "seq:10", "server:mcp", "migration"]
    const pick = (): Hlc => ({
      // Few distinct ms and counters, so the ties that reach the device happen.
      ms: T + Math.floor(next() * 3) * (next() < 0.5 ? 1 : 10 ** 12),
      counter: [0, 9, 10, 0xff, 0x100, 0xffff][Math.floor(next() * 6)],
      device: devices[Math.floor(next() * devices.length)],
    })
    for (let i = 0; i < 2000; i++) {
      const a = pick()
      const b = pick()
      const ea = encodeHlc(a)
      const eb = encodeHlc(b)
      expect(sign(compareHlc(a, b))).toBe(ea < eb ? -1 : ea > eb ? 1 : 0)
    }
  })
})
