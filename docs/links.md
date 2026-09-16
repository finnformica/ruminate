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
<kbd>⇧</kbd> <kbd>V</kbd>).

An address needs no scheme to count: `www.` and anything after it is one,
and so is a name with one of a short list of common endings — `.com`,
`.org`, `.net`, `.io`, `.dev`, `.co`, `.ai`, `.app`, `.edu`, `.gov`,
`.me`, `.info`, `.uk` and `.co.uk` (with `.org.uk`, `.ac.uk`, `.gov.uk`),
`.de`, `.fr`, `.nl`, `.es`, `.it`, `.eu` — so `google.com` and
`bbc.co.uk/news` are written out as links to `https://google.com` and
`https://bbc.co.uk/news`. The list is short on purpose (`ENDINGS` in
`src/blocks/link.ts`): `node.js`, `file.txt`, `v1.2.3`, `links.md` and
`e.g.` must stay words, and an email address (`finn@gmail.com`), a path
(`docs/links.md`) or a name inside a longer address is never taken on its
own.

A typed address is written out the same way the moment a space is typed
after it, with the caret following, and any bare address still in the row
when you leave edit mode (<kbd>Esc</kbd>, <kbd>↵</kbd>, a click elsewhere)
is written out then. Each rewrite is its own undo step, so <kbd>⌘</kbd>
<kbd>Z</kbd> gives the bare address back. An address in a code block, a
code span, an autolink (`<https://…>`) or a link already written out is
left alone.

The rewrite is `linkifyPastedText` (`src/blocks/link.ts`), applied to the
pasted text in the row's paste handler before it is parsed, so it works
the same on a one-line paste into a sentence and a many-line paste that
becomes blocks of its own.

## The hover card

Hover a link in view mode (in an editor you can write in) and a small card
opens beneath it (`link-hover-card.tsx`), in the shape Notion's takes. At
rest it is a pill: the address, itself a link that opens the page in a new
tab; a button that copies it; and **Edit**. Edit opens the panel:

- **URL**, the address, editable: a new one (scheme or not; `docs.e.com`
  is taken as `https://docs.e.com`) points the link at it, and keeps the
  display text unless that was the old address;
- **Link title**, the display text. A link whose text is its own address
  is offered its host;
- **Remove link**, which takes the link off and leaves its text as words.

A field saves on <kbd>↵</kbd>, or on leaving it with its value changed; an
emptied field saves nothing. Each change rewrites the first occurrence of
that link in the block's text and is one undo step. A link that is not a
web address (`mailto:`, an anchor) has no card.

A touch screen has nothing to hover with, so the row's context menu
(press and hold) offers **Edit link**, which opens the same card outright
at its panel — straight away for a row with one link, and by display text
for a row with several. A tap outside closes it.

The card is only offered where the row can be written: the row provides
the actions (`link-actions.ts`) and the rendered link reads them
(`block-content.tsx`); a read-only view, a search result or the help panel
draws the link plain.
