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
- **Selecting is the long press.** A press-and-hold opens the block menu on the
  row and highlights it (`block-context-menu.tsx`), which is where the row-level
  actions live. On a touch screen the menu also carries the structure moves —
  Indent, Outdent, Move up, Move down — which a mouse's menu leaves to the keys.
- **An edit outlives the keyboard.** Putting the keyboard away (iOS's Done key,
  a tap on blank page) blurs the textarea with nowhere for focus to go. With a
  mouse that ends the edit; by finger the textarea stays in place, unfocused,
  and a tap on it brings the keyboard back with the caret where it was. Focus
  going to a real control — a link, a menu, another row — ends the edit as it
  does anywhere. (Android's back button hides the keyboard without blurring at
  all, so there the edit was never in question.)
- **The edit bar** (`mobile-edit-bar.tsx`) sits above the keyboard while a row
  is edited: Outdent, Indent, Move up, Move down, Undo, Redo and Done. A
  phone's keyboard has no Tab, no Alt and no arrows, so these are the only way
  to those commands mid-edit; each runs the same command its key does
  (`src/blocks/commands.ts`), in edit mode with the caret, so Indent by bar is
  Tab by key. Done puts the keyboard away and leaves the row highlighted. The
  bar is fixed to the bottom of the _visual_ viewport, tracked through
  `window.visualViewport`, so it rides the keyboard whether the keyboard
  overlays the page (iOS Safari) or shrinks it (Chrome on Android, with the
  viewport meta's `interactive-widget=resizes-content`). Its buttons cancel
  their pointer down, so a tap never takes focus from the textarea — which
  would end the edit and dismiss the keyboard the bar sits on.
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
