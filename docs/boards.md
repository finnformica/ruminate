# Boards

A **board** is a wall of pictures with a page of its own: a place to keep
inspiration — for a future home, say — where each picture can be captioned
and given a **location**, a **fixture** and a **material** from a form, and
the wall narrowed by any of them. **New board** in the header makes one and
opens it at `/boards/<note id>`; its header is the note's own — Sort, Filter
and the ⋯ menu, where **Open outline** opens the note beneath it.

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

| on the board       | in the graph                                                                                                                 |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| the board          | a note whose page props hold `board: true`                                                                                   |
| its pictures       | the image blocks written in the note (docs/images.md): the ones the outline reaches, and the ones in its Unassigned basket   |
| a feature          | a direct child of the page whose text is the feature's label — `Location`, `Object`, `Material` — trimmed, whatever its case |
| a feature's values | the feature block's children, in order (`Mauritius`, `Lisbon` under `Location`)                                              |
| a picture's value  | a `child` link from the value block to the picture: the value is a second parent, exactly as copy and select-mode paste make |

So a board's outline reads:

```
Home inspiration
  Location
    - Mauritius
      [picture]
    - Lisbon
  Object
    - Lamp
      [picture]

  Unassigned
    [picture]      ← added from the board, no value yet
```

The features are the preset in `src/data/boards.ts` (`BOARD_FEATURES`): a
label and whether a picture may carry several of its values (**Location** is
one at a time; **Object** and **Material** are as many as apply), and what
each means, as the model is told it: **Location** is where the picture was
taken, named as a person would say it; **Object** is the thing the picture
is of — furniture, lighting, cutlery, plants, decoration; **Material** is
what that thing is made of. (Object was **Fixture** until 2026-W40; there
is no alias, so a board with a `Fixture` block retitles it.) The label
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
rather than a filter of their own. Each feature keeps a `parent:` qualifier
of its own, and the language reads the two shapes two ways: a comma list
within one qualifier is _either_, the key repeated is _both_. So Mauritius
and Lisbon ticked under Location, and Lamp under Object, is
`parent:<mauritius>,<lisbon> parent:<lamp>` — a picture in Mauritius or
Lisbon that is a lamp — as it would be in the search box, and as a note's
filter would read it. A branch tells its qualifier from the others by the
values it offers (`src/utils/view-filter.ts`): the qualifier whose values
are all its own is its, and one typed by hand belongs to no branch and is
left as written. **Any** takes the one feature's qualifier out and leaves
the rest. The engine makes the conjunction hold for a picture under two
values: such a picture is reached by two paths, and is two occurrences in
the index, each showing its own path — but `parent:` is tested against
every parent the picture has, and `under:` against every ancestor on any of
its paths, so the one picture under Mauritius and under Lamp answers to
both (`testAncestorFilter`, `src/utils/block-search.ts`; docs/query-language.md,
"Repeat the key for both").

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
  a failed upload takes the row back out. The button, the camera, a drop
  anywhere on the page, or a paste. Whichever way it came, the first new
  picture opens in the inspector at once, under its spinner: the caption
  and the features are the row's own, so they can be set while the bytes
  are still going up, and the asset id joins them when it lands. A failed
  upload closes the window with its row.
- **Setting a value** (`setValueOps`) makes the feature block and the value
  block if they are missing and links the picture under the value. A
  single-select feature first unlinks any other value of its own the picture
  carried. Picking an existing value reuses it, by text, whatever its case.
- **Clearing a value** (`clearValueOps`) unlinks. The value stays for the
  others; a picture left with no parent is back in the basket.
- **The caption** is the image block's text (`setCaptionOps`) — what search
  matches, as in the editor.
- **Reset** (`resetValuesOps`) takes every value off the picture, all
  features at once, as one batch with one Undo; the caption stays. Beside
  **Delete image** at the foot of the form, and nothing to press while the
  picture carries no value.
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
  Down a long wall the row scrolls away, so once it is out of view
  (`useInView`, src/hooks/in-view.ts) the same two follow as glyphs on a
  pill floating at the foot of the page — `FloatingBar`
  (src/components/ui/floating-bar.tsx), the shape and chrome of the edit
  bar a phone gets above its keyboard, as wide as its two glyphs rather
  than the page — sliding up from beneath the page's edge and back down
  again when the row is back. A drop anywhere on the
  page, or a paste, adds too. However a picture arrives, the first one
  opens in the inspector straight away, still uploading.
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

## Tagging with Claude

**A proof of concept**, open to every signed-in user with a provider set
up (below). A picked picture's window carries **Suggest** in its title bar
— a sparkles icon and, on a wide screen, the word, beside the close control, busy until the
answer is in — and that is the one way to tag: a vision model is shown the
picture and the board's features with the values in use, and answers with
a caption and, per feature, the values that fit — an existing value
spelled as given, or a short new one. Nothing is tagged unasked.

**Two providers, one path.** The request (`TagRequest`) says nothing about
who is asked; the Worker's handler resolves that itself and the providers
differ only in how the picture and the features go out and how the raw
answer comes back (`TagProvider`, worker/handlers/board-tag.ts: a picture
and the features in, the model's text out). Everything else is shared —
the day's count, the refusal codes, one step that reads the text leniently
(`extractJson`: a code fence or words around the object are stripped) into
a `TagSuggestion` through the same `readTagSuggestion` (trimmed,
de-duplicated, capped, one value for a single-value feature; an answer
that is not a suggestion is a 422) — and on the client one `suggestionOps`
batch through `suggestTags`.

- **Anthropic** — the Messages API with the user's own key, open to every
  signed-in user who keeps one under Settings → AI, with a JSON schema the
  answer is held to.
- **Cloudflare** — Workers AI (`env.AI`, wrangler.jsonc), free within
  Cloudflare's allowance of 10,000 neurons a day for the whole Worker,
  behind the `cloudflareAi` feature flag (admin only by default). While the
  flag allows it, Settings → AI offers **Use Cloudflare AI**, a preference
  of the account. The model is `@cf/google/gemma-4-26b-a4b-it`
  (`CLOUDFLARE_AI_MODEL`), asked with the same picture (as a data URL in a
  chat-completion message) and the same features. Workers AI's JSON mode is
  not something every model there honours, so the prompt asks for the JSON
  shape in so many words, `response_format` with the schema is tried first
  and the call made again without it if refused, and the answer is parsed
  out of whatever came back — JSON mode hands it back already parsed, in
  `response`, and a plain answer comes as text in `choices`. The model's
  reasoning is switched off (`chat_template_kwargs: { enable_thinking:
false }`): on by default, it made the answer slow and could spend the
  output on thought before any JSON came. Every call goes through AI
  Gateway (`gateway: { id: "default" }`, made on first use), so a call —
  its prompt, its answer, its latency and tokens — can be read afterwards
  under **AI → AI Gateway** in the Cloudflare dashboard, by the log id the
  Worker returns with the answer or the refusal.

**One router, Anthropic first.** `resolveAiProvider` (src/data/ai-router.ts)
is the one place the order lives: Anthropic if the account has a key kept →
Cloudflare if the `cloudflareAi` flag allows the account and **Use
Cloudflare AI** is ticked → none. The Worker reads it from its own truth on
every request — the key row, the flag's audience, the stored preference —
so the client never chooses; `useAiAvailable` (src/hooks/ai.ts) reads the
same router over what the sign-in knows, only to show and enable the same
answer, and anything the client says about a provider is ignored.

**The key is the user's own, and lives on the server.** Settings → AI
takes an Anthropic API key and keeps it in the control plane's
`anthropic_keys` table (migrations/0018), one row per account, reached
through `/api/anthropic-key` (worker/handlers/anthropic-key.ts). The route
never answers with the key: `GET` says whether one is kept and its last
four characters, and that is all the browser ever holds
(src/data/anthropic-key.ts). It is stored as pasted, not encrypted at
rest — D1 is reached only through the Worker — which is one of the things
that would have to change before this left the proof-of-concept stage.

**The picture is fitted on the device before it goes.** The models resize
anything past about 1,568 px on the long edge before they look at it, so
the stored original is upload for nothing — and a phone photo is four to
nine megabytes, past the API's limit, while an upload only re-encodes
past the ten-megabyte upload limit (docs/images.md). So `suggestTags`
takes the picture's bytes as the page already has them (`imageBlob`,
src/data/images.ts: the device's copy, else the Worker's) and makes a
copy for the model (`visionCopy`, src/data/image-fit.ts: a JPEG no larger
than 1,568 px on its longest side, quality 0.8, no metadata — a few
hundred kilobytes for a phone photo), through the same decode and encode
the upload's own fitting uses (`fitImageFor`). A phone photo of any size
tags, and a tag costs that much upload. Where the browser cannot make the
copy, the original goes and the Worker's limit answers as before.

**The call** is `POST /api/boards/tag` (worker/handlers/board-tag.ts), a
form: `image`, the fitted copy, and `features`, the board's features as a
JSON string (`TagRequest`, src/data/auto-tag.ts). The Worker reads the
form — a format the models read, under the API's five-megabyte limit as a
sanity check — and hands the bytes to the provider; it reads nothing of
the caller's but the session, and R2 is not touched for tagging. The
Anthropic provider sends them with a fixed system prompt and a JSON schema
the answer is held to (structured output) to the Messages API, as
`claude-haiku-4-5` with the caller's key. The client sends the features
rather than the Worker reading them from D1, on purpose: the browser's
graph is the one that knows the board now (a value picked a moment ago may
not have reached the replica yet), and the Worker trusts the form as
prompt text only and writes nothing to the graph. Refusals are codes the
client puts into words (src/data/suggest-tags.ts): not a form with a
picture and features (400), nothing set up (412), a key Anthropic refuses
(422), the day's calls spent (429 — a fuse of 300 a day per account
whoever answers, counted in `ai_usage`, migrations/0019; the `calls_*`
columns 0018 gave the key's row are no longer written), a picture too
large or in a format the API does not read (413, 415), Cloudflare chosen
with no binding (501), the provider failing (502), and an answer that is
not a suggestion (422). A refusal carries what the call can be found by —
the provider, its model, the gateway log — and what the provider said (the
answer as it came, or the error's words), and the toast that shows it has
a **Copy** action that puts those lines on the clipboard, so a failure can
be reported as it was rather than described.

**Where the picture was taken** gives the model a place for Location. A
picture added from the board may carry `lat` and `lon` on its block (WGS84,
five decimal places), set at upload: one taken with the **Camera** button
is placed by the device's position (`devicePosition`,
src/data/device-position.ts — asked once as the uploads start, with the
browser's own permission prompt and no copy of ours, never waited for,
written to the block by a follow-up op when it answers late and dropped
with the row when the upload failed); one picked with **Photos** is placed
by the picture's own EXIF GPS block, read by hand from the original before
the fitter strips it (`readExifLocation`, src/data/exif-location.ts — a
JPEG's first quarter megabyte, no dependency; iOS usually strips it from
what it hands a web page, so a library picture is often unplaced). A
picture with no coordinates gets no such props and no Location hint. With
them, the request carries `location` (validated by `readTagRequest`:
finite, on the globe, else dropped) and the Worker asks OpenStreetMap's
Nominatim once (`reverseGeocode`, worker/geocode.ts: `zoom=18`, named per
its usage policy, in English, held to three seconds, after the day's call
is counted and never failing the tag) for the place's whole chain of names,
most specific first — `display_name` with postcodes and house numbers
dropped, each name once, "; "-joined, cut to 160 characters: "Ljubljana
Jože Pučnik Airport; Zgornji Brnik; Cerklje na Gorenjskem; Upper Carniola;
Slovenia". The prompt gives the model the chain and asks it to name the
place as a person would in conversation: a value in use that covers it,
else the country by default, or the everyday short name of a notable
specific place — an airport, a landmark, a city — rather than the precise
village the chain begins with. With coordinates but no chain it gives them
and asks for the town or area.

**Reading the answer** is the same for both providers (`readTagSuggestion`,
src/data/auto-tag.ts). The caption's first letter is upper-cased. A value
that matches one in use — trimmed, whatever its case — comes back spelled
exactly as the value in use, so `setValueOps` links the board's own value
rather than making a near-duplicate. A new value is cut to 30 characters
(`MAX_SUGGESTED_VALUE_LENGTH`: it becomes a menu option; a value in use is
never shortened) and takes the style of the feature's values in use: when
every one starts upper-case its first letter is upper-cased, when every one
starts lower-case it is lower-cased, and mixed or none in use means
upper-cased. The prompt asks the model for the same style — the same case,
singular or plural as the values in use are — and for a value for every
feature the picture clearly shows something for, with none only when it
shows nothing for that feature.

**Applying the answer** is the board's ordinary writes. `suggestionOps`
(src/data/boards.ts) reads the suggestion into one batch — a caption only
where the picture has none, a single-value feature only where the picture
carries none of its values, a multi-value feature's values added to those
carried — each value through `setValueOps` by text, so an existing value
is reused and a new one made, and the batch built up against the snapshot
as each write would leave it, so two new values under one new feature make
one feature block. It fills in and never overrides what a person set, and
it is one toast — **Picture updated** — with one **Undo**, and a **Copy**
beside it that puts what the model answered and what was read from it on
the clipboard, so a thin answer can be inspected. Nothing to add is a
toast that says so, with the same Copy.

The prompt tells the model what each feature means (`meaning` on
`BoardFeature`, sent with the request as `TagFeature.meaning` and rendered
as "- Object (several values): the thing the picture is of, such as …
Values in use: cutlery, potted plant"), and an answer that names the
features under other labels — "Objects", "Materials" — is still read, by
position, when it has one entry per feature in order.

Deliberately not done: encrypting the key at rest; tagging a picture that
is not an upload (an external picture's bytes are at its own address);
tagging in bulk, or on upload (only the inspector's button asks); any
caching of answers; and prompt tuning beyond the one system prompt. Signed
out there is no key, so nothing of this shows.

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
