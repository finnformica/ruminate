# Removing views

Decided 2026-10-28, after Finn: "I don't like that the notes page and the views sidebar have different states." This note says what goes, what replaces each use, and what happens to the data that is there now.

## The problem

A view was a row of its own beside the graph (`views`, migrations/0015): a root, a filter, a sort, a `pinned` flag, a `sort_key` and a saved `stack`. Every note and board had one (migrations/0021). So the sidebar's **Views** list was a second copy of the notes page, with its own order and its own sort menu. A note could be on the notes page and off the sidebar, or in a different place in each.

## What is removed

- The `views` table, in D1 and in the browser store. A migration drops it after no code reads it.
- The view entity in the event log: no client writes a view event. The view events already in `events_log` stay as history. The fold reads past them.
- The **Views** list in the sidebar and the palette, with its sort menu (Name, Recently updated, Manual) and its drag order.
- **Add to Views**, **Remove from Views** and **Save as view**.
- The saved filter and sort of a note or a block (the header's **Update view** and **Clear view**). A filter and a sort still apply in place. They live in the address, as the frames do.
- The `/views/...` routes.

## What replaces each use

| Use of a view                          | Replacement                                                                                                                                      |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| A list of every note in the sidebar    | **Notes** in the sidebar opens the notes page: the outline from the root. It is the one list of notes, with one order (the root's child links).  |
| Keep a deep place to hand (block view) | **Pin** in a block's menu. A pin is the `pinned_at` prop on the node. **Pinned** in the sidebar lists the pinned notes and blocks, oldest first. |
| Go back to a place fast                | The palette's **Recent** (⌘K with nothing typed), ranked by use. It already holds blocks as well as notes.                                       |
| Open a note in a saved stack           | The address holds the stack. A bookmark or a copied link opens the same stack.                                                                   |
| A saved filter on a note               | The address holds the filter. Copy the link to keep it.                                                                                          |
| Order the notes                        | Drag them on the notes page, as before.                                                                                                          |
| A share names a view                   | A share names its root. `shares.view_id` always held the root's id, so the share reads it as the root.                                           |

A pin is a prop on the node, so it travels in the key events with no table and no new event entity. A pin on a block in a note someone shared with you is not offered: the node is the owner's.

## Addresses

- A note opens at `/notes/<id>`. The notes page is `/notes/corpus_root`, and `/` opens it.
- `/views/<id>` redirects to `/notes/<id>`, with its query kept. A view's id was always its root's id, so an old link opens the view's root block, or its note. `/views` redirects to `/`.

## The existing data

Production on 2026-10-28 holds 25 view rows, 21 live, and 127 view events.

- 19 live rows are the automatic rows of notes and boards. They held nothing but the listing. Every note stays on the notes page, so nothing is lost.
- 2 live rows are pinned `h1` blocks in one tenant (Finn's). Pin them again with **Pin** in the block menu. The migration does not write the pins, because only the projection may write to `events_log` and its tables.
- 2 rows save the filter `type:todo`. That filter is lost. Type it in the note's filter again, or keep a link with it.
- 3 rows hold a `sort_key` (a drag in the old list). The order is lost. The notes page keeps its own order.
- The 3 live shares name a root through `view_id`. They keep it.
- The 127 view events stay in `events_log` as history. Nothing folds them into a table.
