---
name: changelog
description: Record the user-facing changes on the current branch as a changelog.d/ fragment, which is folded into CHANGELOG.md when the branch lands. Use when creating a pull request, or when pushing to a branch that already has an open pull request. Analyses the branch diff against main, identifies what a user would notice, and writes the entries. Never edit CHANGELOG.md on a branch.
---

# Changelog

Record the user-facing changes on the current branch.

**Never edit `CHANGELOG.md` on a branch.** A release goes at the top of that
file, so every branch open in the same week wants the same few lines and they
conflict over entries that have nothing to do with each other. Write a
fragment in `changelog.d/` instead — one file, named after your branch. It is
folded into the changelog automatically when the branch lands on `main`
(`changelog.d/README.md`).

The entries themselves are held to the same rules either way, because the app
reads what they are folded into: the changelog page and the "what's new"
what's-new card after an update are both rendered from `CHANGELOG.md`, parsed
by
`src/utils/changelog.ts`. A malformed entry is a broken page, so
**`npm run check:changelog` must pass before you finish** — CI runs it too, on
the fragment, in the branch that wrote it.

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

Leave out:

- Internal refactors, test infrastructure, CI and build configuration.
- Polish nobody would notice: small spacing tweaks, a moved pixel, a renamed
  internal function.
- Deployment steps, secrets to set, storage engines, query costs. If a change
  needs an operator to do something, that belongs in `docs/`.
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

Rules the check cannot enforce, which matter just as much:

- One bullet per change. If a feature has five parts, it is still one bullet.
- Order entries within a category by how much they affect people, most first.
- Plain language. Write "everything under the block", not "the subtree".
- Em dashes are fine. So is "now", when it genuinely signals a change — but if
  most of your entries open with it, they have stopped saying anything.
- Do not let an entry contradict its neighbours. If a change on this branch
  withdraws something announced earlier in the same week, say so in the entry
  rather than leaving two bullets that disagree.

### 4. Write the fragment

Create `changelog.d/<your-branch>.md` and write the entries into it as they
will appear, category headings and all:

```markdown
### Added

- Link blocks: a link as a card of its own. Hover a link and choose **Turn
  into block** for a card of the page's title, description and picture.

### Fixed

- Pasting a link no longer drops its title.
```

Categories are Keep a Changelog's, and appear in this order, each at most once
per fragment:

**Added**, **Changed**, **Deprecated**, **Removed**, **Fixed**, **Security**

Only include a category that has entries. There is no week heading in a
fragment: collation puts the entries into the release for the week the branch
lands in, which is not necessarily the week you wrote them.

If the branch already has a fragment, add to it rather than creating a second
one.

### 5. Check it

```bash
npm run check:changelog
npm run format
```

The check reports a file and line for every problem, in the fragment as well as
in the changelog. Fix them all: CI fails on any one of them.

To see what the release will look like once your branch lands, run
`npm run changelog:collate` — but do not commit the result. Folding is `main`'s
job, and a folded `CHANGELOG.md` on a branch is the merge conflict this whole
arrangement exists to avoid.
