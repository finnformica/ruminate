import { describe, expect, it } from "vitest"
import {
  dueMinutes,
  isDue,
  isTimeZone,
  localClock,
  nextDueAt,
  reminderMinutes,
  zonedInstant,
} from "./schedule"

const LONDON = "Europe/London"
const NEW_YORK = "America/New_York"
const at = (iso: string) => Date.parse(iso)

describe("the reminder time", () => {
  it("reads HH:MM on a 24-hour clock, and nothing else", () => {
    expect(reminderMinutes("20:00")).toBe(1200)
    expect(reminderMinutes("07:05")).toBe(425)
    expect(reminderMinutes("24:00")).toBeNull()
    expect(reminderMinutes("7:05")).toBeNull()
    expect(reminderMinutes("20:60")).toBeNull()
  })

  it("is due at the quarter hour at or before it, the cron's step", () => {
    expect(dueMinutes("20:00")).toBe(1200)
    expect(dueMinutes("20:14")).toBe(1200)
    expect(dueMinutes("23:50")).toBe(23 * 60 + 45)
  })

  it("knows a time zone from a name that is not one", () => {
    expect(isTimeZone(LONDON)).toBe(true)
    expect(isTimeZone("Mars/Olympus")).toBe(false)
    expect(isTimeZone("")).toBe(false)
  })
})

describe("the local clock", () => {
  it("gives the day and minute in the zone", () => {
    // 2026-11-02 04:30 UTC is still 1 November, 23:30, in New York.
    expect(localClock(at("2026-11-02T04:30:00Z"), NEW_YORK)).toEqual({
      day: "2026-11-01",
      minutes: 23 * 60 + 30,
    })
    expect(localClock(at("2026-07-01T19:00:00Z"), LONDON)).toEqual({
      day: "2026-07-01",
      minutes: 20 * 60,
    })
  })

  it("finds the instant a local time falls on, either side of a clock change", () => {
    // London is on GMT in winter and BST (UTC+1) in summer.
    expect(zonedInstant("2026-11-02", 1200, LONDON)).toBe(at("2026-11-02T20:00:00Z"))
    expect(zonedInstant("2026-07-01", 1200, LONDON)).toBe(at("2026-07-01T19:00:00Z"))
    // The day the clocks go back (25 October 2026): 20:00 is GMT again.
    expect(zonedInstant("2026-10-25", 1200, LONDON)).toBe(at("2026-10-25T20:00:00Z"))
    // A time the spring change skips lands on the first moment it has passed.
    expect(zonedInstant("2026-03-29", 90, LONDON)).toBe(at("2026-03-29T01:30:00Z"))
  })
})

describe("whether a reminder is due", () => {
  const schedule = { reminderTime: "20:00", timeZone: LONDON, lastSentDay: null }

  it("is due once its time has passed on the local clock", () => {
    expect(isDue(schedule, at("2026-11-02T19:59:00Z"))).toBe(false)
    expect(isDue(schedule, at("2026-11-02T20:00:00Z"))).toBe(true)
    expect(isDue(schedule, at("2026-11-02T23:59:00Z"))).toBe(true)
  })

  it("is not due again on a day already dealt with", () => {
    const dealt = { ...schedule, lastSentDay: "2026-11-02" }
    expect(isDue(dealt, at("2026-11-02T21:00:00Z"))).toBe(false)
    expect(isDue(dealt, at("2026-11-03T20:00:00Z"))).toBe(true)
  })

  it("reads 'today' on the subscription's own clock", () => {
    // 01:00 UTC on 3 November is 20:00 on 2 November in New York.
    const ny = { reminderTime: "20:00", timeZone: NEW_YORK, lastSentDay: "2026-11-01" }
    expect(isDue(ny, at("2026-11-03T01:00:00Z"))).toBe(true)
    expect(isDue({ ...ny, lastSentDay: "2026-11-02" }, at("2026-11-03T01:00:00Z"))).toBe(false)
  })
})

describe("the next due instant", () => {
  const schedule = { reminderTime: "20:00", timeZone: LONDON, lastSentDay: null }

  it("is today's reminder while today's is not dealt with", () => {
    expect(nextDueAt(schedule, at("2026-11-02T09:00:00Z"))).toBe(at("2026-11-02T20:00:00Z"))
    // Past already: in the past, so the next run picks it up.
    expect(nextDueAt(schedule, at("2026-11-02T21:00:00Z"))).toBe(at("2026-11-02T20:00:00Z"))
  })

  it("is tomorrow's once today's is dealt with", () => {
    const dealt = { ...schedule, lastSentDay: "2026-11-02" }
    expect(nextDueAt(dealt, at("2026-11-02T20:05:00Z"))).toBe(at("2026-11-03T20:00:00Z"))
  })

  it("agrees with isDue: a reminder is due exactly from its next due instant", () => {
    const next = nextDueAt(schedule, at("2026-11-02T09:00:00Z"))
    expect(isDue(schedule, next - 60_000)).toBe(false)
    expect(isDue(schedule, next)).toBe(true)
  })
})
