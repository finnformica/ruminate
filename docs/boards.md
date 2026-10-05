# Boards

A **board** is a wall of pictures with a page of its own: a place to keep
inspiration — for a future home, say — where each picture can be captioned
and given the board's **features** — a location, an object, a material and
a link to begin with, and whatever else the board is given under
**Features** —
all from a form, and the wall narrowed by any of them. **New board**, under
the header's **New** menu (or <kbd>⌘</kbd> <kbd>⇧</kbd> <kbd>B</kbd>), makes one and
opens it at `/boards/<note id>`; its header is the note's own — Sort, Filter
and the ⋯ menu, where **Open note** opens the note beneath it.

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
empty board, and the outline of a board is one click away (**Open note**
in the board's ⋯ menu, **Open board** in the outline's). A daily or weekly
note is what its id says it is and cannot be made a board.

Beneath that property, every piece of a board is a block the outline
already understands, which is what lets the board and the outline be two
surfaces on one graph with no special-casing between them: a picture pasted
into the outline is on the board, a picture added from the board is in the
note, and a board's features and values can be written by hand in the
outline and the form picks them up.

| on the board       | in the graph                                                                                                                                                                                                                                      |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the board          | a note whose page props hold `board: true`                                                                                                                                                                                                        |
| its pictures       | the image blocks written in the note (docs/images.md): the ones the outline reaches, and the ones in its Unassigned basket                                                                                                                        |
| a feature          | a direct child of the page whose props carry `feature` (`FEATURE_PROP`, `src/utils/board-prop.ts`): its type, whether a picture may carry several of its values, and what it means to the model. Its text is its label; the block is its identity |
| a feature's values | the feature block's children, in order (`Mauritius`, `Lisbon` under `Location`)                                                                                                                                                                   |
| a picture's value  | a `child` link from the value block to the picture: the value is a second parent, exactly as copy and select-mode paste make                                                                                                                      |
| a link value       | a value of a feature of type `link`, whose block is a link block (docs/links.md): the page's card, address and preview in its props, with the same `child` link from it to the picture — so the pictures from one page share one card             |

So a board's outline reads:

```
Home inspiration
  - Location              feature:: { type: place, multi: false, notes: "where …" }
    - Mauritius
      [picture]
    - Lisbon
  - Object                feature:: { type: text, multi: true, notes: "the thing …" }
    - Lamp
      [picture]
  - Material              feature:: { type: text, multi: true, notes: "what …" }
  - Source                feature:: { type: link, multi: true }
    [card: Oak pendant lamp — made.com]
      [picture]

  Unassigned
    [picture]      ← added from the board, no value yet
```

(The `feature::` lines stand for the block's props; the outline shows a
feature as a bullet with its label, the prop out of sight.)

## Features

**A feature is a block, as a board is a property.** The `feature` prop on a
direct child of the page is what makes it one (`featureSpecOf`,
`src/data/boards.ts`, reads it leniently: a `feature` that is an object is
a feature, a type it does not name is `text`, `multi` holds only when it
says `true`, notes only when they say something — under `notes`, or under
`meaning`, the key they were first written by). Its label is the
block's text and its values are the block's children, so the outline is
the same thing seen the other way: rename the block in the outline and the
form calls the feature by its new name, with its values and their pictures
still its own, because the identity is the block — its id — and never the
label. The features' order is the blocks' order on the page. Everything
reads them through one function, `boardFeatures` (the form, the Filter
menu's branches, Suggest, Reset), and there is no preset anywhere else.

**Three types** (`type` on `BoardFeature`), and whether a picture may carry
several values (`multi`), and notes on what the feature is (`notes`, as
the model is told them):

- `text` — a value is a name: a bullet under the feature block, typed into
  **New…** in the picker or chosen from the values there.
- `place` — a name too, in every way but one: when a picture carries where
  it was taken (below, "Tagging with Claude"), the hint is offered to the
  board's place feature, by its label. A board with no place feature sends
  no location.
- `link` — a value is a web address: a link block (docs/links.md) under the
  feature block — the page's card, its address and preview in its props —
  made from an address typed into **Add link** in the picture's window
  (`{ url, title }` as the `ValueRef`; a scheme-less address is taken as
  https, `boardLinkUrl`, and anything that is not a web address makes
  nothing). The card is titled as given, else by the address's host, as a
  pasted address is named, until the page's preview lands and gives it the
  page's own title; a title given is kept. The window shows the picture's
  link values as cards, and the Filter menu lists them by that title.
  A picture given an address already on the board (a trailing slash aside)
  goes under the card that is there, so the pictures from one page share
  it. Only a link block under a link feature is a value: a line typed there
  by hand is content. The model is never asked about a link feature.

**Defaults, no templates.** Making a board — **New board**, or **Make this a
board** on a note — writes four feature blocks onto the page, with their
props, before whatever the note holds (`defaultFeatureOps`, from
`DEFAULT_FEATURES` in `src/data/boards.ts`, the one place they live):
**Location** (`place`, one value: "where the picture was taken, named as a
person would say it"), **Object** (`text`, several: "the thing the picture
is of, such as furniture, lighting, cutlery, plants or decoration"),
**Material** (`text`, several: "what that thing is made of") and **Link**
(`link`, several, no notes to start with — the model is not asked about
it). A default
the note already has by label is left as it is. From there the board's
features are its own to change.

**A board from before features were blocks keeps working.** Such a board has
its features by name alone — a direct child of the page named `Location`,
`Object`, `Material` or `Link` (trimmed, whatever its case, whatever its
type) with no `feature` prop — and is read as having that default (`Link`
as a link feature taking several values), the first child of each name
only. The first change to such a feature in the Features editor writes the
prop onto its block, and from then on it is a feature like any other, by
its block. Nothing is rewritten until then. This name-matching is the one
place a label is read as anything but a label.

**The Features editor** is **Features** in the board's ⋯ menu
(`board-features-dialog.tsx`): the app's dialog holding a table, one row
per feature in the page's order, every cell edited in place — the type's
glyph, which is the type menu (**Text**, **Place**, **Link**); the
**Name**, a flush box that commits when it is left or Enter is pressed and
sets the block's text, so the outline shows the new name at once;
**Multiple**, a box for whether a picture may carry several of its values;
**Notes**, what the model is told, a box that wraps and grows with its
text, there only while a model can be asked (`useAiAvailable`) — on every
feature, a link feature too, though the model is only told about text and
place features; and a remove,
shown as the pointer finds the row. **Add feature** in the last row makes
a text feature named "New feature", taking several values, with its name
selected to be typed over. Every change is written as it is made, through
the board's own writes (`addFeatureOps`, `updateFeatureOps`,
`removeFeatureOps`), and the page shows it: the inspector's pickers and
the Filter menu follow a rename at once. A type cannot change between a
name and a link while the feature has values, since the value blocks it
has are of the one kind: those entries are greyed. There are no moves:
the features' order is the page's, so a feature is reordered by moving
its block in the outline. On a phone the table is a sheet from the foot
of the screen (`Sheet`, the phone's drawers), the notes beneath each name
and **Add feature** pinned full-width at the bottom.

**Removing a feature deletes nothing.** The remove takes the `feature` key
off the block's props and keeps the rest (a block named as a feature of
old — Location, Object, Material, Link — is given `feature: false`
instead, or its name would make it a feature again), so the board stops
reading it as one while the block, its values and the links from them to
the pictures stay in the outline as ordinary content, where the block can
be kept or deleted like any other. A props write has an inverse, so the
toast that answers it — **Feature removed** — can **Undo** it; nothing
else offers to make the block a feature again. A picture pasted straight
under a feature block is a picture, never a value.

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
- **Setting a value** (`setValueOps`, by the feature's block) makes the
  value block if it is missing and links the picture under the value; the
  feature's block is already there, made with the board or in the Features
  editor. A single-select feature first unlinks any other value of its own
  the picture carried. Picking an existing value reuses it, by text,
  whatever its case. A link feature's value is made from an address: the
  card, titled as given or by the host, with its preview fetched behind the
  write as the editor fetches a new link block's (`fetchLinkPreview`,
  src/data/link-previews.ts) and
  written on by `linkPreviewOps` — what the page says, and its title where
  the card has only the host's — with no history step and no toast; a page
  that will not answer is no error here — the card stays, an address to
  open, and says **No preview available** where the description would be. Signed out there is no session to fetch
  through, and the card keeps its address alone.
- **Clearing a value** (`clearValueOps`) unlinks. The value stays for the
  others; a picture left with no parent is back in the basket.
- **The caption** is the image block's text (`setCaptionOps`) — what search
  matches, as in the editor.
- **Reset** (`resetImageOps`) clears the caption and takes every value off
  the picture, all the board's features at once, as one batch with one Undo. Beside
  **Delete image** at the foot of the form, and nothing to press while the
  picture has no caption and carries no value.
- **Delete image** is the context menu's Delete (`deleteBlockOps`): the row
  is tombstoned; the bytes stay in the bucket (docs/images.md, "Not yet").

**A change is its own confirmation.** Giving a picture a value, taking one
off, captioning it, deleting it: the batch is applied at once and the page
shows the result — the picker, the tile, the wall — and nothing else is
said, as the editor says nothing of an edit (docs/design-principles.md,
Notices). A form has no editor history behind it, so the two changes that
would be costly to make by mistake are answered with a plain toast whose
job is the way back: **Reset**, which takes several things off in one
press, and **Suggest**, which a model made. **Undo** on it applies the
inverse batch (`inverseOps`), worked out against the graph as it stood — a
create is deleted, a link unlinked or put back at the key it had, a text
set back. Deleting a picture tombstones its row, which nothing restores,
so it offers no Undo and raises no toast.

Signed out, the board reads and writes the sample graph in memory like the
rest of the app; uploads need a store, so **Add images** waits for sign-in.

## The page

`src/routes/_appRoot.boards.$.tsx`, with its parts under
`src/components/boards/`:

- **The header**: the note's name, then Sort, Filter and the ⋯ menu — the
  note page's own controls, with the board's features leading the Filter
  (above). The menu is the note's (`NoteActionsMenu`, `surface="board"`),
  with **Features** first (the Features editor, above,
  `board-features-dialog.tsx`), **Open note** where the outline's has
  **Open board**, and **Make this a note**, which from here lands on the
  outline, since the board page refuses a note.
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
  is laid out square until its bytes arrive and say otherwise. A tile is
  the one picture component (`Picture`, docs/images.md, Thumbnails) as a
  lazy tile of the thumbnail alone: nothing fetched until it is within a
  screenful of view, its likeness until then — the ThumbHash on its
  block, which a picture added from the board carries as one pasted into
  the outline does — and the thumbnail fading in over it, tens of
  kilobytes rather than the picture's megabytes. A wall of hundreds opens
  by fetching the first screenful, and the rest as they are scrolled to.
  The inspector draws the same component after the picture itself. The
  caption over the foot of each tile; click one to pick it.
- **The inspector** (`board-inspector.tsx`): the picked picture in a window
  of its own — the app's dialog, as wide as the screen allows — the picture
  large with its caption and a picker per feature beside it, stacked on a
  phone — and, for a link feature, the picture's cards (`link-values.tsx`:
  the editor's own card body, `LinkCardBody` in `link-card.tsx`, less the
  page's picture, each with **Open link** and **Remove link**) and **Add
  link** beneath them, which asks for an address and an optional title in
  the same dialog a new value is named in. Focus stays in the window but
  the page is not made inert
  (`modal="trap-focus"`), so the toast that answers a Reset or a Suggest,
  with its Undo, stays in reach while the window is open; a press on the scrim,
  Escape or the close control put it away. A menu opened from inside a
  dialog floats in the dialog's layer (`InModalContext`,
  `src/components/ui/layer.ts`), or it would open behind the window.
- **A picker** (`value-picker.tsx`): a menu of the feature's values —
  single-select closes on a pick, multi-select stays open with each row a
  toggle — and **New…**, which asks for a name in a dialog of its own
  (`new-value-dialog.tsx`); the same dialog asks a link feature's **Add
  link** for an address (required, a web address) and a title (optional).

## Tagging with Claude

**A proof of concept**, open to every signed-in user with a provider set
up (below). A picked picture's window carries **Suggest** in its title bar
— a sparkles icon and, on a wide screen, the word, beside the close control, busy until the
answer is in — and that is the one way to tag: a vision model is shown the
picture and the board's text and place features with their notes and
the values in use (`tagFeaturesOf`; a link feature is not sent, and nothing
an answer says of it is applied — where a picture came from cannot be read
off the picture), and answers with
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

**Where the picture was taken** gives the model a place for the board's
place feature — **Location** on a fresh board, or whatever a place feature
is called; a board with none is sent no location and told nothing of it,
and asks nothing of Nominatim. A
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
place, for the place feature by its label ("For Location, …"; two place
features are both named), as a person would in conversation: a value in use
that covers it, else the country by default, or the everyday short name of
a notable specific place — an airport, a landmark, a city — rather than the
precise village the chain begins with. With coordinates but no chain it
gives them and asks for the town or area. Which features are places goes
with the request (`place` on `TagFeature`), so the Worker needs nothing of
the board.

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
carried — each answer matched to a feature by the label the model was
given, and each value through `setValueOps` by text, so an existing value
is reused and a new one made, the batch built up against the snapshot as
each write would leave it. It fills in and never overrides what a person set, and
it is one toast — **Picture updated** — with one **Undo**. Nothing to add
is a toast that says so. Only a failure's toast offers **Copy**: a call that
went through can be read in the gateway log.

The prompt tells the model what each feature is (`notes` on
`BoardFeature`, from the block's prop — what the Features editor's
**Notes** column holds — sent with the request as `TagFeature.notes`, cut
to 500 characters, and rendered as "- Object (several values): the thing
the picture is of, such as … Values in use: cutlery, potted plant"; a
feature with no notes is sent without them), and an answer that names the
features under other labels — "Objects", "Materials" — is still read, by
position, when it has one entry per feature in order.

Deliberately not done: encrypting the key at rest; tagging a picture that
is not an upload (an external picture's bytes are at its own address);
tagging in bulk, or on upload (only the inspector's button asks); any
caching of answers; and prompt tuning beyond the one system prompt. Signed
out there is no key, so nothing of this shows.

## Not yet

- **A canvas.** A freer arrangement of the wall — the groupings drawn as
  clusters, pan and zoom — would be another read of the same graph, with
  nothing stored; the wall is the first such read.
- **Shared notes.** A note shared with you cannot be opened as a board: its
  pictures are behind the owner's session (docs/sharing.md), and the board
  writes to your own store.
