// Image assets — the bytes behind `image` blocks (docs/images.md).
//
// A picture pasted into a note is uploaded here and stored in R2; the block
// keeps only the asset id in its props (`{ image: "img_…" }`), and the note's
// markdown spells it `![caption](/api/images/img_…)`. The graph stays small
// rows; the bytes live where bytes belong.
//
// Routes (wired in worker/index.ts under /api/images/*):
//   POST /api/images              — the request body is the image; returns { id }
//   GET  /api/images/<id>         — the bytes, immutable-cacheable
//   PUT  /api/images/<id>/thumb   — a small copy of a picture already stored,
//                                   the body again the image (docs/images.md,
//                                   Thumbnails); the client writes it after
//                                   the upload, or on first view of an older
//                                   picture that has none
//   GET  /api/images/<id>/thumb   — that copy, or 404 while there is none
//
// SWITCHED OFF BY DEFAULT. Both halves must be present for the routes to do
// anything: the `IMAGES` R2 binding (wrangler.jsonc) and the
// `VITE_IMAGES_ENABLED=true` variable (the same one the client build reads).
// Without them every route answers 501 `images_disabled` and the client never
// offers to upload — the whole feature is a no-op.
//
// AUTH & TENANCY: `requireSession` (replica.ts) verifies identity exactly as
// the replica routes do. The R2 key is `<verified github id>/<asset id>`:
// minted from the session and a validated id, never from anything the
// request could steer, so one tenant can neither read nor overwrite
// another's picture — a foreign id simply is not found.
//
// A read may instead carry a SIGNED LINK (`image-links.ts`): the fifteen-
// minute download the MCP `get_image` tool mints for an agent, which has no
// session. Its tenant comes from the MCP token row the link names, checked
// live — so the key is minted from a verified identity on this path too, and
// a revoked token's links stop working with it.

import { controlPlaneDriver } from "../tenancy-db"
import { grantById, tenantIsActive } from "../mcp/tokens"
import type { Env } from "../types"
import { imageLinkParams, verifyImageLink } from "./image-links"
import {
  isImageId,
  isImageMime,
  MAX_IMAGE_BYTES,
  MAX_THUMB_BYTES,
  newImageId,
} from "./image-policy"
import { requireSession } from "./replica"

/** Where a picture's small copy is kept: beside its bytes, under its key. */
const thumbKey = (prefix: string, id: string) => `${prefix}${id}/thumb`

function imagesEnabled(env: Env): boolean {
  return env.VITE_IMAGES_ENABLED === "true" && env.IMAGES !== undefined
}

export async function images(
  request: Request,
  env: Env,
  fetchImpl: typeof fetch = fetch,
  /** The clock a signed link's expiry is read against (tests fix it). */
  clock: () => number = Date.now,
): Promise<Response> {
  const url = new URL(request.url)
  const { pathname } = url
  const method = request.method
  const upload = pathname === "/api/images" && method === "POST"
  const idMatch = /^\/api\/images\/([^/]+)$/.exec(pathname)
  const read = idMatch !== null && method === "GET"
  const thumbMatch = /^\/api\/images\/([^/]+)\/thumb$/.exec(pathname)
  const thumbWrite = thumbMatch !== null && method === "PUT"
  const thumbRead = thumbMatch !== null && method === "GET"
  if (!upload && !read && !thumbWrite && !thumbRead) {
    return jsonResponse({ error: "not_found" }, 404)
  }

  const link = read ? imageLinkParams(url) : null
  if (link !== null) return signedRead(env, idMatch![1], link, clock())

  const session = await requireSession(request, env, fetchImpl)
  if (session instanceof Response) return session

  if (!imagesEnabled(env) || !env.IMAGES) return jsonResponse({ error: "images_disabled" }, 501)
  const bucket = env.IMAGES
  const prefix = `${session.id}/`

  if (upload) {
    const body = await imageBody(request, MAX_IMAGE_BYTES)
    if (body instanceof Response) return body
    const id = newImageId(() => crypto.randomUUID())
    await bucket.put(prefix + id, body.bytes, {
      httpMetadata: { contentType: body.contentType },
      customMetadata: { uploadedAt: String(Date.now()) },
    })
    return jsonResponse({ id, size: body.bytes.byteLength, type: body.contentType }, 201)
  }

  if (thumbWrite) {
    // A copy is only ever of a picture the tenant has: the key is checked
    // before the body is read, so nothing is stored under a name with
    // nothing behind it.
    const id = thumbMatch![1]
    if (!isImageId(id)) return jsonResponse({ error: "not_found" }, 404)
    if ((await bucket.head(prefix + id)) === null) return jsonResponse({ error: "not_found" }, 404)
    const body = await imageBody(request, MAX_THUMB_BYTES)
    if (body instanceof Response) return body
    await bucket.put(thumbKey(prefix, id), body.bytes, {
      httpMetadata: { contentType: body.contentType },
      customMetadata: { uploadedAt: String(Date.now()) },
    })
    return jsonResponse({ id, size: body.bytes.byteLength, type: body.contentType }, 201)
  }

  if (thumbRead) {
    const id = thumbMatch![1]
    if (!isImageId(id)) return jsonResponse({ error: "not_found" }, 404)
    return serveKey(bucket, thumbKey(prefix, id))
  }

  return serveObject(bucket, prefix, idMatch![1])
}

/** The picture in a request's body, checked as an upload is: an image
 * type, not empty, no larger than `maxBytes`. Else the refusal. */
async function imageBody(
  request: Request,
  maxBytes: number,
): Promise<{ bytes: ArrayBuffer; contentType: string } | Response> {
  const contentType = (request.headers.get("Content-Type") ?? "").split(";")[0].trim()
  if (!isImageMime(contentType)) return jsonResponse({ error: "unsupported_type" }, 415)
  const declared = Number(request.headers.get("Content-Length") ?? "0")
  if (declared > maxBytes) return jsonResponse({ error: "payload_too_large" }, 413)
  const bytes = await request.arrayBuffer()
  if (bytes.byteLength === 0) return jsonResponse({ error: "empty" }, 400)
  if (bytes.byteLength > maxBytes) return jsonResponse({ error: "payload_too_large" }, 413)
  return { bytes, contentType }
}

/**
 * A read through a signed link. Everything the session path establishes is
 * established here another way, in the same order it would fail cheapest:
 * the link is well-formed and unexpired; the token it names is live (not
 * revoked, not expired — `grantById` is `findGrant`'s decision by id); the
 * tenant is still in good standing; the signature is the Worker's own over
 * those exact claims. Only then is a key minted — from the token row's user,
 * never from the URL.
 */
async function signedRead(
  env: Env,
  id: string,
  link: { expiresAt: number; tokenId: string; sig: string },
  at: number,
): Promise<Response> {
  const refused = (error: string, status = 401) => jsonResponse({ error }, status)
  const secret = env.IMAGE_LINK_SECRET
  if (!secret) return refused("links_not_supported", 404)
  if (!isImageId(id) || link.tokenId === "" || link.sig === "") return refused("invalid_link")
  if (link.expiresAt * 1000 <= at) return refused("expired_link")

  const grant = await grantById(controlPlaneDriver(env), link.tokenId, at)
  if (!grant.ok) return refused("invalid_link")
  if (!(await tenantIsActive(controlPlaneDriver(env), grant.grant.userId))) {
    return refused("forbidden", 403)
  }
  const claims = {
    userId: grant.grant.userId,
    imageId: id,
    tokenId: grant.grant.tokenId,
    expiresAt: link.expiresAt,
  }
  if (!(await verifyImageLink(secret, claims, link.sig))) return refused("invalid_link")

  if (!imagesEnabled(env) || !env.IMAGES) return jsonResponse({ error: "images_disabled" }, 501)
  return serveObject(env.IMAGES, `${grant.grant.userId}/`, id)
}

/** The bytes under `prefix + id`, or 404. The prefix is the tenant's, minted
 * by the caller from a verified identity; the id is validated here. */
async function serveObject(bucket: R2Bucket, prefix: string, id: string): Promise<Response> {
  if (!isImageId(id)) return jsonResponse({ error: "not_found" }, 404)
  return serveKey(bucket, prefix + id)
}

/** The bytes under `key`, or 404. The key is the caller's to have minted
 * from a verified tenant and a validated id. */
async function serveKey(bucket: R2Bucket, key: string): Promise<Response> {
  const object = await bucket.get(key)
  if (!object) return jsonResponse({ error: "not_found" }, 404)
  return new Response(object.body, {
    status: 200,
    headers: {
      "Content-Type": object.httpMetadata?.contentType ?? "application/octet-stream",
      "Content-Length": String(object.size),
      // An asset never changes under its id, so the browser may keep it for
      // good — privately, since it took a session (or a signed link) to fetch.
      "Cache-Control": "private, max-age=31536000, immutable",
      ETag: object.httpEtag,
      "Content-Disposition": "inline",
      "X-Content-Type-Options": "nosniff",
    },
  })
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}
