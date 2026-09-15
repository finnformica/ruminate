# Links

A link in a note is markdown in the block's text, `[display text](url)`:
dotted-underlined, opening in a new tab. What this page adds to that:

## A pasted address gets a name

Paste `https://www.example.com/a/b?c=1` and the block holds
`[example.com](https://www.example.com/a/b?c=1)`: the display text is the
address's host, with the scheme, the path and the query left out of it,
and the address itself is kept whole. Only how the link reads changes. A
link already written out, an image, a code span and a code fence in the
paste are left as they are, as is a paste as plain text (<kbd>⌘</kbd>
<kbd>⇧</kbd> <kbd>V</kbd>). A typed address is not rewritten as you type;
its hover card offers the host as its display text.

The rewrite is `linkifyPastedText` (`src/blocks/link.ts`), applied to the
pasted text in the row's paste handler before it is parsed, so it works
the same on a one-line paste into a sentence and a many-line paste that
becomes blocks of its own.

## The hover card

Hover a link in view mode (in an editor you can write in) and a small card
opens beneath it (`link-hover-card.tsx`):

- where the link goes, and **Visit**, which opens the page in a new tab,
  always;
- a field for the display text, saved on <kbd>↵</kbd> or on leaving the
  field with it changed. An emptied field saves nothing. A link whose text
  is its own address is offered its host.

Changing the display text rewrites `[old](url)` to `[new](url)` in the
block's text — the first occurrence of that link — and is one undo step. A
link that is not a web address (`mailto:`, an anchor) has no card.

The card is only offered where the row can be written: the row provides
the actions (`link-actions.ts`) and the rendered link reads them
(`block-content.tsx`); a read-only view, a search result or the help panel
draws the link plain.
