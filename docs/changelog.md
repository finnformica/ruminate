# The changelog

The changelog is a folder, not a file. Every change's entries live in the file
the branch that made them wrote, under the week it was written in:

```
changelog/
  2026-W38/
    history.md          the week's entries as they stood at the migration
    link-blocks.md      one branch's entries
    whats-new-card.md   another's
  2026-W37/
    history.md
```

Nothing is ever folded, merged or moved. The single document a reader sees is
assembled at the point of reading.

## Why a folder

A changelog that everybody appends to is a changelog everybody conflicts over.
A release goes at the top of the file, so every branch open in the same week
wants the same few lines, and two of them collide over entries that have
nothing to do with each other — a merge conflict carrying no information, on a
document whose whole purpose is to be read.

Writing one file per change removes the shared lines, so the conflict cannot
arise. Collating them at read time removes the step that would otherwise have
to put them back together, and with it the machinery that step needed: a
workflow, a bot, a token, and an argument with branch protection. There is
nothing to run and nothing to remember.

It also closes a gap. When entries had to be folded before they could be read,
a build taken before the fold shipped an app whose changelog said nothing about
the changes in it — and the reader who had just pressed **Update Ruminate**
was told there was nothing new, which is the one moment the whole thing exists
for. Now an entry is readable the moment it is written.

## The pieces

|                                 |                                                              |
| ------------------------------- | ------------------------------------------------------------ |
| `changelog/<week>/*.md`         | The entries. The only source.                                |
| `src/utils/changelog.ts`        | The format as data: the parse, the limits, the collation.    |
| `src/utils/changelog-source.ts` | The files, bundled at build time and collated.               |
| `scripts/check-changelog.ts`    | The CI gate over every file.                                 |
| `.claude/skills/changelog`      | How to decide what belongs in an entry, and how to write it. |
| `CHANGELOG.md`                  | A stub pointing here. Nothing appends to it.                 |

## What a reader sees

Two surfaces, from the same files:

- **The changelog page** (`/changelog`), reached from **What's new** in the
  sidebar. **One release at a time**, entries in full, with the weeks down the
  side to pick from and `?release=…` naming the one on screen. It used to run
  every release together into one endless page, mounted a couple at a time as
  you came down it, with the rail following your scroll — in service of a
  document nobody reads end to end. You come for what changed this week, or
  for one particular week; the page is now that.
- **The what's-new card**, which greets a device running a build it has not
  seen with the leads alone, a handful of them, and a way through to the page
  for the rest. It sits in the bottom corner beside the sidebar's own **What's
  new** and **Update Ruminate** items, rather than over the page: arriving at
  an app you have just updated to find your way barred by something you must
  dismiss is a poor greeting, and what changed is never urgent.

## The format

A file holds Keep a Changelog categories — **Added**, **Changed**,
**Deprecated**, **Removed**, **Fixed**, **Security** — each at most once, in
that order, and under those the entries. There is no week heading inside a
file: the folder says which week it is.

```markdown
### Added

- Pin a block. **Pin** in a block's right-click menu lists it in the sidebar.
```

**An entry is a lead sentence and the detail behind it.** The lead runs to the
first full stop and must stand on its own, because the what's-new card shows
leads alone: an entry whose first sentence needs the rest of the bullet reads
there as a fragment. The page shows both, the lead as a small
heading and the detail as its paragraph, so a release can be read at either
depth: skim the leads for what changed, or read on for what it means.

Limits are measured as a reader sees them, not as characters in the file. A
lead naming four shortcuts is short to read and long to store, and it is the
reading the limits are about, so `<kbd>` keycaps, emphasis marks and a link's
address do not count (`visibleLength`).

## How they are collated

Files are grouped by the week in their path, taken in the order their names
sort, and their categories merged into one of each in the canonical order.
Weeks come out newest first.

The parse is lenient by design. It collects faults rather than throwing, and a
file that does not parse is left out with its faults reported rather than
allowed to break the page. CI is what makes such a file loud.

`<kbd>` tags are not given to the markdown renderer. `toSegments` hands the
text out in the runs between them, and the keys are drawn as keycaps by `Keys`
(`src/components/keys.tsx`) — the one way the app shows a shortcut, here as
everywhere else.

## When the card appears

Two things bring it up, and it always shows the same thing: the newest release.

**The reader took an update.** **Update Ruminate** records that before it
reloads (`src/utils/whats-new.ts`), and the boot on the other side of the
reload finds the note and says what changed. This is the case the feature
exists for, and it is why the card is keyed to the update itself rather than
to what the device remembers: a device arriving from a build that predates the
card has nothing stored to compare against, so keying it to memory alone meant
the first update after it shipped showed nothing at all, to everybody.

**The build changed without being asked for.** `__CHANGELOG_VERSION__` is a
stamp built into the app: the newest week's folder and a hash of every entry
file (vite.config.ts). A device whose stored stamp names a different build is
running something it has not seen — which is how the reader whose waiting
worker activated on its own, after they closed every tab, is caught. A device
that has never stored a stamp has nothing to compare and is shown nothing
unless it asked.

Both notes are one-shot: taking the update request clears it, and storing the
build overwrites what was stored before. They are therefore read **once per
page load**, not from an effect — React's strict mode runs effects twice on
purpose and a remount would do the same, and the first pass consuming the
request left the second with nothing to show.

**The card is not a dialog, and not tied to the button's click handler.** That
button applies the waiting service worker and reloads
(`src/hooks/app-update.ts`), so there is no moment between the click and the
new build in which anything could be shown: the page is about to be torn down.
The note that outlives the reload is what carries the intent across.

## What never goes in

The admin's surfaces. The Admin page, the allowlist, invite links, feature
flags and their audiences are not the changelog's business: almost nobody
reading it is the admin, so an entry about them tells the overwhelming
majority of readers about a door they cannot open, and quietly advertises
where the controls are. `npm run check:changelog` fails on `admin`,
`allowlist` and `feature flag`. Such a change belongs in `docs/` or in its own
pull request.

## Writing an entry

Create `changelog/<week>/<your-branch>.md` — `date +%G-W%V` gives the week —
and write the entries into it. Nothing else changes, and nothing needs folding
afterwards.

`npm run check:changelog` holds every file to the same rules.
`.claude/skills/changelog` is the guidance the rules cannot carry: what a
reader would notice, and what belongs in `docs/` instead.
