// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ReminderSettings } from "../../data/reminders-api"

/** The reminders card (docs/reminders.md) on the Notifications page: the
 * app's own controls, no time zone on screen, and the stored zone kept in
 * step with the browser's. The browser half (`src/data/reminders.ts`) is
 * stubbed: jsdom has no push service. */

const api = vi.hoisted(() => ({
  loadReminder: vi.fn(),
  saveReminderTime: vi.fn(),
  deviceTimeZone: vi.fn(() => "Europe/London"),
}))

vi.mock("../../data/reminders", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../data/reminders")>()),
  loadReminder: api.loadReminder,
  saveReminderTime: api.saveReminderTime,
  deviceTimeZone: api.deviceTimeZone,
  pushSupported: () => true,
}))

const { RemindersSection } = await import("./reminders-section")

const held = (timeZone: string): ReminderSettings => ({
  reminderTime: "20:00",
  timeZone,
  lastSentDay: null,
})

beforeEach(() => {
  api.loadReminder.mockReset()
  api.saveReminderTime.mockReset()
})

afterEach(() => cleanup())

describe("the reminders card", () => {
  it("draws a switch and a select, with no native form field and no time zone", async () => {
    api.loadReminder.mockResolvedValue({ configured: true, reminder: held("Europe/London") })
    const { container } = render(<RemindersSection />)
    await waitFor(() =>
      expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("true"),
    )
    expect(screen.getByRole("combobox").textContent).toContain("20:00")
    expect(screen.getByRole("button", { name: "Send a test reminder now" })).toBeTruthy()
    // Base UI keeps a hidden input for forms; no field is drawn natively.
    const visible = [...container.querySelectorAll("input, select, textarea")].filter(
      (element) =>
        !(element as HTMLInputElement).hidden && element.getAttribute("aria-hidden") !== "true",
    )
    expect(visible).toEqual([])
    expect(container.textContent).not.toMatch(/time zone|Europe\/London/i)
  })

  it("saves the browser's zone again, silently, when it differs from the stored one", async () => {
    api.loadReminder.mockResolvedValue({ configured: true, reminder: held("America/New_York") })
    api.saveReminderTime.mockResolvedValue(held("Europe/London"))
    render(<RemindersSection />)
    await waitFor(() => expect(api.saveReminderTime).toHaveBeenCalledWith("20:00"))
    expect(api.saveReminderTime).toHaveBeenCalledTimes(1)
  })

  it("saves nothing on load when the zone is the same", async () => {
    api.loadReminder.mockResolvedValue({ configured: true, reminder: held("Europe/London") })
    render(<RemindersSection />)
    await waitFor(() =>
      expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("true"),
    )
    expect(api.saveReminderTime).not.toHaveBeenCalled()
  })
})
