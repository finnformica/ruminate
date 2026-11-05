# Habit reminders

A browser push when today's habits — the entries of the reader's trackers
(docs/trackers.md) — are not all logged by a time the reader chose.
Requested by Finn, 2026-11-02.

## The setting

**Settings → Notifications → Reminders** (`/settings/notifications`; the
card is `src/components/settings/reminders-section.tsx`, drawn signed in
only). Finn, 2026-11-04: a page of its own, and the app's own controls
rather than native form fields (`Switch` and `Select` in
`src/components/ui/`, the shadcn components on Base UI).

- **Remind me to log my habits** (a `Switch`): on asks for notification
  permission, subscribes with `PushManager` using the server's VAPID public
  key, and saves the subscription with the time and the time zone. Off
  deletes the subscription on the server, then in the browser.
- **Time** (a `Select`): every quarter hour from 00:00 to 23:45, 20:00 by
  default. The cron runs on the quarter hour. A change saves at once.
- **Send a test reminder now** (a `Button`): runs the cron's check for the
  reader at once and sends the result to every device of the reader, even
  when every habit is logged (the body says "Test reminder."). Cron does not
  run on preview versions; this is how a preview is tested. The toast says
  what each push service answered: "Sent to 2 devices.", or "Sent to 1 of 2
  devices. This browser: 403 VAPID key refused." A device other than this
  browser is named by its push service's host. A gone device (404 or 410)
  is deleted; when it is this browser, the switch turns off.

**The time zone is not shown.** The push comes from the Worker's cron, not
from the device, so the server must know which zone the reader's 20:00 is
in. Every save sends the browser's zone
(`Intl.DateTimeFormat().resolvedOptions().timeZone`). When the card loads
and the browser's zone is not the stored one (a trip, a new clock), it
saves the same time again with the new zone and says nothing.

The setting is per device: a reminder belongs to a push subscription, and a
subscription to one browser. The browser half is `src/data/reminders.ts`.

On an iPhone a push reaches only a Home Screen app, on iOS 16.4 or later. In
Safari's tab the card says the browser cannot show reminders.

### When a step fails

Each failure is a `ReminderError` with a `reason` (`src/data/reminders.ts`),
and the card shows one line for it. The card also writes the error and the
browser's own error (its `cause`) to the console, with `Habit reminders:`.

| `reason`          | When                                                                   |
| ----------------- | ---------------------------------------------------------------------- |
| `dismissed`       | The permission prompt was closed (`default`)                           |
| `denied`          | Notifications are blocked, or `subscribe` threw `NotAllowedError`      |
| `push-blocked`    | `subscribe` threw `AbortError`: the push service refused or is off     |
| `worker-outdated` | `subscribe` threw `InvalidStateError`, or failed with a worker waiting |
| `worker-missing`  | No service worker was ready in 10 seconds                              |
| `rejected`        | The server answered an error; the line shows its status and code       |
| `signed-out`      | A 401, or the session could not be refreshed                           |
| `offline`         | `fetch` threw: the request did not reach the server                    |
| `failed`          | Anything else; the line shows the error's name                         |

Brave's `AbortError` ("Registration failed - push service error") is the
usual desktop case: Brave has push off until **Use Google services for push
messaging** is on in `brave://settings/privacy`. In Brave (`navigator.brave`)
the `push-blocked` line names that setting.

Each push that fails is logged by the Worker as `push_failed`, with the push
service's host, its status, the reason and the start of its answer, never
the whole endpoint (`worker/reminders/push.ts`).

The server takes an endpoint of up to 2048 characters: Edge's endpoint is a
Windows (WNS) channel URI, which can be that long.

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
   or 410 from the push service deletes the subscription. When every habit
   is logged, send nothing (the test "sends nothing to a reader with every
   habit logged"). Only the test button sends with nothing missing.
5. Mark the day dealt with, sent or not, and store the next due instant.

Each run logs one line, `{"event":"habit_reminders", due, checked, sent,
gone, failed, rowsRead}`.

### What a missing habit is

A series to keep (`goal: do`, the default) of a live tracker with nothing
logged today: no entry of the day, an open to-do, or a zero. A series is a
child of the tracker whose props carry `kind`. That is `isLogged` of
src/data/tracker.ts, the tracker page's own question. A series to avoid
(`goal: avoid`, docs/trackers.md) is never missing: a logged day is a slip
there, and an empty day is a clean one.

### The reads, and their cost

Both reads go through the cache of the log, `events_log_cache`
(docs/events-log-cache.md), the way the Worker's other readers do
(`worker/handlers/cache-reads.ts`, `worker/mcp/graph-load.ts`): hops on the
`source_id` and `destination_id` indexes, child links named by
`GLOB '*|child'`, and liveness from the `deleted` key. Each read is bounded
by its question:

- **The series**: the live trackers on the `type` index, one hop down on
  the `source_id` index, then primary-key seeks for each child's `kind`,
  `goal`, text and liveness.
- **Today's entries**: the live blocks whose text begins with today, on the
  partial index `events_log_cache_day_text` (migrations/0033), then one hop
  up on the `destination_id` index. The index holds only text that begins
  with a year. Its condition is on `substr(value, 1, 5)`, not on `value`:
  SQLite turns `value GLOB '"[0-9]…'` into the range `'"' <= value < '#'`
  and seeks on that instead of on the day, which reads every entry of every
  day.

Neither read is a compound SELECT.

Measured on a local miniflare D1 (2026-11-03, main with #310). Each reader
has two trackers of four series, a year of entries in each, and 2,000
other blocks (4,956 blocks each). Each reader has two devices due.

| run                              | blocks | rows read |
| -------------------------------- | ------ | --------- |
| 1 reader due (2 subscriptions)   | 4,956  | 118       |
| 5 readers due (10 subscriptions) | 24,780 | 598       |
| nothing due                      | 24,780 | 1         |

About 120 rows per reader due, whatever the size of the corpus. The cache
holds one row per key, so each block and link is a few seeks rather than
one.

## The message

`worker/reminders/message.ts`. Finn, 2026-11-04: plain and clear about what
is missing, with the app's name as the only title.

| case                      | title    | body                                                                 |
| ------------------------- | -------- | -------------------------------------------------------------------- |
| 1 missing                 | Ruminate | Not logged yet: Run.                                                 |
| 3 missing                 | Ruminate | Not logged yet: Run, Read and Walk.                                  |
| 7 missing                 | Ruminate | Not logged yet: Run, Read, Walk, Swim, Stretch and 2 more.           |
| test button, none missing | Ruminate | Test reminder. All habits for today are logged.                      |
| test button, no habits    | Ruminate | Test reminder. You have no habits to log. Add a series to a tracker. |

The list names five habits, then counts the rest. A tap opens the tracker
of the first missing habit.

### The title on each platform

Checked 2026-11-04. Finn's iPhone (a Home Screen web app) showed the old
title, "Today's habits", with "from Ruminate" under it.

- **iOS and iPadOS 16.4+, Home Screen web app**: iOS shows the title, then
  a line "from <name>", where the name is the app's name on the Home
  Screen. Nothing in the payload removes that line
  ([Progressier](https://intercom.help/progressier/en/articles/13421891-can-i-remove-the-from-app-name-line-from-pwa-push-notifications)).
  The line is in English on every device language
  ([Progressier](https://intercom.help/progressier/en/articles/12646294-the-from-string-in-pwa-ios-push-notifications-isn-t-properly-localized)).
  A title equal to the app name is reported to show the name twice
  ([borso.fr #243](https://github.com/hugoleborso/borso.fr/pull/243)).
  WebKit says only that the notifications work as other apps' do
  ([WebKit blog](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)).
- **An empty title**: the spec allows `""` (`showNotification`'s title is a
  required DOMString with no check for empty,
  [Notifications API](https://notifications.spec.whatwg.org/)). No source
  measures what iOS shows for it. Native iOS apps without a title show the
  app name, but that is APNs, not Web Push
  ([phonegap-plugin-push #1282](https://github.com/phonegap/phonegap-plugin-push/issues/1282)).
- **Chrome, Android and desktop**: the title shows as sent, with the site
  or the installed app's name as Chrome's own label
  ([web.dev](https://web.dev/articles/push-notifications-display-a-notification)).
  An empty title there is not documented and can show a blank first line.

So no title is known to give just "Ruminate" once on iOS. The title is
`Ruminate`: correct on Chrome, and the best known value on iOS. On an
iPhone expect:

> **Ruminate**
> from Ruminate
> Not logged yet: Run, Read and Walk.

To try an empty title, change `TITLE` in `message.ts` to `""`, deploy a
preview, and press **Send a test reminder now** on an iPhone. The service
worker keeps an empty title as sent (`src/sw.ts` falls back to "Ruminate"
only when the payload has no title).

## Web Push

`worker/reminders/push.ts`, with `@block65/webcrypto-web-push`: VAPID
(RFC 8292) and aes128gcm (RFC 8291) on Web Crypto, so it runs on Workers
(Node's `web-push` does not). Apple's push service takes only aes128gcm.

The keys are set, both in base64url, in the format of web-push's
`generateVAPIDKeys`:

- `VAPID_PRIVATE_KEY`, a Worker secret, already set on the `ruminate`
  Worker: the raw P-256 private scalar `d` (32 bytes). Never commit it.
- `VAPID_PUBLIC_KEY`, a wrangler var in `vars` and `previews.vars`: the
  uncompressed public point (65 bytes). The browser subscribes with it
  (`GET /api/reminders` hands it to the settings card).

The Worker checks once per isolate that the two are one pair (it signs with
the secret and verifies with the var). A missing key, a malformed one or a
pair that does not match turns reminders off: the cron does nothing, the
Worker logs `vapid_key_mismatch` for a wrong pair, and the card says
reminders are not set up on this server.

The VAPID subject (the JWT's `sub`) is the app's production address,
`https://ruminate.finnformica.workers.dev`.

To rotate the pair (optional, never a setup step), run
`node scripts/vapid-keys.mjs`, put the public key in wrangler.jsonc and set
the private key with `npx wrangler secret put VAPID_PRIVATE_KEY`. A new pair
ends every subscription: each device must turn reminders on again.

## The service worker

`src/sw.ts`, built by vite-plugin-pwa's `injectManifest` (vite.config.ts).
It keeps what the generated worker did: precache the build, drop old
caches, serve `index.html` for navigations, and wait for "Update Ruminate"
(SKIP_WAITING, registerType "prompt"). It adds `push`, which shows the
notification (title, the body naming the missing habits, one tag so a new
reminder replaces the old one), and `notificationclick`, which focuses an
open window of the app and opens the tracker of the first missing habit, or
opens a new window.
