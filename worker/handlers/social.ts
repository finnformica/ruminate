// The Open Graph / Twitter tags — what a Ruminate link unfurls as when it is
// pasted into a message, a chat or a timeline.
//
// An unfurler is not a browser: it fetches the page, reads the `<head>` and
// leaves. It runs no JavaScript, so the titles the router sets as you move
// around the app (`Route.head`) are invisible to it — which is why these tags
// are written here, into the HTML the Worker hands back, rather than in the
// app.
//
// Two links are worth a card, and they are the two people actually send:
//
//   /            the app itself — "here is the thing I use"
//   /invite/…    an invite link — "here is a door, it is for you"
//
// Everything else is somebody's private note. A crawler that asks for one
// gets the page's own title and nothing more: no card, and nothing said about
// a note whose address happened to be forwarded. That is not an access
// control (the note's content needs a session either way); it is a refusal to
// help a link leak.
//
// `wrangler.jsonc` decides which paths reach the Worker at all
// (`assets.run_worker_first`) — these two paths are listed there for this.
// The pictures are `public/og-card.png` and `public/og-invite.png`, drawn by
// `scripts/og-cards.mjs`.

/** The width and height every unfurler is told to expect (`scripts/og-cards.mjs`). */
const CARD_WIDTH = "1200"
const CARD_HEIGHT = "630"

interface SocialCard {
  title: string
  description: string
  /** The picture, as a path on this origin — made absolute per request. */
  image: string
  /** What the picture says, for a reader who cannot see it. */
  alt: string
}

const APP_CARD: SocialCard = {
  title: "Ruminate",
  description: "A block-based note-taking app for better thinking.",
  image: "/og-card.png",
  alt: "Ruminate — a note as an outline of blocks, with a ticked todo.",
}

const INVITE_CARD: SocialCard = {
  title: "You’re invited to Ruminate",
  description:
    "Sign in with GitHub through this link for a private notes database of your own. " +
    "GitHub is used for identity only; your notes never touch a repository.",
  image: "/og-invite.png",
  alt: "An invitation to Ruminate — a note as an outline of blocks, with a ticked todo.",
}

/** The paths the Worker renders a card for, as `run_worker_first` patterns. */
export const SOCIAL_PATHS = ["/", "/invite/*"] as const

/** Whether this request is one of those paths — an HTML navigation, not an
 * asset or an API call. */
export function isSocialPath(pathname: string): boolean {
  return pathname === "/" || pathname === "/invite" || pathname.startsWith("/invite/")
}

/** The card a path unfurls as. An invite link says it is an invite; every
 * other path the Worker serves HTML for is the app. */
function cardFor(pathname: string): SocialCard {
  return pathname === "/invite" || pathname.startsWith("/invite/") ? INVITE_CARD : APP_CARD
}

/** Attribute-safe text. These strings are ours, not a user's, but a card is
 * markup written into a page — it is escaped because that is what markup
 * written into a page is. */
function attr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

/**
 * The tags for one path, at one origin.
 *
 * The origin is the request's own, never a constant: the same Worker serves
 * the production domain, the workers.dev address and every preview URL, and a
 * card whose picture points at another origin is a card that does not load.
 * `og:image` must be absolute — a relative one is resolved by some unfurlers
 * and dropped by others, which is the worst of both.
 */
export function socialMeta(origin: string, pathname: string): string {
  const card = cardFor(pathname)
  const image = new URL(card.image, origin).toString()
  const url = new URL(pathname, origin).toString()
  const tags: [string, string][] = [
    ["og:type", "website"],
    ["og:site_name", "Ruminate"],
    ["og:title", card.title],
    ["og:description", card.description],
    ["og:url", url],
    ["og:image", image],
    ["og:image:width", CARD_WIDTH],
    ["og:image:height", CARD_HEIGHT],
    ["og:image:alt", card.alt],
  ]
  const named: [string, string][] = [
    ["description", card.description],
    // Without this a picture this shape is cropped to a thumbnail beside the
    // text rather than shown above it.
    ["twitter:card", "summary_large_image"],
    ["twitter:title", card.title],
    ["twitter:description", card.description],
    ["twitter:image", image],
    ["twitter:image:alt", card.alt],
  ]
  return [
    ...tags.map(
      ([property, content]) => `<meta property="${property}" content="${attr(content)}">`,
    ),
    ...named.map(([name, content]) => `<meta name="${name}" content="${attr(content)}">`),
  ].join("")
}

/**
 * The SPA's HTML with this path's card in its head, and its title set to
 * match.
 *
 * Only an HTML response is touched: the SPA fallback can hand back anything
 * (a 404 from a misconfigured asset binding, a redirect), and rewriting one
 * of those would turn a clear failure into a confusing one. The `etag` goes
 * with the rewrite — the bytes are no longer the ones it names, and a stale
 * validator is a cached card that never changes.
 */
export function withSocialMeta(response: Response, origin: string, pathname: string): Response {
  const type = response.headers.get("content-type") ?? ""
  if (!type.includes("text/html")) return response
  const headers = new Headers(response.headers)
  headers.delete("etag")
  const meta = socialMeta(origin, pathname)
  const title = cardFor(pathname).title
  return new HTMLRewriter()
    .on("title", {
      element(element) {
        element.setInnerContent(title)
      },
    })
    .on("head", {
      element(element) {
        element.append(meta, { html: true })
      },
    })
    .transform(new Response(response.body, { status: response.status, headers }))
}
