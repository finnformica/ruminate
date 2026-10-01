# Boards

A **board** is a wall of pictures with a page of its own: a place to keep
inspiration — for a future home, say — where each picture can be captioned
and given a **location**, a **fixture** and a **material** from a form, and
the wall narrowed by any of them. **New board** in the header makes one and
opens it at `/boards/<note id>`; **Open outline** in the board's header
opens the note beneath it. Behind a feature flag (`boards`,
`src/data/feature-flags.ts`), admin only by default.

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
in its header, **Open board** in the outline's menu). A daily or weekly
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

The board's pictures are the note's own rows, read off the live graph
(`boardImageIds`): the basket's first, most recently changed first as the
basket lists them, then everything the outline reaches, in document order.
A narrowing keeps the pictures carrying every chosen value — a value is
carried when its block is one of the picture's parents (`carryingAll`) —
and, when words are typed, those whose caption the search engine's own
matcher and threshold accept (`useBoardMatches`, `src/hooks/board.ts`).

Two things are done on the board's own rows rather than through a search,
on purpose. The values, because a search tests each `in:` against one
occurrence's ancestry, and a picture under two values is on two paths,
neither of which passes both — so `type:image in:Mauritius in:Lamp` finds
nothing where the board finds the brass lamp. The words, because the corpus
index holds what a note reaches, and an untagged picture in the basket is on
the board too. `type:image in:<board>` in the search box still lists the
board's tagged pictures.

The narrowing lives in the URL (`?values=<value ids>&q=<words>`), so a
narrowed board is a link and the back button widens it.

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

- **The wall**: square tiles, the caption over the foot of each. Click one to
  pick it.
- **The inspector** (`board-inspector.tsx`): the picked picture, large, with
  its caption and a picker per feature. Drawn on the page above the wall
  rather than in a dialog, so the pickers' menus have nothing to fight and
  the wall stays in view for the next one. Escape closes it.
- **A picker** (`value-picker.tsx`): a menu of the feature's values —
  single-select closes on a pick, multi-select stays open with each row a
  toggle — and **New…**, which asks for a name.
- **The filters** (`board-filters.tsx`): a box for caption words and, for
  each feature with values on the page, a menu of them with how many
  pictures carry each.

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
