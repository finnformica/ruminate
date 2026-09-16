import type { Block, BlockProps } from "./types"

/**
 * Links (docs/links.md) come in two forms, and this module holds what is
 * shared between them.
 *
 * An **inline link** is markdown in a block's text, `[display text](url)`:
 * dotted-underlined, opening in a new tab. A pasted bare address is
 * rewritten to that form with the address's host for its display text
 * (`linkifyPastedText`), so `https://mail.google.com/mail/u/0/#inbox/abc`
 * reads as `mail.google.com`; the hover card on a link changes the text and
 * makes a block of it.
 *
 * A **link block** (`link`) is a link kept as a card in the outline, with
 * the page's preview — so a page you will need again (a booking, a
 * receipt, an article) is a row you can see rather than an address you
 * have to follow. Its `text` is the title (what search matches, and what
 * you edit, as a picture's caption is); its `props` hold the address and
 * the page's preview, fetched once when the block is made
 * (`src/data/link-previews.ts`) and kept on the block, so a note full of
 * them opens without a request and reads the same offline:
 *
 * - `url` — the address. The one prop a link block cannot be without.
 * - `description`, `image`, `favicon`, `site` — the page's own preview
 *   (its Open Graph tags, `worker/handlers/unfurl.ts`), each absent when the
 *   page said nothing.
 *
 * How the card sits in its row (`align`, `size`) is the figure layout it
 * shares with pictures (`figure.ts`).
 *
 * In markdown the block is one line, `[title](url)` — the inline link it
 * was made from — which is what the serializer writes. The parser reads
 * that line back as an inline link, never a block: a link alone on its
 * line is common once pasted addresses are rewritten, and a card is a
 * choice the hover card makes, not something an import guesses at.
 */
export interface LinkProps {
  url: string
  description?: string
  image?: string
  favicon?: string
  site?: string
}

/** What the unfurl route answers, and what a refresh writes over the
 * block's preview: the address as finally reached (after redirects) and
 * the page's own summary of itself. */
export interface LinkPreview {
  url: string
  title?: string
  description?: string
  image?: string
  favicon?: string
  site?: string
}

const PREVIEW_KEYS = ["description", "image", "favicon", "site"] as const

/** The link props of a block, read leniently: a block without an address
 * is a link to nothing (the card says so), never a crash. */
export function linkPropsOf(block: Pick<Block, "props">): LinkProps {
  const props = block.props ?? {}
  const out: LinkProps = { url: typeof props.url === "string" ? props.url : "" }
  for (const key of PREVIEW_KEYS) {
    const value = props[key]
    if (typeof value === "string" && value !== "") out[key] = value
  }
  return out
}

/**
 * The block's props with a fetched preview written over the old one: the
 * address stays the one the block was made with (a redirect's final
 * address is the page's business, not the note's), every preview field is
 * replaced — a page that no longer says anything loses its old description
 * rather than keeping a stale one — and the layout is kept.
 */
export function withLinkPreview(block: Pick<Block, "props">, preview: LinkPreview): BlockProps {
  const next: BlockProps = { ...(block.props ?? {}) }
  for (const key of PREVIEW_KEYS) {
    const value = preview[key]
    if (typeof value === "string" && value !== "") next[key] = value
    else delete next[key]
  }
  return next
}

/** The host an address is of — `www.` dropped, and the address itself when
 * it is not a URL: the card's byline when the page gave no site name, and
 * the display text a bare address is given (nothing of the scheme, the
 * path or the query). */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "")
  } catch {
    return url
  }
}

/** The block's one markdown line: `[title](url)`. */
export function linkLine(block: Pick<Block, "text" | "props">): string {
  return `[${block.text}](${linkPropsOf(block).url})`
}

/** Whether `url` is an http(s) address, as a link block needs. */
export function isWebUrl(url: string): boolean {
  return /^https?:\/\/\S+$/i.test(url)
}

/** A whole line that is one link — `[title](url)` — and nothing else. The
 * title may hold inline markdown (`**bold**`) but no `]`; the address runs
 * to the closing paren, unspaced. */
const LINK_LINE_RE = /^\[([^\]]*)\]\(([^)\s]+)\)$/
/** A whole line that is one bare address. */
const URL_LINE_RE = /^https?:\/\/[^\s<>()]+$/i

/**
 * The link a block's text IS, when the text is one link and nothing else —
 * a bare address, or `[title](url)` — so the hover card's "Turn into block"
 * turns the block itself into the link block. A sentence with a link in it
 * yields null, and the block goes in beneath.
 */
export function wholeTextLink(text: string): { url: string; title: string } | null {
  const trimmed = text.trim()
  if (URL_LINE_RE.test(trimmed)) return { url: trimmed, title: "" }
  const match = LINK_LINE_RE.exec(trimmed)
  if (!match || !isWebUrl(match[2])) return null
  return { url: match[2], title: match[1] }
}

/** What a paste leaves alone: a link or image already written out, an
 * autolink in angle brackets, a code span, a code fence. */
const PROTECTED_RE = /(!?\[[^\]]*\]\([^)]*\)|<https?:\/\/[^>\s]+>|`[^`]*`|```[\s\S]*?(?:```|$))/g

/**
 * The endings a scheme-less address is recognised by: `google.com`,
 * `bbc.co.uk`, `socket.io`. A short list on purpose — `node.js`, `file.txt`,
 * `v1.2.3`, `links.md` and `e.g.` must stay words — of the endings that are
 * overwhelmingly addresses when they appear in a note. A `www.` needs no
 * list: it is an address whatever follows.
 */
const ENDINGS =
  "com|org|net|io|dev|co|ai|app|edu|gov|me|info|co\\.uk|org\\.uk|ac\\.uk|gov\\.uk|uk|de|fr|nl|es|it|eu"

/**
 * A bare address in prose: one with a scheme, or one without — `www.`
 * and anything, or a name with one of the endings above — that begins a
 * word (not part of an email address, a path, or a longer address) and
 * ends one — a full stop after it is the sentence's — with an optional
 * path after it.
 */
const ADDRESS =
  "https?:\\/\\/[^\\s<>()[\\]]+" +
  "|(?<![\\w@./:-])(?:www\\.[a-z0-9-]+(?:\\.[a-z0-9-]+)*" +
  `|[a-z0-9-]+(?:\\.[a-z0-9-]+)*\\.(?:${ENDINGS}))` +
  "(?=[/?#]|[^\\w.-]|\\.(?:\\s|$)|$)(?:[/?#][^\\s<>()[\\]]*)?"
const BARE_URL_RE = new RegExp(ADDRESS, "gi")
const TYPED_ADDRESS_RE = new RegExp(`(?:${ADDRESS})$`, "i")
/** Punctuation that ends the sentence rather than the address. */
const TRAILING_RE = /[.,;:!?'"]+$/

/** The address as a link's href: a scheme-less one is taken as https. */
export function hrefOf(address: string): string {
  return /^https?:\/\//i.test(address) ? address : `https://${address}`
}

/** A bare address found in text, less the punctuation that ended the
 * sentence: the address, its href, and the punctuation to put back. */
function bareAddress(found: string): { address: string; href: string; trail: string } {
  const trail = TRAILING_RE.exec(found)?.[0] ?? ""
  const address = trail ? found.slice(0, -trail.length) : found
  return { address, href: hrefOf(address), trail }
}

/**
 * Pasted text with every bare address rewritten as a link whose display
 * text is the address's host: `see https://www.example.com/a?b=1.` becomes
 * `see [example.com](https://www.example.com/a?b=1).` and `google.com`
 * becomes `[google.com](https://google.com)`. The address itself is kept
 * whole — only how it reads changes. A link already written out, an image,
 * a code span and a code fence are left as they are.
 */
export function linkifyPastedText(text: string): string {
  return text
    .split(PROTECTED_RE)
    .map((part, index) =>
      index % 2 === 1
        ? part
        : part.replace(BARE_URL_RE, (found) => {
            const { href, trail } = bareAddress(found)
            return `[${hostOf(href)}](${href})${trail}`
          }),
    )
    .join("")
}

/** What the address may not follow to be bare: the opening of a link's
 * address, an autolink, a quote. */
const NOT_BARE_BEFORE = /[(<["'`]$/

/**
 * The text with an address just typed and then followed by a space written
 * out as a link — `see https://e.com/x |` becomes `see [e.com](https://e.com/x) |`
 * — and where the caret then sits. Null when the character before the caret
 * is not whitespace, or what precedes it is not a bare address (one inside a
 * link, an autolink or a code span is left alone).
 */
export function linkifyTypedAddress(
  text: string,
  caret: number,
): { text: string; caret: number } | null {
  if (caret < 2 || !/\s/.test(text[caret - 1])) return null
  const before = text.slice(0, caret - 1)
  const match = TYPED_ADDRESS_RE.exec(before)
  if (!match) return null
  const lead = before.slice(0, match.index)
  if (NOT_BARE_BEFORE.test(lead)) return null
  // An odd number of backticks before it: inside a code span.
  if ((lead.match(/`/g)?.length ?? 0) % 2 === 1) return null
  const linked = linkifyPastedText(match[0])
  if (linked === match[0]) return null
  const head = lead + linked + text[caret - 1]
  return { text: head + text.slice(caret), caret: head.length }
}

/** The web links in a block's text, in order: each `[title](url)` and each
 * bare address, as what the menu's "Edit link" offers. */
export function linksInText(text: string): { href: string; title: string }[] {
  const links: { href: string; title: string }[] = []
  const re = new RegExp(`\\[([^\\]]*)\\]\\((https?:\\/\\/[^)\\s]+)\\)|(${ADDRESS})`, "gi")
  for (const match of text.matchAll(re)) {
    if (match[2]) links.push({ href: match[2], title: match[1] })
    else if (match[3]) {
      const { address, href } = bareAddress(match[3])
      links.push({ href, title: address })
    }
  }
  return links
}
