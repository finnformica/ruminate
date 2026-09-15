// Signed image links — how an agent downloads a picture without a browser
// session (docs/images.md, "Reading through MCP").
//
// `GET /api/images/<id>` takes the browser's session. An MCP client has no
// session and no way to add a header to a download, so `get_image`
// (worker/mcp/tools.ts) mints a link the images handler accepts on its own:
//
//   /api/images/<id>?exp=<unix seconds>&tok=<mcp token id>&sig=<base64url>
//
// `sig` is an HMAC-SHA256, under a secret only the Worker holds
// (`IMAGE_LINK_SECRET`), over the tenant, the asset, the token and the
// expiry. The tenant is NOT in the URL: the handler reads it off the token
// row `tok` names, exactly as the MCP endpoint does, so a link can no more
// steer the R2 key than a tool call can — and the same read is what lets a
// revoked token's links die with it, rather than living out their expiry.
//
// This is the presigned-URL idea kept on the app's own route. R2's own
// presigning needs an S3 access key held by the Worker and serves from the
// bucket's S3 host; this needs one HMAC secret that can only ever sign
// links, and serves through the binding that already does.

/** How long a link lasts. Long enough to download a picture, short enough
 * that a link pasted somewhere it should not be is soon nothing. */
export const IMAGE_LINK_TTL_SECONDS = 15 * 60

/** What a link asserts. All four are under the signature. */
export interface ImageLinkClaims {
  /** The tenant (verified GitHub id) whose asset it is. */
  userId: number
  imageId: string
  /** The MCP token the link was minted for (`mcp_…`). */
  tokenId: string
  /** Unix seconds. */
  expiresAt: number
}

const encoder = new TextEncoder()

async function hmacKey(secret: string, usage: "sign" | "verify"): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    [usage],
  )
}

/** The bytes the signature covers. Newline-joined: none of the fields can
 * contain one (an id, an id, a number), so the fields cannot run together. */
const payloadOf = (claims: ImageLinkClaims): Uint8Array =>
  encoder.encode(`${claims.userId}\n${claims.imageId}\n${claims.tokenId}\n${claims.expiresAt}`)

const base64url = (bytes: Uint8Array): string => {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

/** `sig` back to bytes, or null when it is not base64url at all. */
function fromBase64url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) return null
  const padded =
    text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4)
  try {
    return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0))
  } catch {
    return null
  }
}

/** The query string (without `?`) that makes `/api/images/<id>` a signed link. */
export async function signImageLink(secret: string, claims: ImageLinkClaims): Promise<string> {
  const key = await hmacKey(secret, "sign")
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, payloadOf(claims)))
  const params = new URLSearchParams({
    exp: String(claims.expiresAt),
    tok: claims.tokenId,
    sig: base64url(signature),
  })
  return params.toString()
}

/** Whether `sig` is the signature of `claims` under `secret`. The comparison
 * is `crypto.subtle.verify`'s — constant-time, not a string equality. */
export async function verifyImageLink(
  secret: string,
  claims: ImageLinkClaims,
  sig: string,
): Promise<boolean> {
  const signature = fromBase64url(sig)
  if (!signature) return false
  const key = await hmacKey(secret, "verify")
  return crypto.subtle.verify("HMAC", key, signature, payloadOf(claims))
}

/** The link parameters a request carries, or null when it is a plain
 * (session) read. All three must be present and well-formed to count. */
export function imageLinkParams(
  url: URL,
): { expiresAt: number; tokenId: string; sig: string } | null {
  const exp = url.searchParams.get("exp")
  const tok = url.searchParams.get("tok")
  const sig = url.searchParams.get("sig")
  if (exp === null && tok === null && sig === null) return null
  if (exp === null || tok === null || sig === null) return { expiresAt: 0, tokenId: "", sig: "" }
  const expiresAt = /^\d{1,12}$/.test(exp) ? Number(exp) : 0
  return { expiresAt, tokenId: tok, sig }
}
