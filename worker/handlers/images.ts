// Image assets — the bytes behind `image` blocks (docs/images.md).
//
// A picture pasted into a note is uploaded here and stored in R2; the block
// keeps only the asset id in its props (`{ image: "img_…" }`), and the note's
// markdown spells it `![caption](/api/images/img_…)`. The graph stays small
// rows; the bytes live where bytes belong.
//
// Routes (wired in worker/index.ts under /api/images/*):
//   POST /api/images        — the request body is the image; returns { id }
//   GET  /api/images/<id>   — the bytes, immutable-cacheable
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

import type { Env } from "../types"
import { isImageId, isImageMime, MAX_IMAGE_BYTES, newImageId } from "./image-policy"
import { requireSession } from "./replica"

function imagesEnabled(env: Env): boolean {
  return env.VITE_IMAGES_ENABLED === "true" && env.IMAGES !== undefined
}

export async function images(
  request: Request,
  env: Env,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const { pathname } = new URL(request.url)
  const method = request.method
  const upload = pathname === "/api/images" && method === "POST"
  const idMatch = /^\/api\/images\/([^/]+)$/.exec(pathname)
  const read = idMatch !== null && method === "GET"
  if (!upload && !read) return jsonResponse({ error: "not_found" }, 404)

  const session = await requireSession(request, env, fetchImpl)
  if (session instanceof Response) return session

  if (!imagesEnabled(env) || !env.IMAGES) return jsonResponse({ error: "images_disabled" }, 501)
  const bucket = env.IMAGES
  const prefix = `${session.id}/`

  if (upload) {
    const contentType = (request.headers.get("Content-Type") ?? "").split(";")[0].trim()
    if (!isImageMime(contentType)) return jsonResponse({ error: "unsupported_type" }, 415)
    const declared = Number(request.headers.get("Content-Length") ?? "0")
    if (declared > MAX_IMAGE_BYTES) return jsonResponse({ error: "payload_too_large" }, 413)
    const bytes = await request.arrayBuffer()
    if (bytes.byteLength === 0) return jsonResponse({ error: "empty" }, 400)
    if (bytes.byteLength > MAX_IMAGE_BYTES) {
      return jsonResponse({ error: "payload_too_large" }, 413)
    }
    const id = newImageId(() => crypto.randomUUID())
    await bucket.put(prefix + id, bytes, {
      httpMetadata: { contentType },
      customMetadata: { uploadedAt: String(Date.now()) },
    })
    return jsonResponse({ id, size: bytes.byteLength, type: contentType }, 201)
  }

  const id = idMatch![1]
  if (!isImageId(id)) return jsonResponse({ error: "not_found" }, 404)
  const object = await bucket.get(prefix + id)
  if (!object) return jsonResponse({ error: "not_found" }, 404)
  return new Response(object.body, {
    status: 200,
    headers: {
      "Content-Type": object.httpMetadata?.contentType ?? "application/octet-stream",
      "Content-Length": String(object.size),
      // An asset never changes under its id, so the browser may keep it for
      // good — privately, since it took a session to fetch.
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
