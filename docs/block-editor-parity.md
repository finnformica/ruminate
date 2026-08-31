# Block editor parity backlog

The app has consolidated on the **block editor** as its single editor; the
classic CodeMirror editor (`note-editor.tsx`) and its extensions have been
**removed**. This logs the editing features that lived only in CodeMirror so
they can be re-added to the block editor intentionally rather than lost
silently. Everything below is now an active backlog item (see git history of
the removed `src/codemirror-extensions/` for the original implementations).

## Missing in the block editor (candidates to rebuild)

- **Autocomplete as you type** (`@codemirror/autocomplete`, `tagsAtom`,
  `templatesAtom`, `useStableSearchNotes`):
  - `#` → tag suggestions
  - template insertion by name
  - (Wikilink autocomplete is gone for good — wikilinks were removed as a
    feature.)
- **In-editor natural-language dates** (`chrono-node`): resolving shorthand like
  "next monday" into a date while typing. (`chrono-node` stays in the repo — it's
  also used by the command menu, note picker, and search — but the _in-editor_
  parsing is CodeMirror-only.)
- **Template insertion at the cursor** (`insert-template.tsx` dispatches into a
  CodeMirror `EditorView`): the block editor has no `EditorView`, so mid-document
  template insertion needs a block-aware equivalent. (Daily/weekly templates that
  fill a _new_ note still work — that path is editor-independent.)
- **File attach at the cursor** (`hooks/attach-file.ts`): drag/paste an image and
  insert the markdown link at the caret. Needs a block-aware insertion point.
- **Frontmatter editing affordances** (`frontmatter` extension, `@codemirror/lang-yaml`):
  the block editor preserves frontmatter verbatim but doesn't surface it for
  editing inline (property editing lives separately in `property-value.tsx`).
- **Markdown source niceties**: syntax highlighting of raw markdown, `priority`,
  `ellipsis`, and `indented-line-wrap` display extensions. Mostly N/A by design —
  the block editor renders _rendered_ content per block rather than highlighted
  source — but noted for completeness.

## Intentionally dropped

- **Vim mode** (`@replit/codemirror-vim`, `vimModeAtom`, the `:w`/`:x`/`:wq`/`:q`
  ex-commands): removed with CodeMirror by decision, not deferred.

## Already covered by the block editor

For reference, these CodeMirror-era behaviours already exist natively in the
block editor and need no rebuild: block types (headings, todos, bullets, ordered,
quote), block references `((blk_…))` with live transclusion, collapse/expand,
per-block markdown rendering, multi-line paste split across blocks, browser
spellcheck (the block textarea sets `spellCheck`), and document-level undo/redo.
