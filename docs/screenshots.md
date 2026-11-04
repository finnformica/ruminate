# Screenshots

Shots mode shows the app **signed in, with data**, for screenshots of the
signed-in pages (Settings, a tracker, a note). Only the Vite dev server runs.
There is no Worker and no database. A mock layer in the browser
(`src/shots/`) answers every API call from a fixture set, and a fixed user is
the signed-in session.

Requested by Finn, 2026-11-04.

## Take shots

1. Start the server in the background:

   ```bash
   npm run shots:serve > /tmp/shots.log 2>&1 &
   ```

2. Wait for the ready line. It gives the time and the URL:

   ```bash
   until grep -q "shots: ready" /tmp/shots.log; do sleep 2; done; grep "shots: ready" /tmp/shots.log
   ```

3. Take each page at the desktop size and at the phone size:

   ```bash
   orca-shot http://127.0.0.1:4791/settings/account --viewport 1440x900 --wait 15000
   orca-shot http://127.0.0.1:4791/settings/account --viewport 390x844 --wait 15000
   ```

4. Look for gaps. A request the mock layer cannot answer shows in red in
   `/tmp/shots.log` as `[shots] UNMOCKED <method> <path>`, and in the
   browser console (`orca-shot --console`). Add the route to
   `src/shots/mock-api.ts`.

5. Stop the server:

   ```bash
   pkill -f "vite --mode shots"
   ```

The port is 4791. Give `--port <n>` to use another one.

Each shot is a new browser. It opens its local store and pulls the whole
fixture log before the notes draw, which takes 10 to 15 seconds. So give
every shot `--wait 15000`. A shot with grey bars in place of the notes was
taken too early.

## Pages

| Page             | Path                                         |
| ---------------- | -------------------------------------------- |
| The notes page   | `/`                                          |
| A demo note      | `/notes/blk_d0000000t8` ("Garden plan 2027") |
| The demo tracker | `/trackers/blk_d000000000` ("Habits")        |
| Settings         | `/settings`, `/settings/<page>`              |
| The calendar     | `/calendar`                                  |

The demo ids are fixed. Find one with
`grep -o '"entity_id":"blk_d[0-9a-z]*","action":"set","key":"text","value":"Habits"' shots/demo/fixtures.json`.

## Data sets

`--data` picks the set. `demo` is the default.

- **demo** (`shots/demo/fixtures.json`, committed): a made-up account,
  "Sam Rivera". It has seven notes with nested blocks, a tracker with a year
  of daily entries in four series, a pinned note, a note shared by another
  user, a share given, an MCP token and a habit reminder.
  `scripts/shots-demo.ts` makes it. To add content, edit that script and run
  `npm run shots:demo`. The mock layer moves the dates forward to today, so
  the tracker always ends today.
- **profile**: a real user's data, from a SQLite copy of production D1.
  **This is private data.** See below.

## Profile data

finnformica/ruminate is a public repo, and Orca posts PR screenshots in the
public PR body. So:

- Never commit profile fixtures, or copy them into the repo.
- Never put a profile shot in a PR, a commit or a public comment. Keep it for
  local checks, and for Finn in the Orca chat only.

Make the fixtures once. This reads the copy as a file, with no server:

```bash
npm run shots:profile -- --db /home/orca/ruminate-prod-clone/ruminate-prod-20261030.sqlite
```

The script writes `/home/orca/ruminate-prod-clone/fixtures/fixtures.json`
with mode 600. It refuses an `--out` inside the repo, and it prints counts,
never rows. It leaves out received shares, because they hold other people's
notes.

Then serve it. The server prints a warning:

```bash
npm run shots:serve -- --data profile --fixtures /home/orca/ruminate-prod-clone/fixtures
```

## How it works

- `scripts/shots-vite-plugin.ts` is in `vite.config.ts`, but it applies only
  to `vite serve --mode shots`. It puts the user and `src/shots/install.ts`
  at the top of `index.html`, serves the fixture file at
  `/__shots/fixtures.json`, and prints the gaps the browser posts to
  `/__shots/log`.
- `src/shots/install.ts` runs before the app. It writes the user as the
  stored GitHub session, replaces `window.fetch` for the app's routes, and
  gives the browser a fixed push subscription.
- `src/shots/mock-api.ts` answers each route. The replica routes fold the
  cache from the fixture log with the app's own fold (`foldEventsToCache`).
  Writes answer success and change nothing.

### Safety

The mock layer must never reach a real user:

- A build never applies the plugin, in any mode. The production build and
  the PR previews are `vite build`.
- `src/shots/bundle-guard.test.ts` fails if the build, the deploy or the
  preview scripts ask for shots mode, if an app module imports `src/shots/`,
  or if the bundle in `dist/` holds the mock layer. The CI build job runs it
  after `npm run build`.
