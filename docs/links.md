# Links

A link takes one of two forms in a note. An **inline link** is text: a link
in a sentence, dotted-underlined, opening in a new tab. A **link block** is
a card of its own in the outline, with the page's preview, so a page you
will need again — a booking, a receipt, a ticket, an article — is a row you
can see rather than an address you have to follow. Hover either and the
same small card opens over it: **Visit**, the link's display text, and the
switch to the other form.

## Inline links

An inline link is markdown in the block's text, `[display text](url)`, as
it has always been.

### An address gets a name

Paste `https://www.example.com/a/b?c=1` and the block holds
`[example.com](https://www.example.com/a/b?c=1)`: the display text is the
address's host, with the scheme, the path and the query left out of it,
and the address itself is kept whole. Only how the link reads changes. A
link already written out, an image, a code span and a code fence in the
paste are left as they are, as is a paste as plain text (<kbd>⌘</kbd>
<kbd>⇧</kbd> <kbd>V</kbd>).

A typed address is written out the same way the moment a space is typed
after it, with the caret following, and any bare address still in the row
when you leave edit mode (<kbd>Esc</kbd>, <kbd>↵</kbd>, a click elsewhere)
is written out then. Each rewrite is its own undo step, so <kbd>⌘</kbd>
<kbd>Z</kbd> gives the bare address back. An address in a code block, a
code span, an autolink (`<https://…>`) or a link already written out is
left alone.

The rewrite is `linkifyPastedText` (`src/blocks/link.ts`), applied to the
pasted text in the row's paste handler before it is parsed, and to the
row's text when its edit ends; `linkifyTypedAddress` is the one a typed
space runs.

### The hover card

Hover a link in view mode (in an editor you can write in) and a small card
opens beneath it (`link-hover-card.tsx`):

- where the link goes, and **Visit**, which opens the page in a new tab,
  always;
- a field for the display text, saved on <kbd>↵</kbd> or on leaving the
  field with it changed. An emptied field saves nothing. A link whose text
  is its own address is offered its host;
- **Turn into block**, below.

Changing the display text rewrites `[old](url)` to `[new](url)` in the
block's text — the first occurrence of that link — and is one undo step. A
link that is not a web address (`mailto:`, an anchor) has no card.

A touch screen has nothing to hover with, so the row's context menu
(press and hold) offers **Edit link**, which opens the same card outright
— straight away for a row with one link, and by display text for a row
with several. A tap outside closes it.

The card is only offered where the row can be written: the row provides
the actions (`link-actions.ts`) and the rendered link reads them
(`block-content.tsx`); a read-only view, a search result or the help panel
draws the link plain.

## Link blocks

**Turn into block** on the hover card — or **Turn into → Link** in the
row's context menu, which takes the row's first link — goes one of two
ways. A block whose text is nothing but the link — a pasted address, or
`[title](url)` on its own — becomes the link block itself, keeping its
place in the outline (and its pin, if pinned). A link in a sentence leaves
the sentence as it is, and the block goes in as a new row beneath it,
titled as the link was.

The card shows the page's title (the block's text), its description (two
lines at most) and a byline of favicon and site name, with the page's
picture at the side when it has one. The byline and the picture are links
that open the page in a new tab; so do **Open link**, first in the small
toolbar that appears in the card's corner on hover, and in the context
menu. A click anywhere else on the card selects the row, as a click beside
a picture does; double-click edits the title (**Edit title** in the menu).
Hover the card and the same hover card opens over it as over an inline
link: **Visit**, the display text — the block's title — and **Turn into
inline**, which puts the link back in the text as `[title](url)` (also in
the context menu, for a keyboard or a touch screen, beside **Edit link**,
which opens the card outright).

A link block whose page said nothing — not yet fetched, a page that will
not answer, a page behind a sign-in — says **No preview available** where
the description would be, over the address, and shows the title only when
it is a title: a name you gave the link, or one the page gave it. A title
that is only the address's host (what a pasted address is named) is left
to the byline, which says it already; editing shows the title line
whatever it holds. Pictures and favicons that fail to load are simply not
shown.

### The block

A link block is an ordinary node in the graph (docs/graph-schema-v2.md):

| field   | holds                                                                                                                                             |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `type`  | `link`                                                                                                                                            |
| `text`  | the title — what you edit, and what search matches                                                                                                |
| `props` | `url`, the address; `description`, `image`, `favicon`, `site`, the page's preview, each absent when the page said nothing; `align`/`size` (below) |

The preview is fetched **once**, when the block is made, and kept on it: a
note full of link blocks opens without a request, syncs like any other
rows, and reads the same offline. It is a snapshot of what the page said at
the time; **Refresh preview** in the context menu asks again, and writes
whatever the page now says (a page that no longer describes itself loses
its old description rather than keeping a stale one). An untitled block
takes the page's title when a preview lands; a titled one keeps yours.

In markdown (the note rollup, copy/paste, export) the block is one line,
the inline link it was made from:

```
[Flight to Lisbon](https://mail.example.com/u/0/#inbox/18f2c3)
```

The parser reads that line back as an inline link, never a block. A link
alone on its line is common once pasted addresses are given names, and a
card is a choice the hover card makes, not something an import guesses at;
so a round trip through markdown keeps the link and drops the card. The
clipboard's html flavour writes the block as a paragraph holding the link,
which every composer keeps, and copying within the app carries the block
whole.

Search: `type:link` finds link blocks; the title is what text queries
match.

### Layout

Link blocks and pictures are both **figures** (`src/blocks/figure.ts`):
blocks whose row is a thing set in the text rather than a line of it, and
which share one layout — `align`, the side of the row the figure keeps to,
and `size`, its width as a percentage of the row's — and one frame that
draws it (`figure-frame.tsx`): the handles at the figure's sides, the
toolbar in its corner, and the **Align** and **Full width** (a picture's
**Original size**) items in the context menu. See docs/images.md for the
details; a card behaves exactly as a picture does, except that its natural
width is the row's.

## Fetching the preview

`GET /api/unfurl?url=<address>` (`worker/handlers/unfurl.ts`) fetches the
page on the reader's behalf and reads the tags a page uses to describe
itself — Open Graph (`og:title`, `og:description`, `og:image`,
`og:site_name`), Twitter's equivalents, the plain `<title>` and
`<meta name="description">`, and `<link rel="icon">` (falling back to
`/favicon.ico`) — and answers them as one small JSON object:

```
{ url, title?, description?, image?, favicon?, site }
```

The browser cannot do this itself — a page's HTML is not readable across
origins — which is why every notes app that shows link cards fetches them
from a server. The route is session-guarded like every other, so the Worker
fetches pages for its own users and no one else; the site sees Cloudflare's
address, not the reader's. It fetches http(s) only, never a private,
loopback or link-local address (so a session cannot be used to probe
whatever sits behind the Worker), follows redirects by hand so each hop is
checked the same way, waits eight seconds at most, and reads no more than
half a megabyte of the page — the tags are in the head. A page that will not
answer, is not HTML, or says nothing about itself still yields the address
and its host, so the block is a card with a name rather than an error. A
link to the app itself (a note's address) is read from the app's own
static assets, since a Worker cannot fetch its own hostname.

The client (`src/data/link-previews.ts`) asks when a block is made and on
**Refresh preview**, and writes the answer onto the block **without a
history step**, so the whole block is one undo, as a picture's upload is. A
fetch that fails says why in a toast, naming the host — the block is there
to open either way. Signed out (the sample notes) there is no session to
fetch through: a block is still made, with its address alone, and the menu
offers no refresh.

## What a preview can and cannot show

A preview is what the page **tells a stranger**. A public page — a shop, an
article, a video, a public repository — describes itself in its tags, and
the card shows it. A page behind a sign-in — a mail message, an issue in a
private tracker, a document shared with you — tells a stranger to sign in,
and the card shows the host and whatever title you give it. Showing such a
page's content would need Ruminate to hold a credential for that service
and ask its API, one integration per service; none exists yet. Until then
the block is the address, kept where you will find it, and the title is
yours to write.
