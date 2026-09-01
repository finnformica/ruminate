# Block editor architecture

How the block/outline editor turns input (keys today, touch/menus tomorrow) into
changes to a note, and where each responsibility lives.

## The three layers

The editor is split into three layers so behaviour is defined once and every
input method reuses it:

1. **Doc math — `src/blocks/ops.ts`.** Pure, immutable transforms on a
   `BlockDoc`: `indentBlock`, `outdentBlock`, `moveBlock`, `removeBlock`,
   `insertAfter`, `updateContent`, … No UI, no selection, no React. Trivially
   testable.

2. **Commands — `src/blocks/commands.ts`.** Named, input-agnostic _intents_
   ("indent this block", "split at the caret", "delete this block", "move the
   highlight up"). A command is a pure function
   `(CommandInput) => CommandResult`: it reads the doc plus a little UI context
   (the target block, the on-screen order, the caret, the zoom root) and
   returns _what should change_ — a new doc + history op, where focus should
   land, whether a block's collapse toggles, whether navigation ran off the
   top, or a zoom change (zoom itself is URL state — `?block=` — owned by the
   note route; the editor only requests it). It never touches React or the DOM.
   The editor component applies the result.

3. **Bindings — `src/blocks/keymap.ts`.** A declarative table mapping a mode +
   key combo (and, where it matters, a caret predicate) to a command name. This
   table _is_ the spec of the editor's keyboard behaviour: greppable in one
   place and unit-tested (`keymap.test.ts` also checks every bound command
   exists).

The React components are thin:

- `block-item.tsx` (the entry point) gathers the raw event + local DOM state
  (caret offsets, whether the caret is on the first/last visual line) and calls
  `api.dispatchKey(mode, id, event, caret)`. If it returns "handled", it
  `preventDefault`s.
- `block-editor.tsx` (the controller) owns the document, selection/focus,
  collapse, and undo history. `dispatchKey` resolves the event through the
  keymap, runs the command, and applies the `CommandResult`.

```
key / touch / menu ─▶ entry point ─▶ resolveKey (keymap) ─▶ COMMANDS[name] (pure)
                                                                    │
                        controller applies CommandResult ◀──────────┘
                     (history.commit · setFocus/setSelected · toggle collapse)
```

### Why this shape

- **One definition, many inputs.** A swipe-right on a block (planned for mobile)
  dispatches the same `indent` command that <kbd>Tab</kbd> does. Touch would add
  a second bindings table (gesture → command name) beside the keymap; the
  command and doc-math layers don't change at all.
- **It can't silently erode.** The behaviour lives as data (the keymap) and pure
  functions (the commands), both covered by tests, rather than as `if/else`
  ladders buried in event handlers.
- **It's cheap to reason about.** Commands are pure, so a test asserts
  "`splitPlain` at caret 2 of `- hello` yields `- he` + `llo`" with no DOM.

This mirrors how CodeMirror 6 and ProseMirror are built (commands +
keymaps), and how VS Code dispatches everything through named command ids.

## Adding a behaviour

1. If it needs a new doc transform, add a pure function to `ops.ts` (+ test).
2. Add a command to `COMMANDS` in `commands.ts` (+ test). Return a
   `CommandResult` — don't touch React.
3. Bind a key to it in `KEYMAP` in `keymap.ts` (+ a resolution test if the combo
   is caret-dependent).

That's the whole change — no component edits for a standard key behaviour.

## Future: user-overridable keymaps

The keymap is currently a hard-coded default. Because it's already plain data,
the intended path is to let a user override it from their repo:

- Store overrides in `.ruminate/keymap.json` (synced with the notes, like the
  collapse-state sidecar in `.ruminate/view-state.json`), mapping combos to
  command names.
- Merge them over the built-in `KEYMAP` at load, exposing a settings UI to edit
  them.
- Commands stay the stable, named surface the overrides bind to.

This is deliberately **not built yet** — the defaults are the only keymap today
— but the layering is arranged so it's an additive change when we want it.

## Deferred / proposed features

Two requested features touch enough of the data model or the hot editing path
that they're captured here rather than rushed:

### Natural-language dates (`[[today]]` → a date link)

Obsolete: this was a wikilink feature, and wikilinks were removed. `[[...]]`
in a note is plain text now.

### Title-derived slugs for note URLs

Goal: derive a note's URL from its title rather than a timestamp id
(`generateNoteId()` currently returns `Date.now()`), with a uniqueness check to
avoid collisions.

Open questions / why deferred (a genuine data-model fork, needs a decision):

- **Does the slug replace the filename/id, or sit beside it?** Today the note id
  _is_ the filename _is_ the URL. Slugging the filename means renaming files as
  titles change and re-slugging on collisions — and, since page ids are minted
  now (docs/page-identity-design.md), giving back the property that makes a
  rename free: nothing tracks a page's former addresses, so a slug rename would
  leave the old URL dead.
- **Alternatively**, keep the stable id as the filename and add a slug purely for
  the URL (a slug→id lookup), leaving sync untouched. This is less disruptive
  but adds an indirection layer.

Both are viable; the choice changes routing and sync, so it should be settled
deliberately before implementing.
