# Habit reminders

A browser push when today's habits — the entries of the reader's trackers
(docs/trackers.md) — are not all logged by a time the reader chose.
Requested by Finn, 2026-11-02.

## The setting

**Settings → Preferences → Reminders** (`src/components/settings/reminders-section.tsx`,
drawn signed in only):

- **Remind me to log my habits**: on asks for notification permission,
  subscribes with `PushManager` using the server's VAPID public key, and
  saves the subscription with the time and the time zone. Off deletes the
  subscription on the server, then in the browser.
- **Time**: `HH:MM`, 20:00 by default, in 15-minute steps (the cron's step).
- **Time zone**: the browser's (`Intl.DateTimeFormat().resolvedOptions()`),
  stored with the subscription and shown. A change of time saves the
  browser's zone again.
- **Send a test reminder now**: runs the cron's check for the reader at once
  and sends the result to this device, even when every habit is logged (the
  body says "Test reminder."). Cron does not run on preview versions; this
  is how a preview is tested.

The setting is per device: a reminder belongs to a push subscription, and a
subscription to one browser. The browser half is `src/data/reminders.ts`.

On an iPhone a push reaches only a Home Screen app, on iOS 16.4 or later. In
Safari's tab the card says the browser cannot show reminders.

## Storage

`push_subscriptions` (migrations/0033), control plane, keyed by the push
service `endpoint`: `user_id`, the keys `p256dh` and `auth`, `reminder_time`,
`time_zone`, `last_sent_day` (the local day the reminder was last dealt
with: sent, or checked with nothing missing) and `next_due_at` (the UTC
instant the next one is due).

SQLite has no time zones, so the Worker works out `next_due_at`
(`worker/reminders/schedule.ts`) when a subscription is saved and after each
run. The cron's selection is then one seek on `push_subscriptions_due`.

## The cron

`*/15 * * * *` (wrangler.jsonc, `triggers`), the Worker's `scheduled`
handler, `worker/reminders/cron.ts`:

1. Select the subscriptions with `next_due_at <= now` (at most 200), not of
   a blocked account.
2. Check each against its own clock (`isDue`): the reminder time, rounded
   down to its quarter hour, has passed, and `last_sent_day` is not today.
   A row that is not due is moved to its next due instant.
3. For each reader and local day, read the habits once
   (`worker/reminders/habits.ts`) through a tenant handle minted for the
   subscription's owner (`forSubscriber`, worker/tenancy-db.ts).
4. When a habit is missing, send one push to each due subscription. A 404
   or 410 from the push service deletes the subscription.
5. Mark the day dealt with, sent or not, and store the next due instant.

Each run logs one line, `{"event":"habit_reminders", due, checked, sent,
gone, failed, rowsRead}`.

### What a missing habit is

A series of a live tracker (a child of the tracker whose props carry
`kind`) with nothing logged today: no entry of the day, an open to-do, or a
zero. That is `isLogged` of src/data/tracker.ts, the tracker page's own
question.

### The reads, and their cost

Both reads go through the cache of the log (`events_log_cache`,
docs/events-log-cache.md), and each is bounded by its question:

- **The series**: the live trackers on the `type` index, one hop down on the
  `source_id` index, then primary-key seeks for each child's `kind`, text
  and liveness.
- **Today's entries**: the live blocks whose text begins with today, on the
  partial index `events_log_cache_day_text` (migrations/0033), then one hop
  up on the `destination_id` index. The index holds only text that begins
  with a year. Its condition is on `substr(value, 1, 5)`, not on `value`:
  SQLite turns `value GLOB '"[0-9]…'` into the range `'"' <= value < '#'`
  and seeks on that instead of on the day, which read every entry of every
  day (2,962 rows for 6 on the bench below).

Measured on a local miniflare D1 (2026-11-02), a reader with two trackers of
four series, a year of entries each and 2,000 other blocks (44,502 cache
rows), with two devices due:

| run                               | rows read |
| --------------------------------- | --------- |
| 1 reader due (2 subscriptions)    | 118       |
| 10 readers due (20 subscriptions) | 1,198     |
| nothing due                       | 1         |

About 60 rows per subscription due, whatever the size of the corpus.

## Web Push

`worker/reminders/push.ts`, with `@block65/webcrypto-web-push`: VAPID
(RFC 8292) and aes128gcm (RFC 8291) on Web Crypto, so it runs on Workers
(Node's `web-push` does not). Apple's push service takes only aes128gcm.

The keys:

- `VAPID_PRIVATE_KEY`, a Worker secret: the private key as a P-256 JWK.
  `node scripts/vapid-keys.mjs` prints a new pair. Set it with
  `npx wrangler secret put VAPID_PRIVATE_KEY`. Never commit it.
- `VAPID_PUBLIC_KEY`, a wrangler var: the public key, base64url. Empty, the
  Worker derives it from the secret's `x` and `y`. Set, it must match the
  secret, or reminders stay off and the Worker logs `vapid_key_mismatch`.

Without the secret the cron does nothing and the card says reminders are not
set up on this server. A new key pair ends every subscription: each device
must turn reminders on again.

## The service worker

`src/sw.ts`, built by vite-plugin-pwa's `injectManifest` (vite.config.ts).
It keeps what the generated worker did: precache the build, drop old
caches, serve `index.html` for navigations, and wait for "Update Ruminate"
(SKIP_WAITING, registerType "prompt"). It adds `push`, which shows the
notification (title, the body naming the missing habits, one tag so a new
reminder replaces the old one), and `notificationclick`, which focuses an
open window of the app and opens the tracker of the first missing habit, or
opens a new window.
