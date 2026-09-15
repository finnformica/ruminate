/**
 * Inline links (docs/links.md): markdown in a block's text,
 * `[display text](url)`, dotted-underlined, opening in a new tab.
 *
 * A pasted bare address is rewritten to that form with the address's host
 * for its display text (`linkifyPastedText`), so
 * `https://mail.google.com/mail/u/0/#inbox/abc` reads as `mail.google.com`
 * and the address itself is kept whole. The hover card on a link
 * (`src/components/block-editor/link-hover-card.tsx`) visits it and changes
 * the display text.
 */

/** The host an address is of — `www.` dropped, and the address itself when
 * it is not a URL: the display text a bare address is given (nothing of
 * the scheme, the path or the query). */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "")
  } catch {
    return url
  }
}

/** Whether `url` is an http(s) address — what the hover card is for. */
export function isWebUrl(url: string): boolean {
  return /^https?:\/\/\S+$/i.test(url)
}

/** What a paste leaves alone: a link or image already written out, an
 * autolink in angle brackets, a code span, a code fence. */
const PROTECTED_RE = /(!?\[[^\]]*\]\([^)]*\)|<https?:\/\/[^>\s]+>|`[^`]*`|```[\s\S]*?(?:```|$))/g
/** A bare address in prose. */
const BARE_URL_RE = /https?:\/\/[^\s<>()[\]]+/g
/** Punctuation that ends the sentence rather than the address. */
const TRAILING_RE = /[.,;:!?'"]+$/

/**
 * Pasted text with every bare address rewritten as a link whose display
 * text is the address's host: `see https://www.example.com/a?b=1.` becomes
 * `see [example.com](https://www.example.com/a?b=1).` The address itself is
 * kept whole — only how it reads changes. A link already written out, an
 * image, a code span and a code fence are left as they are.
 */
export function linkifyPastedText(text: string): string {
  return text
    .split(PROTECTED_RE)
    .map((part, index) =>
      index % 2 === 1
        ? part
        : part.replace(BARE_URL_RE, (found) => {
            const trail = TRAILING_RE.exec(found)?.[0] ?? ""
            const url = trail ? found.slice(0, -trail.length) : found
            return `[${hostOf(url)}](${url})${trail}`
          }),
    )
    .join("")
}
