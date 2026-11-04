-- Migration number: 0033    2026-11-02
--
-- Habit reminders (docs/reminders.md): a browser push when the day's
-- habits — the tracker entries of today (docs/trackers.md) — are not all
-- logged by a time the reader chose. Requested by Finn, 2026-11-02.
--
-- ## push_subscriptions
--
-- One row per push subscription: a browser on a device that said yes,
-- named by its push service `endpoint` (unique per subscription, so it is
-- the key; a second account signed in on the same browser takes the row
-- over). `p256dh` and `auth` are the subscription's keys, which the
-- payload is encrypted to (RFC 8291). The reminder is `reminder_time`
-- (`HH:MM`, local) in `time_zone` (an IANA name, from the browser's
-- `Intl.DateTimeFormat`).
--
-- `last_sent_day` is the local day (`YYYY-MM-DD`) the reminder was last
-- dealt with: sent, or checked with nothing missing. `next_due_at` is the
-- UTC instant (ms) the next one is due, worked out in the Worker from the
-- time zone (SQLite has no time zones), so the cron's selection is one
-- seek on `push_subscriptions_due` and reads only the rows that are due.
--
-- Control plane, like mcp_tokens (0007): D1 only, not part of the browser's
-- ladder, reached through `controlPlaneDriver`. The user id is a verified
-- GitHub id, written by a signed-in session.

CREATE TABLE push_subscriptions (
  endpoint      TEXT PRIMARY KEY,
  user_id       INTEGER NOT NULL,
  p256dh        TEXT NOT NULL,
  auth          TEXT NOT NULL,
  reminder_time TEXT NOT NULL DEFAULT '20:00'
                CHECK (reminder_time GLOB '[0-2][0-9]:[0-5][0-9]'),
  time_zone     TEXT NOT NULL,
  last_sent_day TEXT,
  next_due_at   INTEGER NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE INDEX push_subscriptions_due ON push_subscriptions (next_due_at);
CREATE INDEX push_subscriptions_user ON push_subscriptions (user_id);

-- Today's tracker entries, by their text: an entry's text begins with its
-- day (`"2026-11-02"`, `"2026-11-02 · 5 km"`, as JSON), so a range on this
-- index finds one day's entries in a corpus with one seek. Partial, on
-- text that begins with a year only, so an ordinary block's text costs no
-- index write. A query uses it only when it repeats the condition word for
-- word (worker/reminders/habits.ts). The condition is on `substr(value…)`,
-- not on `value` itself: SQLite turns `value GLOB '"[0-9]…'` into the range
-- `'"' <= value < '#'` and then seeks on that range, which is every entry
-- of every day, rather than on the day the query names. The other partial
-- lookup indexes of the cache are 0032's and 0034's.
CREATE INDEX events_log_cache_day_text ON events_log_cache (user_id, value)
  WHERE key = 'text' AND substr(value, 1, 5) GLOB '"[0-9][0-9][0-9][0-9]';
