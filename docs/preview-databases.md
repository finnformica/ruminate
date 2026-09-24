# Preview databases

Every pull request's preview runs against a clone of the production database,
migrated with the branch's migrations. This document is what happens on each
push, how a clone is torn down, what a change to `migrations/` does, and the
one-time setup the account needs.

## The problem it solves

Workers Builds previews a branch by uploading a version of the same Worker,
`ruminate`, with the bindings in `wrangler.jsonc` — and so with the production
D1 database. Two things followed. A branch that added a migration could not be
previewed at all: nothing migrated production for it, and the new code read
columns that did not exist. And every preview, migration or not, wrote its
test edits straight into production.

Cloudflare has no fork-a-database primitive yet (Time Travel's docs: "does
not yet allow you to clone or fork an existing database"), so a clone is an
export and an import. Production is about 1 MB across ten plain tables, which
takes seconds.

## What happens on a push

The dashboard's **Preview command** is `npm run preview:deploy`
(`scripts/preview-deploy.mjs`), run after the Build command (`npm run build`)
on every push to a non-production branch. In order:

1. **Gate.** The script asks GitHub whether the branch has an open pull
   request (drafts count). Without one it says so (`no open PR for <branch>`)
   and exits 0 — no version is uploaded, so a branch that has not been opened
   as a PR has no preview at all, rather than one against production. The
   build itself still runs; the gate is not a way to save build minutes.
2. **Fingerprint.** A SHA-256 over the sorted `migrations/*.sql` names and
   contents, for the branch and for `origin/main`.
3. **Choose the clone.**
   - Fingerprints equal → the branch changes no schema, and it previews
     against the **shared clone**, `ruminate-preview`.
   - Fingerprints differ → the branch gets **its own clone**,
     `ruminate-preview-<slug>`, where the slug is the branch name lowercased
     with every run of other characters collapsed to a dash. A name that
     would not fit is cut and given six hex characters of the full branch
     name's hash, so two long branches never share a database.
   - Main's fingerprint unknown (no `origin/main`, GitHub down) → per-branch,
     the safe side.
4. **Reuse or rebuild.** Each clone records the fingerprint it was last
   migrated under, in a `_preview_clone` table the script keeps (production
   never has it). Same fingerprint → the clone is reused as it is, test edits
   and all. Otherwise — the migrations changed, the fingerprint was never
   recorded because the last migration run failed part-way, or
   `PREVIEW_DB_REFRESH=1` is set as a build variable — the clone is deleted,
   created afresh, and production is exported into it: `d1 export` of
   production to a file, then `d1 execute --file` of that file into the clone.
5. **Migrate.** The script writes `wrangler.preview.generated.jsonc`: a copy
   of `wrangler.jsonc` edited in place (comments intact) in exactly three
   places — the D1 binding's `database_name` and `database_id`, and a
   `REPLICA_ID` var carrying the clone's id. `wrangler d1 migrations apply`
   runs through it, and only then is the fingerprint stamped into the clone.
   The Worker name is untouched, so the version lands on the same Worker,
   the branch alias URL is the same, and the OAuth callback registered for it
   keeps working. The generated file is gitignored.
6. **Sweep.** Every `ruminate-preview-<slug>` on the account whose slug is
   not that of an open PR's head branch is deleted. Production and
   `ruminate-preview` are never candidates. If GitHub cannot be asked, nothing
   is deleted.
7. **Upload.** `wrangler versions upload` with the generated config, and any
   extra arguments the command was given passed through.

`npm run preview:deploy -- --dry-run` prints every command and runs none of
them (the GitHub reads still happen). `node scripts/preview-deploy.mjs --slug
<branch>` prints the slug alone, which is how the teardown workflow names the
clone without a second copy of the rule.

## Teardown

Two mechanisms, either sufficient on its own:

- **On PR close** — merged or not — `.github/workflows/preview-db-teardown.yml`
  deletes `ruminate-preview-<slug>` for the PR's head branch, if it exists. It
  refuses to name `ruminate` or `ruminate-preview`, and does nothing when the
  secrets are unset.
- **The sweep** every preview build runs (step 6) catches whatever the
  workflow missed: a close while the token was broken, a branch deleted
  without a PR.

The shared clone is never torn down. It is rebuilt, not deleted, when main's
migrations change: the next preview build on any schema-neutral branch sees
the fingerprint mismatch and rebuilds it from production. A branch that had
its own clone and then caught up with main (its migration merged) moves to
the shared clone; its old per-branch clone lingers until its PR closes, then
goes with the workflow.

## What a migrations change does

The clone is rebuilt whenever the fingerprint changes: a migration added,
removed, renamed or edited on the branch. Because the export carries
production's `d1_migrations` table, the clone knows which migrations
production has already applied, and `migrations apply` runs only the ones it
has not. Two consequences:

- A migration production has **already applied**, edited on a branch, does
  not re-run on the clone — exactly as it could not in production. If a shipped
  migration needs correcting, that is a new migration.
- A migration that is **new on the branch** and later edited does re-run: the
  fingerprint change rebuilds the clone from production, where it has never
  run. So iterating on a migration on a PR branch previews correctly every
  push.

The same holds for `wrangler.jsonc`'s ordering rule: this is a preview of
what `npm run deploy` will do to production, migrations first.

## The replica identity, and a device's cursor

A device's pull cursor is a row sequence issued by one database. A clone
rebuilt from production starts its sequence wherever production was that day,
which is behind any device that had pushed to the previous clone at the same
URL — so that device's since-pulls would fetch nothing, forever, and its
local copy would silently diverge.

So the Worker reports which database answered: `replica_id` on every pull
and on `/api/replica/status`, `"production"` or the clone's id from the
`REPLICA_ID` var. The client stores the last one it saw; when it changes, the
local copy is wiped, cursor included, and pulled again in full — the same path
a stale cache generation takes (`src/data/database-mode.ts`). A missing id
(an older Worker) or a first contact is not a change. As with every wipe,
local edits not yet pushed go with it; on a preview that is the test edits
made against the previous clone, which no longer exists anyway.

## One-time setup

1. **Dashboard, Workers Builds → Build configuration.** Build command stays
   `npm run build`. Set the **Preview command** (non-production branches) to
   `npm run preview:deploy`. Workers Builds has no "only for pull requests"
   trigger — the docs offer only _Enable Preview Builds_, which builds every
   push to a non-production branch — so the gate is the script's own.
2. **The build's API token needs D1.** The token Workers Builds mints for
   itself carries Workers Scripts, KV and R2 edit only — no D1 — so
   `d1 create`, `delete`, `export` and `execute --remote` fail under it. In the
   same build settings, either choose an existing token with **D1 Edit** on
   the account, or add a `CLOUDFLARE_API_TOKEN` build variable (secret) holding
   one; wrangler prefers that variable over any other credential. The
   production deploy's `npm run migrate:remote` needs the same permission, so
   if migrations already apply from Workers Builds on main, the token is
   already right.
3. **Repository secrets** for the teardown workflow: `CLOUDFLARE_API_TOKEN`
   (D1 Edit) and `CLOUDFLARE_ACCOUNT_ID` (`a84767ecbbb94d3154e915832507314d`).
   Without them the workflow exits 0 without deleting anything, and the sweep
   does the work on the next preview build.
4. **A `GITHUB_TOKEN` build variable is optional.** The repository is public,
   so the PR lookups need no token; one raises the unauthenticated rate limit
   of 60 requests an hour, which a busy afternoon of pushes could reach.
5. **The branch alias's OAuth callback** is unchanged by any of this: sign-in
   on a preview works through the callback already registered for the branch
   alias URL, and the clone carries the `users` table, so the same GitHub id
   resolves to the same tenant.

## Limits and costs

- **Databases per account.** The Free plan allows 10 D1 databases. Production
  plus the shared clone is two; each PR that changes migrations is one more
  while it is open. The sweep and the teardown workflow keep the count to
  open PRs; if eight schema-changing PRs are open at once, the ninth's
  `d1 create` fails and its build with it.
- **Import limits.** 5 GB per file, 100 KB per statement. Production is about
  1 MB; a single row over 100 KB (a very large block) would fail the import,
  and the fix is to import that dump in chunks with `d1 execute --command`
  rather than `--file` (the seed-era runner did this at ~40 statements a
  call). Not implemented until it happens.
- **Build time.** Export, import and migrate add well under a minute to a
  rebuild; a reused clone adds a few seconds of lookups. The 20-minute build
  timeout is not in play.
- **Privacy.** The clone carries every tenant's rows and the MCP tokens —
  the whole database. Previews already read and wrote live production, so
  this is strictly less exposure, not more; but a preview is not a place to
  hand out. An owner-only scrub (delete every other tenant's rows after the
  import) is a one-statement follow-up if it is ever wanted.

## When Cloudflare ships forking

D1's roadmap has Time Travel forking ("in the future, Time Travel will allow
you to fork (clone) an existing database into a new database"). When it
lands, step 4's export-and-import becomes one command; nothing else here
changes.
