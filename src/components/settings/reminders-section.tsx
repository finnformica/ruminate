import { useEffect, useState } from "react"
import { toast } from "sonner"
import {
  DEFAULT_REMINDER_TIME,
  ReminderError,
  deviceTimeZone,
  disableReminders,
  enableReminders,
  loadReminder,
  pushSupported,
  reminderErrorOf,
  saveReminderTime,
  sendTestReminder,
  type ReminderFailure,
} from "../../data/reminders"
import type { ReminderSettings } from "../../data/reminders-api"
import { usePending } from "../../hooks/pending"
import { AsyncButton } from "../ui/async-button"
import { Select, type SelectOption } from "../ui/select"
import { Switch } from "../ui/switch"
import { SettingsSection } from "../settings-section"

/** What the card says when a step fails; `detail` is the server's status
 * for "rejected" and the error's name for "failed". */
const FAILURE: Record<ReminderFailure, (detail?: string) => string> = {
  unsupported: () =>
    "This browser can't show reminders. On an iPhone, add Ruminate to the Home Screen.",
  denied: () => "Notifications are blocked for Ruminate. Allow them in the browser's settings.",
  dismissed: () => "Choose Allow when the browser asks to show notifications.",
  "not-configured": () => "Reminders aren't set up on this server yet.",
  "push-blocked": () =>
    "The browser's push service refused. In Brave, turn on Use Google services for push messaging in Settings, then try again.",
  "worker-missing": () => "Ruminate's service worker isn't running. Reload the page and try again.",
  "worker-outdated": () =>
    "This tab runs an older Ruminate. Choose Update Ruminate, then try again.",
  unsubscribed: () => "This device's subscription has ended. Turn reminders on again.",
  "signed-out": () => "Your sign-in has ended. Sign in again and try again.",
  rejected: (detail) => `The server refused to save this device (${detail}).`,
  offline: () => "Couldn't save that — check your connection and try again.",
  failed: (detail) => `Couldn't save that (${detail}). Try again.`,
}

/** The failure to show, with the cause written to the console: the card
 * shows a reason, the console keeps the browser's own error. */
function failureOf(error: unknown): ReminderError {
  const failure = reminderErrorOf(error)
  console.error("Habit reminders:", failure, failure.cause ?? "")
  return failure
}

const pad2 = (n: number) => String(n).padStart(2, "0")

/** Every quarter hour of the day, 00:00 to 23:45: the cron's step
 * (worker/reminders/schedule.ts). */
const QUARTER_HOURS: readonly SelectOption[] = Array.from({ length: 96 }, (_, at) => {
  const time = `${pad2(Math.floor(at / 4))}:${pad2((at % 4) * 15)}`
  return { value: time, label: time }
})

/** The choices, with a stored time that is not on a quarter hour (saved
 * before the list) kept among them so the field shows it. */
function timeOptions(time: string): readonly SelectOption[] {
  if (QUARTER_HOURS.some((option) => option.value === time)) return QUARTER_HOURS
  return [...QUARTER_HOURS, { value: time, label: time }].sort((a, b) =>
    a.value.localeCompare(b.value),
  )
}

/**
 * Habit reminders (docs/reminders.md), on the Notifications page: a push on
 * this device when today's habits are not all logged by the time chosen
 * here. Per device, as a push subscription is. Labels and nothing under
 * them (docs/settings.md); a line appears only to say why something did not
 * work.
 *
 * The time zone is not shown. The Worker's cron sends the push, not the
 * device, so the server holds the zone the time is in: every save sends the
 * browser's (src/data/reminders.ts), and on load a zone that differs from
 * the stored one is saved again, with no word to the reader.
 */
export function RemindersSection() {
  const [loaded, setLoaded] = useState(false)
  const [reminder, setReminder] = useState<ReminderSettings | null>(null)
  const [time, setTime] = useState(DEFAULT_REMINDER_TIME)
  const [failure, setFailure] = useState<ReminderError | null>(null)

  useEffect(() => {
    let live = true
    loadReminder()
      .then(({ configured, reminder: held }) => {
        if (!live) return
        setReminder(held)
        if (held) setTime(held.reminderTime)
        if (!configured) setFailure(new ReminderError("not-configured"))
        // The browser moved to another zone (a trip, a new device clock):
        // keep the server's copy in step. A failure here changes nothing the
        // reader sees; the next save tries again.
        if (held && configured && held.timeZone !== deviceTimeZone()) {
          saveReminderTime(held.reminderTime)
            .then((saved) => live && setReminder(saved))
            .catch(() => {})
        }
      })
      .catch((error: unknown) => live && setFailure(failureOf(error)))
      .finally(() => live && setLoaded(true))
    return () => {
      live = false
    }
  }, [])

  const [toggle, toggling] = usePending(async (on: boolean) => {
    setFailure(null)
    try {
      if (on) setReminder(await enableReminders(time))
      else {
        await disableReminders()
        setReminder(null)
      }
    } catch (error) {
      setFailure(failureOf(error))
    }
  })

  const [saveTime, savingTime] = usePending(async (next: string) => {
    setTime(next)
    if (!reminder || next === reminder.reminderTime) return
    setFailure(null)
    try {
      setReminder(await saveReminderTime(next))
    } catch (error) {
      setFailure(failureOf(error))
      setTime(reminder.reminderTime)
    }
  })

  const test = async () => {
    setFailure(null)
    try {
      const result = await sendTestReminder()
      if (result.outcome === "sent") toast.success("Test reminder sent.")
      else if (result.outcome === "gone") {
        setReminder(null)
        toast.error("This device's subscription has ended. Turn reminders on again.")
      } else toast.error(`The push service refused the reminder (${result.status}).`)
    } catch (error) {
      setFailure(failureOf(error))
    }
  }

  const supported = pushSupported()
  const on = reminder !== null

  return (
    <SettingsSection title="Reminders">
      <div className="flex items-center gap-3 leading-4">
        <Switch
          id="habit-reminders"
          checked={on}
          disabled={!loaded || toggling || !supported}
          onCheckedChange={(checked) => toggle(checked)}
        />
        <label htmlFor="habit-reminders" className="cursor-pointer">
          Remind me to log my habits
        </label>
      </div>
      <div className="flex items-center gap-4">
        <label htmlFor="habit-reminder-time">Time</label>
        <Select
          id="habit-reminder-time"
          className="w-32"
          value={time}
          onValueChange={(next) => saveTime(next)}
          options={timeOptions(time)}
          disabled={savingTime || toggling}
        />
      </div>
      {on ? (
        <div>
          <AsyncButton onClick={test}>Send a test reminder now</AsyncButton>
        </div>
      ) : null}
      {!supported ? (
        <span className="text-sm leading-4 text-text-danger">{FAILURE.unsupported()}</span>
      ) : failure ? (
        <span className="text-sm leading-4 text-text-danger">
          {FAILURE[failure.reason](failure.detail)}
        </span>
      ) : null}
    </SettingsSection>
  )
}
