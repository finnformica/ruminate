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

## Entries that have not been folded yet

A branch writes its entries to `changelog.d/`, and they reach `CHANGELOG.md`
only once it lands on `main` and collation runs. A build taken before that —
or while collation is blocked — would otherwise ship an app whose changelog
says nothing about the very changes in it, and the reader who has just pressed
**Update Ruminate** would be told there was nothing new. Which is the one
moment the whole feature exists for.

So the fold happens twice. For real on `main`, and again in memory at build
time (`src/utils/changelog-source.ts`), where the pending fragments are
bundled with the app and merged into the current week. Both use the same
`mergeFragments`, so folding for real later changes nothing a reader sees: the
same entries, in the same order, under the same week.

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

## Writing an entry

Never edit `CHANGELOG.md` on a branch: a release goes at the top of it, so two
branches open in the same week conflict over entries that have nothing to do
with each other. Write `changelog.d/<branch>.md` instead, and it is folded into
the current week when the branch lands on `main`.

`npm run check:changelog` holds the changelog and every pending fragment to the
same rules. `.claude/skills/changelog` is the guidance the rules cannot carry:
what a reader would notice, and what belongs in `docs/` instead.
