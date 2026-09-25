# Settings

Settings is a set of pages, one per subject, each a column of cards. This
document says how the pages are laid out, what the sidebar does while one is
open, and — the part most likely to be got wrong — what a setting is allowed
to say.

## The pieces

|                                              |                                                                                                 |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `src/components/settings/settings-nav.tsx`   | The pages by name: the registry, the sidebar rows, the phone's list, a page's heading.          |
| `src/components/settings/settings-pages.tsx` | Which cards each page draws.                                                                    |
| `src/components/settings/*-section.tsx`      | One card each.                                                                                  |
| `src/components/settings-section.tsx`        | The card itself: a bold heading over a `Surface`.                                               |
| `src/routes/_appRoot.settings*.tsx`          | `/settings` (the list on a phone, a redirect to the first page otherwise) and `/settings/<id>`. |

The registry and the cards are two modules on purpose: the always-mounted
sidebar lists the pages, and must not carry every card's code to do it.

## The pages

Account, Preferences, Sharing, MCP access, Data, About and — for the admin
alone, set apart at the foot — Admin. A page holds every card about its
subject, so a subject is one place and the list stays short. A page that
needs a feature or a sign-in is not listed without it; the cards inside a
page follow the same rule, so a signed-out visitor sees Appearance and
Editor under Preferences but not the Changelog card, whose setting follows
the account (src/data/account-preferences.ts).

## The sidebar

While Settings is open the sidebar keeps its shape. The Views and Calendar
links above, and the update, sync, Settings, Changelog and Help rows below,
are exactly where they are on every other page; only the Views list gives
its place to the pages, under a **Settings** heading, in the same rows. It
used to swap the whole sidebar for a list of pages with a way back on top,
which read as a second sidebar rather than the one sidebar showing something
else — and took the footer's rows, the update button among them, away from
the one page where a reader goes looking for controls.

The phone's drawer draws the same component, so it does the same.

## Copy

**A setting is a label.** A checkbox, a group of buttons or a field carries
its name — **Show what's new after an update**, **Theme**, **Default
expand** — and nothing under it. The label says what the control does; if
it cannot, the label is wrong, or the control is, and a sentence beneath it
is a patch over that rather than a fix. The reader is here to set
something, not to read about it.

The one line of descriptive copy a page carries is its description under
the heading (and under its row on a phone): one line, naming what the page
holds.

**Descriptive copy on a setting needs sign-off.** Do not add a line under a
setting, or change the one on a page, on your own judgement: propose the
exact words to the owner and add them only once they have agreed. Assume
the answer is a shorter label. This holds for an agent as much as a person,
which is why CLAUDE.md says it too.
