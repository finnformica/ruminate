# Mobile

How Ruminate behaves on a touch screen, and what is still missing. The
stylesheets key touch behaviour off `@media (pointer: coarse)` (the `coarse:`
variant in `tailwind.config.cjs`, the type scale in `src/styles/variables.css`);
code asks the same question once, through `useCoarsePointer`
(`src/hooks/coarse-pointer.ts`).

## The editor by finger

A mouse has two clicks and a keyboard beside it; a finger has one tap and a
keyboard that appears and disappears. The block editor
(`src/components/block-editor/`) reads the two differently.

- **A tap edits.** With a mouse a click selects a row and a double-click edits
  it. A finger's tap edits the row straight away, with the caret where the tap
  landed when the body's text is the stored text as is (`caretOffsetAtPoint`,
  `caret.ts`); where the rendered text differs from the stored text (`**bold**`,
  a link) the caret goes to the end. The whole row is the tap target — the
  marker gap and the row's padding, not only the words — so a short line is as
  easy to hit as a long one. The chevron, the checkbox, the zoom dot and links
  keep their own taps.
- **The block menu is a sheet, on a long press.** A press-and-hold (a finger
  down on a row that stays put for 450ms, timed by the editor itself) opens
  `BlockMenuSheet`, a sheet from the bottom of the screen with the row's text
  at its top and the same entries the pointer's popup has, laid out for a
  thumb; a pick closes it, so does a swipe down. The popup anchored under the
  finger that came before was fragile — it opened as the press registered and
  shut on the lift, or on the scroll the same finger began. The sheet and the
  popup are one list (`menuEntries`) on two surfaces, so the structure moves —
  Indent, Outdent, Move up, Move down — are in both, with their keys shown
  beside them on the popup. Android's long press arrives as a `contextmenu`
  event and opens the same sheet. The hold selects no text: the editor's
  container is `select-none` under a finger (every row, card title, caption
  and gap), with the textarea being edited taking selection back for itself
  (`select-text`, said outright — iOS ignores a field under a `select-none`
  ancestor), and no touch callout. A selection the page shows anyway is
  dropped by the next finger on the editor and as the sheet opens, since
  with nothing selectable to tap iOS offers no way to be rid of one; a
  field's own selection is the person's and stays.
- **A highlight has no job on a touch screen.** There is no keyboard cursor
  for it to mark, so once an edit ends (the keyboard put away, a delete, a
  swap of rows) nothing stays lit; the one time a row is marked is while the
  sheet is open on it, and then quietly (the inactive ring).
- **Backspace is heard three more ways.** A phone's keyboard does not always
  say which key was pressed — Android's input method reports "Unidentified"
  (keyCode 229) for every key, some report a bare keyCode 8 — so at the very
  start of a block, where the textarea has nothing of its own to delete, the
  block also takes for a Backspace: a `beforeinput` deletion
  (`deleteContentBackward`, which Chromium raises even for a deletion of
  nothing; WebKit does not); a nameless keydown carrying keyCode 8; and a
  nameless keydown that is followed by no change to the text — no input, no
  composition — within a beat. Each runs the command the key would: the
  marker goes, then the block merges upward.
- **Delete, Undo and Redo keep the edit.** Run from the bar, a delete carries
  the edit on in the row that takes the deleted one's place, and an undo or
  redo keeps editing the row it lands on — the one that survived, moved, or
  came back — so the keyboard and the bar stay up for the next one.
- **The keyboard going away ends the edit.** Putting the keyboard away
  (iOS's Done key, the bar's Done) blurs the textarea, which ends the edit as
  a click away does on a desktop, and the row stays highlighted for the tap
  that starts the next one. Android's Back key hides the keyboard without a
  blur, so the edit bar watches the visual viewport grow back by a keyboard's
  height and ends the edit itself. (Turning the phone from landscape to
  portrait grows it too, and ends the edit the same way.)
- **The edit bar** (`mobile-edit-bar.tsx`) floats above the keyboard while a
  row is edited, a pill in Notion's shape: a row of actions that scrolls
  sideways under a fade, and a keyboard-down button in its own segment at the
  right that puts the keyboard away. A phone's keyboard has no Tab, no Alt
  and no Cmd to chord with, so the bar carries what those keys do; each action
  runs the same command its key does (`src/blocks/commands.ts`), in edit mode
  with the caret, so Indent by bar is Tab by key.

  | Main row        | Does                                                         | Notion's      |
  | --------------- | ------------------------------------------------------------ | ------------- |
  | Aa              | Swaps the row for the formatting row                         | Aa            |
  | ⇄ Turn into     | Swaps the row for the block types                            | Turn into     |
  | Outdent, Indent | `outdent`, `indent`; greyed where they would do nothing      | ⇤ ⇥           |
  | Undo, Redo      | Redo shows only while there is something to redo             | Undo          |
  | Image           | The picture picker (`requestImage`), where images are on     | Insert image  |
  | Delete          | `deleteBlock`, in the danger colour; the next row highlights | Delete        |
  | Keyboard down   | Ends the edit and puts the keyboard away                     | Keyboard down |

  The formatting row (Back, then bold, italic, strikethrough, code, link,
  maths) draws each button as the markdown renders it — a bold B, the inline
  code chip, √x — and wraps the selection in the marker, or takes it off
  again (`wrapBold` and the rest, ⌘B / ⌘I / ⌘⇧X / ⌘E / ⌘⇧K / ⌘⇧M by key).
  The Turn into row (Back, then ¶ - 1. [ ] # > and backticks in the inline
  code chip, the glyphs the query box's suggestions draw beside a type) slides one highlight to
  the current type; a pick returns to the main row. Left out of Notion's set,
  having no counterpart here: `+` add block (Return and the slash menu do
  it), `@` mention, comment, text colour and highlight, underline (no
  markdown for it), duplicate and move up / down (the block menu has them).

  Where the bar sits is the hard part. A `position: fixed` element lives in
  the _layout_ viewport, which an overlaying keyboard (iOS Safari) does not
  shrink, so a bar at `bottom: 0` is under the keyboard; and Safari's own
  bottom bar and the keyboard's accessory row (‹ › Done) take more of the
  screen again. The bar is pinned to the bottom of the _visual_ viewport
  instead — what is actually on screen — read from `window.visualViewport`:
  top-anchored at `offsetTop + height` and pulled up by its own height, from
  the visual viewport's own numbers alone (never `window.innerHeight`, which
  means different things in Safari, in a home-screen app and on Android).
  Where the keyboard shrinks the page instead (Chrome on Android, with the
  viewport meta's `interactive-widget=resizes-content`) the two viewports
  agree and the bar lands at the bottom of the page. The viewport's `resize`
  and `scroll` are listened to, the window's too, and a slow poll besides,
  since iOS does not always announce the keyboard's moves; iOS 26.0 also
  leaves the viewport 24px short after the keyboard goes (WebKit 297779,
  fixed in 26.1), which the keyboard threshold ignores. While the bar is up
  it sets `--edit-bar-inset` on the root — what the keyboard and the bar
  together cover — and the page's scroller pads by it (`page-layout.tsx`), so
  the end of a note can still be scrolled above them. Its buttons cancel
  their pointer down, so a tap never takes focus from the textarea — which
  would end the edit and dismiss the keyboard the bar sits on. iOS's
  accessory row has a Done of its own beside the bar's; Android has none, so
  the bar keeps it.

- **The keyboard is told what to do.** The textarea says `autocapitalize=
"sentences"` outright rather than leaving it to the browser's default, so a
  new block's first letter shifts; a code block says `off`, and switches
  autocorrect off with it. (If a fresh block still opens unshifted on iOS, that
  is WebKit not re-reading the attribute when focus is moved by script while
  the keyboard is already up — a known quirk with no page-side fix.)
- **Chrome is sized for a finger.** The collapse chevron always shows (nothing
  to hover with) at a 10px glyph on a 32px square; the zoom dot's hit area is
  26px; the todo checkbox grows its hit area through a pseudo-element; the
  type scale steps body text up and display sizes down
  (`src/styles/variables.css`).

## Elsewhere in the app

- A bottom nav bar (`nav-bar.tsx`) on narrow screens: menu drawer, back,
  forward, search (the ⌘K palette), new note. The app frame pads for the safe
  area; toasts float above the bar.
- Controls step up to 40px rows and inputs on a coarse pointer (`IconButton`,
  `Button`, `DropdownMenu`, `TextInput`, the search boxes); shortcut keycaps
  are hidden where there is nothing to press (`Keys`, `coarse:hidden`).
- Hover-only affordances show outright on touch: the note card's buttons, the
  code block's language. The image figure's toolbar is the exception by
  design — hidden until the row is selected (a long press), so a stray tap
  never lands on it.
- The block menu may take most of the screen on a phone (`coarse:max-h-[80svh]`)
  so its last items are never lost in a scroll.
- Qualifier suggestions under the search box take the box's full width on a
  touch screen (`query-box.tsx`).
- PWA: `display: standalone` in the manifest, an apple-touch-icon, the
  `theme-color` kept in step with the page background.

## Offline, on a phone

Two things a phone does that a desktop rarely does: it is closed and reopened
with no network, and it is handed the app as a home-screen install. Both go
through the service worker's precache (`vite.config.ts`), which must hold
everything a cold start needs — including the SQL store's worker chunk and
the sqlite wasm it loads, which are the notes themselves when signed in.
Without them a start offline never opens the store: nothing loads, and
nothing written is kept. The feature flags (`src/data/features.ts`) are
remembered per account on the device and stand from the start, so the Admin
page and the panels are as they were last time rather than hidden behind a
request that cannot return; the server is asked again when the network comes
back. What the flags gate on the server (the Admin page's own lists) still
needs the network to load.

Not a bug, though it can look like one: Enter on an _empty_ list item leaves
the list, as it does on a desktop — the block becomes a paragraph when the
default new-block type is that very list. Two quick Enters on a phone land
there.

## Gaps

Found while working through the editor; none is fixed here.

1. **Pinch zoom is disabled.** The viewport meta says `user-scalable=no`, which
   also suppresses Safari's zoom-on-focus for inputs under 16px. WCAG 1.4.4
   asks for zoom; the usual replacement is `touch-action: manipulation` on the
   editor (kills the double-tap zoom delay) with scaling allowed and inputs at
   16px or more, so the focus zoom never fires.
2. **Popups under the keyboard.** The slash menu hangs beneath the `/`, and the
   ⌘K dialog is `max-h-[75vh]` from the top. With an overlaying keyboard (iOS)
   either can sit under it. Both would want to be positioned against the
   visual viewport, as the edit bar is.
3. **No swipe to indent.** `docs/block-editor-architecture.md` plans a swipe
   right → `indent`, swipe left → `outdent` on a row; the command layer is
   ready for it (a gesture table beside the keymap). The edit bar and the menu
   cover the need for now.
4. **No touch drag to reorder.** Move up and Move down are the only way to
   reorder by finger; a press-and-drag handle on the bullet is the usual
   answer.
5. **No text selection across rows by finger.** The body is `select-none` on
   touch so a long press can open the menu; multi-row copy is the menu's Copy
   on one row at a time, or the selection ladder with a hardware keyboard.
6. **The help drawer is a keyboard reference.** `?` lists shortcuts that a
   phone cannot press; a touch screen would want a page on taps and holds
   instead.
7. **Row height.** Rows keep the desktop rhythm (a 15px line with 4px between
   nested rows, ~30px pitch) rather than the 44px Apple and 48px Material ask
   of a control. The whole-row tap target and the widened chrome cover the
   common taps; a denser outline was chosen over a taller one.
8. **The note title** is a plain input with no `autocapitalize`, so it takes
   the browser's default (sentences); a `words` hint may suit titles better.
9. **Bottom nav bar under an overlaying keyboard.** On iOS the bar sits under
   the keyboard while typing (the page is not resized); the edit bar takes its
   place there. With `resizes-content` (Android) it stays visible above.
10. **No install prompt or `apple-mobile-web-app-*` hints.** The manifest's
    `standalone` is honoured on modern iOS; a status-bar style hint and a
    "add to home screen" nudge are the usual extras.
