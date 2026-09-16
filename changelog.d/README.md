# Pending changelog entries

One file per branch. Each holds the changelog entries that branch adds, and is
folded into `CHANGELOG.md` when the branch lands on `main`.

Nothing here is read by the app. `CHANGELOG.md` is, so these files are a
staging area, not a second changelog.

## Why entries are written here and not in `CHANGELOG.md`

A release goes at the top of `CHANGELOG.md`, so every branch open in the same
week wants to write to the same few lines of the same file. Two of them
conflict over entries that have nothing to do with each other, every time,
which is a merge conflict that carries no information.

A branch therefore never edits `CHANGELOG.md`. It adds one file here, named
after itself, and two branches touching two different files have nothing to
conflict over.

## Writing one

Name the file after your branch — `changelog.d/link-blocks.md` — and write the
entries as they will appear, category headings and all:

```markdown
### Added

- Link blocks: a link as a card of its own. Hover a link and choose **Turn
  into block** for a card of the page's title, description and picture.

### Fixed

- Pasting a link no longer drops its title.
```

Categories are the changelog's own — **Added**, **Changed**, **Deprecated**,
**Removed**, **Fixed**, **Security** — at most once each, in that order. The
rules for an entry are the changelog's too, and `npm run check:changelog`
holds a fragment to every one of them, so a bad entry fails in the branch that
wrote it rather than weeks later. `.claude/skills/changelog` has the guidance.

## How they are folded

`.github/workflows/changelog.yml` runs `npm run changelog:collate` on every
push to `main`. It merges each fragment into the release for the current ISO
week, creating that release if the week is new, puts the categories in order,
and deletes the fragments it folded. If the changelog or any fragment has a
problem, it folds nothing and says why.

You can run it locally to see what a release will look like, but there is no
need to: landing on `main` is what folds it.
