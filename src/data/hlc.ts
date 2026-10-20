// The stamp every event will carry (docs/event-only-sync.md, The stamp): a
// hybrid logical clock. It is the writer's wall clock in ms, a counter that
// breaks a tie inside one ms, and the writer's device. A conflict resolves by
// the stamp, so a device that has seen an edit must always stamp after it,
// even when its own clock is behind.
//
// Pure: the caller gives the clock and the device, and keeps the last stamp.

export interface Hlc {
  /** Wall-clock ms, never less than the highest stamp the device has seen. */
  ms: number
  /** Breaks a tie inside one ms. */
  counter: number
  /** `<device>.<tab>` (`writerDevice`), or a derived name such as `seq:<seq>`. */
  device: string
}

const MS_DIGITS = 15
const COUNTER_DIGITS = 4
const MAX_MS = 10 ** MS_DIGITS - 1
const MAX_COUNTER = 16 ** COUNTER_DIGITS - 1
const ENCODED = /^(\d{15})-([0-9a-f]{4})-(.+)$/s

/** One string, fixed width, so two stamps compare as strings: `ms` as 15
 * decimal digits, `counter` as 4 lowercase hex digits, then the device. */
export function encodeHlc({ ms, counter, device }: Hlc): string {
  if (!Number.isSafeInteger(ms) || ms < 0 || ms > MAX_MS) {
    throw new RangeError(`HLC ms out of range: ${ms}`)
  }
  if (!Number.isInteger(counter) || counter < 0 || counter > MAX_COUNTER) {
    throw new RangeError(`HLC counter out of range: ${counter}`)
  }
  if (device === "") throw new RangeError("HLC device is empty")
  return [
    String(ms).padStart(MS_DIGITS, "0"),
    counter.toString(16).padStart(COUNTER_DIGITS, "0"),
    device,
  ].join("-")
}

/** The stamp an encoded string holds, or null when it is not one. The device
 * is everything after the second `-`, so a device may hold a `-` itself. */
export function decodeHlc(encoded: string): Hlc | null {
  const match = ENCODED.exec(encoded)
  if (match === null) return null
  return { ms: Number(match[1]), counter: parseInt(match[2], 16), device: match[3] }
}

/** Negative, zero or positive as `a` is before, equal to or after `b`: by
 * `ms`, then `counter`, then the device by code unit, the same order as the
 * encoded strings. */
export function compareHlc(a: Hlc, b: Hlc): number {
  if (a.ms !== b.ms) return a.ms < b.ms ? -1 : 1
  if (a.counter !== b.counter) return a.counter < b.counter ? -1 : 1
  if (a.device === b.device) return 0
  return a.device < b.device ? -1 : 1
}

/** The stamp for a local event: `ms = max(now, last.ms)`, and the counter one
 * past the last when the ms is the same, else 0. A counter past its 4 digits
 * carries into the next ms, so the stamp keeps its width and still rises. */
export function tickHlc(last: Hlc | null, now: number, device: string): Hlc {
  const ms = Math.max(Math.floor(now), last?.ms ?? 0)
  if (last === null || ms !== last.ms) return { ms, counter: 0, device }
  if (last.counter < MAX_COUNTER) return { ms, counter: last.counter + 1, device }
  return { ms: ms + 1, counter: 0, device }
}

/** The device's last stamp after a pulled event: moved up to the event's
 * stamp when that is higher, else unchanged. The next `tickHlc` then stamps
 * after it. */
export function receiveHlc(last: Hlc | null, remote: Hlc): Hlc {
  return last === null || compareHlc(remote, last) > 0 ? remote : last
}
