# Boards

A **board** is a wall of pictures with a page of its own: a place to keep
inspiration — for a future home, say — where each picture can be captioned
and given a **location**, a **fixture** and a **material** from a form, and
the wall narrowed by any of them. **New board** in the header makes one and
opens it at `/boards/<note id>`; its header is the note's own — Sort, Filter
and the ⋯ menu, where **Open outline** opens the note beneath it. Behind a
feature flag (`boards`, `src/data/feature-flags.ts`), admin only by default.

## One property, and nothing else new in the data

A board is a note whose page carries `board: true` among its metadata
(`BOARD_PROP`, `src/utils/board-prop.ts`), beside its font and width. That
one property is what makes it a board: the note's kind is `board`
(`NoteType`, derived in `src/data/note-meta.ts`), which gives it its icon in
every list, sends its rows to the board page rather than the outline
(`useOpenNote`, `src/hooks/open-note.ts`), lists it under `type:board` in a
search, and is what the board page checks before it draws anything — a
note without it is refused and opened as a note.

The property is a note's **default surface**, nothing more, and the note's
menu toggles it: **Make this a board** on any plain note sets it and opens
the board; **Make this a note** on a board clears it. Nothing else about the
note changes either way — the same rows, the same outline, the same id and
URL — and no structure is required first: a note with no pictures makes an
empty board, and the outline of a board is one click away (**Open outline**
in the board's ⋯ menu, **Open board** in the outline's). A daily or weekly
note is what its id says it is and cannot be made a board.

Beneath that property, every piece of a board is a block the outline
already understands, which is what lets the board and the outline be two
surfaces on one graph with no special-casing between them: a picture pasted
into the outline is on the board, a picture added from the board is in the
note, and a board's features and values can be written by hand in the
outline and the form picks them up.

| on the board       | in the graph                                                                                                                  |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| the board          | a note whose page props hold `board: true`                                                                                    |
| its pictures       | the image blocks written in the note (docs/images.md): the ones the outline reaches, and the ones in its Unassigned basket    |
| a feature          | a direct child of the page whose text is the feature's label — `Location`, `Fixture`, `Material` — trimmed, whatever its case |
| a feature's values | the feature block's children, in order (`Mauritius`, `Lisbon` under `Location`)                                               |
| a picture's value  | a `child` link from the value block to the picture: the value is a second parent, exactly as copy and select-mode paste make  |

So a board's outline reads:

```
Home inspiration
  Location
    - Mauritius
      [picture]
    - Lisbon
  Fixture
    - Lamp
      [picture]

  Unassigned
    [picture]      ← added from the board, no value yet
```

The features are the preset in `src/data/boards.ts` (`BOARD_FEATURES`): a
label and whether a picture may carry several of its values (**Location** is
one at a time; **Fixture** and **Material** are as many as apply). The label
is the identity, so renaming a feature block in the outline detaches it: the
form makes a fresh one on next use and the old block stays as ordinary
content, values and pictures still linked. Two direct children with the same
label are the first and some content. A picture pasted straight under a
feature block is a picture, never a value.

**Nothing is made until it is used.** A fresh board is a note with pictures
in it and nothing else. The first time a picture is given a location, the
`Location` block is made at the top of the page — after any feature block
already there, before everything else, so the features stay together and
the pictures keep their place — the value beneath it, and the picture linked
under the value. A feature nobody has used is not on the page, and adding one
to the preset changes nothing on disk until someone uses it.

**A picture's home is the basket until a value takes it.** A picture added
from the board is written in the note with no parent, so it sits in the
note's Unassigned basket — where any block nothing reaches sits
(docs/graph-schema-v2.md, "Delete"), beneath the outline on the note page.
Its first value links it under the value block, and the basket no longer
has it; clearing its last value unlinks it, and the basket has it again.
Deleting a value in the outline does the same to the pictures only it held.
None of this is a rule of the board's: it is the editor's own basket,
written the editor's way, and the board simply lists the basket's pictures
along with the ones the outline reaches. A picture pasted straight into the
outline is on the board too, wherever it was pasted, and a value set on it
is a second parent — it stays where it was pasted as well, as select-mode
paste would leave it.

## Reading

The board's pictures are the note's own rows, read off the live graph: the
ones the outline reaches, in document order (`outlineImageIds`), and the
basket's beneath them, most recently changed first (`unassignedImageIds`),
under an **Unassigned** heading — as the note page draws its basket beneath
the outline.

**Narrowing the wall is narrowing the note.** The header's Sort and Filter
are the note page's own (`src/components/view-controls.tsx`), reading and
writing the same view: the URL's `filter` and `sort` where they speak, else
the view the note saved as its default (`useSavedView`, `src/hooks/views.ts`
— one row, so a filter saved on the board is what the outline opens with,
and the other way round), and **Update to default** / **Reset to default**
settle it from either page. The filter is a query-language string and the
sort a comparator, resolved through the search engine exactly as the note
page resolves them (`viewNarrowing`, `src/utils/view-narrowing.ts`; the
board applies them in `useBoardNarrowing`, `src/hooks/board.ts`): nothing is
added to the language, and whatever a note's filter can say, a board's can.

The Filter menu leads with the board's features (`FilterBranch`): under
**Location**, the values on the page, each with how many pictures carry it,
and each a tick writing `parent:<value id>` — the qualifier the menu's own
Parent branch writes, so the branches are a shortcut into the one filter
rather than a filter of their own. Two ticks are a comma list, which the
language reads as _either_: `parent:Mauritius,Lamp` keeps a picture under
Mauritius or under Lamp, as it would in the search box, and as a note's
filter would. Narrowing to pictures that carry both is not something the
language says today (each `parent:` is tested against one occurrence's
parent, and a picture under two values is two occurrences), so the board
does not say it either; it would be a change to the engine, for every
surface at once.

The filter's **words** — its text outside the qualifiers, set from the
Filter menu's **Text** branch — are what searches captions: the engine
fuzzy-matches them over each row's own text, which for a picture is its
caption. The basket's pictures are in no index, so only the words reach
them, matched with the engine's own matcher and threshold over the
basket's captions directly (`useBoardMatches`); its qualifiers do not,
as the note page draws its basket whole beneath a narrowed outline. An
untagged picture is still found by what it says.

## Writing

Every write is a batch of ops through the one storage seam
(`src/data/store.ts`), like the editor's, worked out by pure functions in
`src/data/boards.ts` (a snapshot in, a batch out — `boards.test.ts` pins
each):

- **Adding a picture** (`addImageOps`) is the editor's own flow: an image
  block with no picture yet, written in the note with no parent — the
  basket's — drawing the file already in hand while the upload happens
  behind it; the asset id is written when it lands (`imageUploadedOps`), and
  a failed upload takes the row back out. The button, a drop anywhere on the
  page, or a paste.
- **Setting a value** (`setValueOps`) makes the feature block and the value
  block if they are missing and links the picture under the value. A
  single-select feature first unlinks any other value of its own the picture
  carried. Picking an existing value reuses it, by text, whatever its case.
- **Clearing a value** (`clearValueOps`) unlinks. The value stays for the
  others; a picture left with no parent is back in the basket.
- **The caption** is the image block's text (`setCaptionOps`) — what search
  matches, as in the editor.
- **Delete image** is the context menu's Delete (`deleteBlockOps`): the row
  is tombstoned; the bytes stay in the bucket (docs/images.md, "Not yet").

A form has no editor history behind it, so each change to a picture's
features is answered with a toast that can **Undo** it: the inverse batch
(`inverseOps`), worked out against the graph as it stood — a create is
deleted, a link unlinked or put back at the key it had, a text set back.

Signed out, the board reads and writes the sample graph in memory like the
rest of the app; uploads need a store, so **Add images** waits for sign-in.

## The page

`src/routes/_appRoot.boards.$.tsx`, with its parts under
`src/components/boards/`:

- **The header**: the note's name, then Sort, Filter and the ⋯ menu — the
  note page's own controls, with the board's features leading the Filter
  (above). The menu is the note's (`NoteActionsMenu`, `surface="board"`),
  with **Open outline** where the outline's has **Open board**; **Make this
  a note** from here lands on the outline, since the board page refuses a
  note.
- **Adding pictures** (`add-images.tsx`): two buttons at the top of the
  wall, **Camera** (on a phone, where there is one in hand) and **Photos**.
  A drop anywhere on the page, or a paste, adds too.
- **The wall** (`board-wall.tsx`): a masonry laid out from the pictures'
  own shapes (`masonry.ts`): as many columns as the width allows, no
  narrower than 160px and never fewer than two — a phone's width gives two,
  a desktop's five or six — each picture dropped onto the shortest column
  so far, its height counted in widths, so the columns end close to level
  and the order is kept near enough. A picture's shape is the size written
  on its block when it went up (docs/images.md); one written without a size
  is laid out square until its bytes arrive and say otherwise. The caption
  over the foot of each tile; click one to pick it.
- **The inspector** (`board-inspector.tsx`): the picked picture in a window
  of its own — the app's dialog, as wide as the screen allows — the picture
  large with its caption and a picker per feature beside it, stacked on a
  phone. Focus stays in the window but the page is not made inert
  (`modal="trap-focus"`), so the toast that answers a change, with its
  Undo, stays in reach while the window is open; a press on the scrim,
  Escape or the close control put it away. A menu opened from inside a
  dialog floats in the dialog's layer (`InModalContext`,
  `src/components/ui/layer.ts`), or it would open behind the window.
- **A picker** (`value-picker.tsx`): a menu of the feature's values —
  single-select closes on a pick, multi-select stays open with each row a
  toggle — and **New…**, which asks for a name in a dialog of its own
  (`new-value-dialog.tsx`).

## Not yet

- **Thumbnails.** A tile draws the picture's full bytes, as the editor does.
  A wall of a few hundred phone photos wants a smaller variant written at
  upload; until then boards are for tens of pictures, not hundreds.
- **A canvas.** A freer arrangement of the wall — the groupings drawn as
  clusters, pan and zoom — would be another read of the same graph, with
  nothing stored; the wall is the first such read.
- **Shared notes.** A note shared with you cannot be opened as a board: its
  pictures are behind the owner's session (docs/sharing.md), and the board
  writes to your own store.
