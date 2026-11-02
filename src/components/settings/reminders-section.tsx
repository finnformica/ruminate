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
  saveReminderTime,
  sendTestReminder,
  type ReminderFailure,
} from "../../data/reminders"
import type { ReminderSettings } from "../../data/reminders-api"
import { usePending } from "../../hooks/pending"
import { AsyncButton } from "../ui/async-button"
import { Checkbox } from "../ui/checkbox"
import { TextInput } from "../ui/text-input"
import { SettingsSection } from "../settings-section"

/** What the card says when a step fails. */
const FAILURE: Record<ReminderFailure, string> = {
  unsupported: "This browser can't show reminders. On an iPhone, add Ruminate to the Home Screen.",
  denied: "Notifications are blocked for Ruminate. Allow them in the browser's settings.",
  "not-configured": "Reminders aren't set up on this server yet.",
  failed: "Couldn't save that — check your connection and try again.",
}

const failureOf = (error: unknown): ReminderFailure =>
  error instanceof ReminderError ? error.reason : "failed"

/**
 * Habit reminders (docs/reminders.md): a push on this device when today's
 * habits are not all logged by the time chosen here. Per device, as a push
 * subscription is. Labels and nothing under them (docs/settings.md); a line
 * appears only to say why something did not work.
 */
export function RemindersSection() {
  const [loaded, setLoaded] = useState(false)
  const [reminder, setReminder] = useState<ReminderSettings | null>(null)
  const [time, setTime] = useState(DEFAULT_REMINDER_TIME)
  const [failure, setFailure] = useState<ReminderFailure | null>(null)

  useEffect(() => {
    let live = true
    loadReminder()
      .then(({ configured, reminder: held }) => {
        if (!live) return
        setReminder(held)
        if (held) setTime(held.reminderTime)
        if (!configured) setFailure("not-configured")
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
    if (!reminder || next === reminder.reminderTime || !/^\d{2}:\d{2}$/.test(next)) return
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
      <div className="flex items-center gap-2 leading-4">
        <Checkbox
          id="habit-reminders"
          checked={on}
          disabled={!loaded || toggling || !supported}
          onCheckedChange={(checked) => toggle(checked)}
        />
        <label htmlFor="habit-reminders" className="cursor-pointer">
          Remind me to log my habits
        </label>
      </div>
      <div className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-3">
        <label htmlFor="habit-reminder-time">Time</label>
        <TextInput
          id="habit-reminder-time"
          type="time"
          step={900}
          className="w-32"
          value={time}
          disabled={savingTime || toggling}
          onChange={(event) => setTime(event.target.value)}
          onBlur={() => saveTime(time)}
        />
        <span>Time zone</span>
        <span className="text-text-secondary">{reminder?.timeZone ?? deviceTimeZone()}</span>
      </div>
      {on ? (
        <div>
          <AsyncButton onClick={test}>Send a test reminder now</AsyncButton>
        </div>
      ) : null}
      {!supported ? (
        <span className="text-sm leading-4 text-text-danger">{FAILURE.unsupported}</span>
      ) : failure ? (
        <span className="text-sm leading-4 text-text-danger">{FAILURE[failure]}</span>
      ) : null}
    </SettingsSection>
  )
}
