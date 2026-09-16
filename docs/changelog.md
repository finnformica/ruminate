# The changelog

`CHANGELOG.md` is a document and an interface. People read it on GitHub, and
the app renders it: the changelog page at `/changelog`, and (next) the dialog
shown after an update. This is how that works.

## The pieces

|                                |                                                                               |
| ------------------------------ | ----------------------------------------------------------------------------- |
| `CHANGELOG.md`                 | The releases, newest first. The only source the app reads.                    |
| `changelog.d/`                 | Entries waiting for a release, one file per branch (`changelog.d/README.md`). |
| `src/utils/changelog.ts`       | The format as data: the parse, the limits, and the presentation helpers.      |
| `scripts/check-changelog.ts`   | The CI gate over the changelog and every pending fragment.                    |
| `scripts/collate-changelog.ts` | Folds fragments into a release, run on `main`.                                |
| `.claude/skills/changelog`     | How to decide what belongs in an entry, and how to write it.                  |

## What a reader sees

Two surfaces, from the same file:

- **The changelog page** (`/changelog`), reached from **What's new** in the
  sidebar. Every release down the side, one open beside it, entries in full.
- **The dialog after an update**, which greets a device running a build it has
  not seen with the leads alone, capped at a dozen, and a way through to the
  page for the rest.

## The format

A release is an ISO week. Under it are Keep a Changelog categories — **Added**,
**Changed**, **Deprecated**, **Removed**, **Fixed**, **Security** — each at
most once, in that order, and under those the entries.

```markdown
## 2026-W38

### Added

- Pin a block. **Pin** in a block's right-click menu lists it in the sidebar.
```

**An entry is a lead sentence and the detail behind it.** The lead runs to the
first full stop and must stand on its own, because the dialog after an update
shows leads alone: an entry whose first sentence needs the rest of the bullet
reads there as a fragment. The page shows both, the lead carrying the weight
and the detail quieter beneath it, so a release can be read at either depth.

Limits are measured as a reader sees them, not as characters in the file. A
lead naming four shortcuts is short to read and long to store, and it is the
reading the limits are about, so `<kbd>` keycaps, emphasis marks and a link's
address do not count (`visibleLength`).

## How it reaches the page

`CHANGELOG.md` is imported for its text (`?raw`) in the route's loader, so it
lands in that route's own chunk rather than in the app: it is a document nobody
opens on most visits, and it only grows.

The parse is lenient by design. It collects faults rather than throwing, and
two headings for one category are reported once and then merged, so a file with
a problem renders as much of itself as it can instead of blanking the page. CI
is what makes such a file loud.

`<kbd>` tags are not given to the markdown renderer. `toSegments` hands the
text out in the runs between them, and the keys are drawn as keycaps by
`Keys` (`src/components/keys.tsx`) — the one way the app shows a shortcut,
here as everywhere else.

## How it decides you have not seen it

`__CHANGELOG_VERSION__` is a stamp built into the app: the newest release's
week and a hash of the file (vite.config.ts). The week is what the comparison
is made on, since it says which releases are new; the hash is there so two
builds in the same week are not mistaken for one.

On boot, the dialog compares that stamp with the one this device stored last
time. A device that has never stored one is on its first visit, so it stores
the stamp and is shown nothing — a first visit has nothing to catch up on. A
device whose stamp names an older week is shown the releases after it. A device
whose stamp names the same week as the build, with a different hash, has read
those entries already, so the stamp moves on without a word.

The stamp is a string in the app bundle, so answering the question costs
nothing: only a device that is actually behind fetches the changelog.

**The dialog is not tied to the Update Ruminate button.** That button applies
the waiting service worker and reloads (`src/hooks/app-update.ts`), so there is
no moment between the click and the new build in which anything could be shown:
the page is about to be torn down. Asking the question on every boot instead
also catches the reader whose waiting worker activated on its own after they
closed every tab, which the button never sees.

## Writing an entry

Never edit `CHANGELOG.md` on a branch: a release goes at the top of it, so two
branches open in the same week conflict over entries that have nothing to do
with each other. Write `changelog.d/<branch>.md` instead, and it is folded into
the current week when the branch lands on `main`.

`npm run check:changelog` holds the changelog and every pending fragment to the
same rules. `.claude/skills/changelog` is the guidance the rules cannot carry:
what a reader would notice, and what belongs in `docs/` instead.
