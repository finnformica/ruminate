---

name: changelog
description: Record the user-facing changes on the current branch.

**The changelog is a folder, not a file.** Every change's entries live in the
file the branch that made them wrote, under the week it was written in:

```
changelog/2026-W38/link-blocks.md
```

Nothing is ever folded, merged or moved. Two branches open at once write two
different files and have nothing to conflict over, which is the entire point —
a changelog that everybody appends to is a changelog everybody conflicts over.
The single document a reader sees is assembled at the point of reading, on the
`/changelog` page and in the what's-new card after an update, by
`src/utils/changelog.ts`.

That module is also the CI gate, so a malformed entry is a broken page rather
than an untidy document: **`npm run check:changelog` must pass before you
finish**, and CI runs it too.

That check enforces the mechanical rules below. It cannot judge whether an
entry is worth a reader's attention, which is the part that matters most and
the part this skill is really for.

## Workflow

### 1. Get the diff

```bash
git diff main...HEAD
```

### 2. Decide what belongs

An entry earns its place if a person using Ruminate would notice the change, or
would act differently knowing about it. Nothing else goes in.

**Never write about the admin's surfaces.** The Admin page, the allowlist,
invite links, feature flags and their audiences: none of it belongs in the
changelog. Almost nobody reading it is the admin, so an entry about those
tells the overwhelming majority of readers about a door they cannot open, and
quietly advertises where the controls are. Put it in `docs/`, or in the pull
request that makes the change. `npm run check:changelog` fails on it.

Leave out:

- Internal refactors, test infrastructure, CI and build configuration.
- Polish nobody would notice: small spacing tweaks, a moved pixel, a renamed
  internal function.
- Deployment steps, secrets to set, storage engines, query costs. If a change
  needs an operator to do something, that belongs in `docs/`.
- Anything only the admin can see or do, as above.
- Anything you could only describe by naming the implementation.

A useful test: could you write the entry without naming a file, a table, a
secret, a measurement, or a term of art from the code? If not, it is either not
a user-facing change, or you have not yet worked out what the user-facing part
of it is.

If nothing on the branch is user-facing, say so and stop. No fragment at all
is better than a padded one.

### 3. Write the entries

**Every entry leads with one sentence that stands on its own.** The what's-new
card after an update shows lead sentences alone, so a lead that needs the rest of the
bullet to make sense reads there as a fragment. Everything after the lead is
detail, and is shown on the changelog page.

```markdown
- Pin a block. **Pin** in a block's right-click menu lists it in the sidebar
  under **Pinned**, and the row opens the note zoomed into that block.
```

The lead says what changed. The detail says how it behaves, and what it
replaces. Where a change corrects something, say what it used to do — that is
usually the sentence that tells a reader whether it affected them.

Rules the check enforces:

- The lead ends in a full stop, and reads as at most **140 characters**.
- The whole entry reads as at most **500 characters**. Markup does not count
  towards either: `<kbd>` keycaps, emphasis and link addresses are free.
- British spellings: colour, grey, centred, behaviour, labelled.
- No pixel measurements, no deployment secrets, no fenced code blocks, and no
  jargon (`subtree`, `localStorage`, `idempotent`, and the like).
- No admin surfaces: `admin`, `allowlist`, `feature flag`.

Rules the check cannot enforce, which matter just as much:

- One bullet per change. If a feature has five parts, it is still one bullet.
- Order entries within a category by how much they affect people, most first.
- Plain language. Write "everything under the block", not "the subtree".
- Em dashes are fine. So is "now", when it genuinely signals a change — but if
  most of your entries open with it, they have stopped saying anything.
- Do not let an entry contradict its neighbours. If a change on this branch
  withdraws something announced earlier in the same week, say so in the entry
  rather than leaving two bullets that disagree.

### 4. Write the file

Get the current week with `date +%G-W%V`, then create
`changelog/<week>/<your-branch>.md` and write the entries into it as they will
appear, category headings and all:

```markdown
### Added

- Link blocks: a link as a card of its own. Hover a link and choose **Turn
  into block** for a card of the page's title, description and picture.

### Fixed

- Pasting a link no longer drops its title.
```

Categories are Keep a Changelog's, and appear in this order, each at most once
per file:

**Added**, **Changed**, **Deprecated**, **Removed**, **Fixed**, **Security**

Only include a category that has entries. Name the file after your branch, so
that it cannot collide with anyone else's, and add to it rather than creating a
second one if the branch already has one.

The week is the one you are writing in. If the branch lands the following week
the entry is filed a few days early, which is close enough for a changelog and
much cheaper than any scheme that would fix it.

### 5. Check it

```bash
npm run check:changelog
npm run format
```

The check reads every file under `changelog/` and reports a file and line for
each problem. Fix them all: CI fails on any one of them.
