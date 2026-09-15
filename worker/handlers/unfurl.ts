// Link previews — what a link block shows of the page it points at
// (docs/links.md, src/blocks/link.ts).
//
//   GET /api/unfurl?url=<address>   → { url, title?, description?, image?, favicon?, site }
//
// The Worker fetches the page on the reader's behalf and reads the tags a
// page uses to describe itself — Open Graph (`og:title`, `og:description`,
// `og:image`, `og:site_name`), Twitter's equivalents, the plain `<title>`
// and `<meta name="description">`, and the `<link rel="icon">` — and answers
// them as one small JSON object the client writes onto the block. The
// browser cannot do this itself: a page's HTML is not readable across
// origins, which is why every notes app that shows link cards fetches them
// from a server.
//
// AUTH: session-guarded like every other route (`requireSession`), so this
// Worker is nobody's open proxy. WHAT IT WILL FETCH: http(s) only, never a
// private or loopback address (so a session cannot be used to probe whatever
// sits behind the Worker), redirects followed by hand so each hop is checked
// the same way, and no more than `MAX_BYTES` of the page read — the tags are
// in the head; the rest is not wanted. A page that will not answer, is not
// HTML, or says nothing about itself still yields the address and its host,
// so a link block of it is a card with a name rather than an error.

import type { Env } from "../types"
import { requireSession } from "./replica"

export const UNFURL_PATH = "/api/unfurl"

/** How much of a page is read for its tags. The head of a page is a few
 * kilobytes; half a megabyte is generous and bounds a page that streams. */
export const MAX_BYTES = 512 * 1024
/** How long a page is given to answer, in ms. */
const TIMEOUT_MS = 8000
/** How many redirects are followed before giving up on the page. */
const MAX_REDIRECTS = 5
/** The longest title and description kept. A page's own summary of itself
 * is a sentence or two; anything longer is not one. */
const MAX_TITLE = 200
const MAX_DESCRIPTION = 500

const USER_AGENT =
  "Mozilla/5.0 (compatible; Ruminate/1.0; +https://github.com/finnformica/ruminate)"

export interface LinkPreview {
  url: string
  title?: string
  description?: string
  image?: string
  favicon?: string
  site: string
}

export async function unfurl(
  request: Request,
  env: Env,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  if (request.method !== "GET") return jsonResponse({ error: "method_not_allowed" }, 405)
  const session = await requireSession(request, env, fetchImpl)
  if (session instanceof Response) return session

  const target = new URL(request.url).searchParams.get("url") ?? ""
  const url = publicWebUrl(target)
  if (!url) return jsonResponse({ error: "invalid_url" }, 400)

  // A link to this app itself (a note's address, pasted from the bar): a
  // Worker cannot fetch its own hostname — the platform refuses the
  // subrequest — so the page is read from the static assets instead, the
  // same shell every app address serves. Without an assets binding (tests)
  // it is the address and its host.
  const own = url.host === new URL(request.url).host
  if (own && !env.ASSETS) return jsonResponse(previewOf(url.toString(), "", ""), 200)
  const fetcher: typeof fetch = own
    ? (input, init) => env.ASSETS.fetch(new Request(input, init))
    : fetchImpl

  const page = await fetchPage(url, fetcher)
  if (!page.ok) return jsonResponse({ error: page.error }, page.error === "invalid_url" ? 400 : 502)

  const preview = previewOf(page.url, page.contentType, page.html)
  return jsonResponse(preview, 200, { "Cache-Control": "private, no-store" })
}

// ── What may be fetched ──────────────────────────────────────────────────────

/**
 * The address as a URL this route will fetch, or null: http(s), no
 * credentials in it, and a host that is a public name — never localhost, a
 * `.local` or `.internal` name, or an IP literal in a private, loopback,
 * link-local or otherwise special range.
 */
export function publicWebUrl(address: string): URL | null {
  let url: URL
  try {
    url = new URL(address)
  } catch {
    return null
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null
  if (url.username !== "" || url.password !== "") return null
  const host = url.hostname.toLowerCase()
  if (host === "" || host === "localhost" || host.endsWith(".localhost")) return null
  if (host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".arpa")) return null
  if (!host.includes(".") && !host.startsWith("[")) return null
  if (isPrivateIpv4(host) || isPrivateIpv6(host)) return null
  return url
}

function isPrivateIpv4(host: string): boolean {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!match) return false
  const [a, b] = [Number(match[1]), Number(match[2])]
  return (
    a === 0 || // "this" network
    a === 10 || // private
    a === 127 || // loopback
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local, and cloud metadata endpoints
    (a === 172 && b >= 16 && b <= 31) || // private
    (a === 192 && b === 168) || // private
    (a === 192 && b === 0) || // IETF protocol assignments
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    a >= 224 // multicast and reserved
  )
}

function isPrivateIpv6(host: string): boolean {
  if (!host.startsWith("[")) return false
  const inner = host.slice(1, -1).toLowerCase()
  if (inner === "::1" || inner === "::") return true
  // Unique local (fc00::/7), link-local (fe80::/10), and IPv4-mapped
  // addresses (::ffff:a.b.c.d), which would carry a private v4 through.
  if (/^f[cd]/.test(inner) || /^fe[89ab]/.test(inner)) return true
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(inner)
  if (mapped) return isPrivateIpv4(mapped[1])
  return true // Any other literal: not a public name; nothing lost by refusing.
}

// ── Fetching the page ────────────────────────────────────────────────────────

type Page =
  | { ok: true; url: string; contentType: string; html: string }
  | { ok: false; error: "unreachable" | "too_many_redirects" | "invalid_url" }

/** Fetch the page, following redirects by hand so each hop is checked as
 * the first was, and read no more than `MAX_BYTES` of it. */
async function fetchPage(start: URL, fetchImpl: typeof fetch): Promise<Page> {
  let url = start
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    let response: Response
    try {
      response = await fetchImpl(url.toString(), {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
          "Accept-Language": "en",
        },
      })
    } catch {
      return { ok: false, error: "unreachable" }
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel()
      const location = response.headers.get("Location")
      if (!location) return { ok: false, error: "unreachable" }
      let next: URL | null
      try {
        next = publicWebUrl(new URL(location, url).toString())
      } catch {
        next = null
      }
      if (!next) return { ok: false, error: "invalid_url" }
      url = next
      continue
    }
    if (!response.ok) {
      await response.body?.cancel()
      return { ok: false, error: "unreachable" }
    }
    const contentType = (response.headers.get("Content-Type") ?? "").toLowerCase()
    const html = isHtml(contentType) ? await readPrefix(response, contentType) : ""
    if (!isHtml(contentType)) await response.body?.cancel()
    return { ok: true, url: url.toString(), contentType, html }
  }
  return { ok: false, error: "too_many_redirects" }
}

function isHtml(contentType: string): boolean {
  return contentType.startsWith("text/html") || contentType.startsWith("application/xhtml+xml")
}

/** The first `MAX_BYTES` of the body, decoded in the charset the response
 * declares (UTF-8 when it declares none, or one the platform lacks). */
async function readPrefix(response: Response, contentType: string): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) return ""
  const chunks: Uint8Array[] = []
  let total = 0
  while (total < MAX_BYTES) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    total += value.byteLength
  }
  if (total >= MAX_BYTES) await reader.cancel().catch(() => undefined)
  const bytes = new Uint8Array(Math.min(total, MAX_BYTES))
  let offset = 0
  for (const chunk of chunks) {
    const room = bytes.byteLength - offset
    if (room <= 0) break
    bytes.set(room >= chunk.byteLength ? chunk : chunk.subarray(0, room), offset)
    offset += Math.min(room, chunk.byteLength)
  }
  const charset = /charset=["']?([\w-]+)/i.exec(contentType)?.[1]
  let decoder: TextDecoder
  try {
    decoder = new TextDecoder(charset ?? "utf-8")
  } catch {
    decoder = new TextDecoder("utf-8")
  }
  return decoder.decode(bytes)
}

// ── Reading the tags ─────────────────────────────────────────────────────────

/** The preview a page's HTML yields: each field the first tag that gives
 * it, in order of how well the tag describes the page for this purpose. */
export function previewOf(url: string, contentType: string, html: string): LinkPreview {
  const site = hostOf(url)
  if (!isHtml(contentType) || html === "") return { url, site }
  const head = html.slice(0, MAX_BYTES)
  const meta = metaTags(head)
  const preview: LinkPreview = { url, site }
  const title = clean(
    meta.get("og:title") ?? meta.get("twitter:title") ?? titleTag(head) ?? "",
    MAX_TITLE,
  )
  if (title) preview.title = title
  const description = clean(
    meta.get("og:description") ?? meta.get("twitter:description") ?? meta.get("description") ?? "",
    MAX_DESCRIPTION,
  )
  if (description) preview.description = description
  const image = resolve(
    meta.get("og:image:secure_url") ??
      meta.get("og:image") ??
      meta.get("og:image:url") ??
      meta.get("twitter:image") ??
      meta.get("twitter:image:src"),
    url,
  )
  if (image) preview.image = image
  const favicon = resolve(iconLink(head) ?? "/favicon.ico", url)
  if (favicon) preview.favicon = favicon
  const siteName = clean(meta.get("og:site_name") ?? "", MAX_TITLE)
  if (siteName) preview.site = siteName
  return preview
}

/** `<meta property="og:…" content="…">` and `<meta name="…" content="…">`,
 * keyed by property or name (lower-cased), first occurrence wins. The tag
 * is read attribute by attribute, in whatever order the page wrote them. */
function metaTags(html: string): Map<string, string> {
  const tags = new Map<string, string>()
  for (const match of html.matchAll(/<meta\b([^>]*)>/gi)) {
    const attrs = attributesOf(match[1])
    const key = (attrs.get("property") ?? attrs.get("name"))?.toLowerCase()
    const content = attrs.get("content")
    if (!key || content === undefined) continue
    if (!tags.has(key)) tags.set(key, content)
  }
  return tags
}

function titleTag(html: string): string | undefined {
  const match = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  return match ? decodeEntities(match[1]) : undefined
}

/** The page's icon: the first `<link rel="icon">` (or `shortcut icon`,
 * `apple-touch-icon`) with an href. */
function iconLink(html: string): string | undefined {
  let fallback: string | undefined
  for (const match of html.matchAll(/<link\b([^>]*)>/gi)) {
    const attrs = attributesOf(match[1])
    const rel = (attrs.get("rel") ?? "").toLowerCase().split(/\s+/)
    const href = attrs.get("href")
    if (!href) continue
    if (rel.includes("icon")) return href
    if (rel.includes("apple-touch-icon") && fallback === undefined) fallback = href
  }
  return fallback
}

/** A tag's attributes, entity-decoded; quoted or bare values. */
function attributesOf(raw: string): Map<string, string> {
  const attrs = new Map<string, string>()
  for (const match of raw.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
    const name = match[1].toLowerCase()
    if (!attrs.has(name)) attrs.set(name, decodeEntities(match[2] ?? match[3] ?? match[4] ?? ""))
  }
  return attrs
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
}

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, entity: string) => {
    if (entity[0] === "#") {
      const code =
        entity[1] === "x" || entity[1] === "X"
          ? parseInt(entity.slice(2), 16)
          : parseInt(entity.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? whole
  })
}

/** Whitespace collapsed, trimmed, and cut to `max` characters. */
function clean(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim()
  return collapsed.length > max ? collapsed.slice(0, max - 1).trimEnd() + "…" : collapsed
}

/** An address resolved against the page's, kept only when it is http(s). */
function resolve(href: string | undefined, base: string): string | undefined {
  if (!href) return undefined
  try {
    const url = new URL(href.trim(), base)
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined
  } catch {
    return undefined
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "")
  } catch {
    return url
  }
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  })
}
