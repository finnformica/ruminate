// Web Push from the Worker (docs/reminders.md): VAPID (RFC 8292) and the
// aes128gcm payload encryption (RFC 8291), through
// `@block65/webcrypto-web-push`, which uses Web Crypto and so runs on
// Workers (Node's `web-push` does not). aes128gcm, not the older `aesgcm`
// draft: Apple's push service takes only the RFC.
//
// The keys, base64url, in the format of web-push's `generateVAPIDKeys`:
// `VAPID_PRIVATE_KEY` is a Worker secret, the raw P-256 private scalar `d`
// (32 bytes). `VAPID_PUBLIC_KEY` is a wrangler var, the uncompressed public
// point (65 bytes): the key the browser subscribes with. The Worker refuses
// a pair that does not match (`vapid_key_mismatch`): a push signed with the
// wrong key is refused by every push service.

import { buildPushPayload } from "@block65/webcrypto-web-push"
import type { Env } from "../types"
import type { ReminderPayload } from "./message"

/** Who sends: the VAPID `sub` claim, a contact URL for the push services.
 * The app's own production address (`workers_dev`, wrangler.jsonc). */
const VAPID_SUBJECT = "https://ruminate.finnformica.workers.dev"

/** How long a push service holds a reminder for a device that is offline. */
const TTL_SECONDS = 4 * 60 * 60

/** A subscription as the browser hands it over (`PushSubscription.toJSON()`). */
export interface PushTarget {
  endpoint: string
  p256dh: string
  auth: string
}

const BASE64URL_RE = /^[A-Za-z0-9_-]+$/

/** The bytes of a base64url string; null when it is not one. */
const base64UrlToBytes = (value: string): Uint8Array | null => {
  if (!BASE64URL_RE.test(value)) return null
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/")
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4)
  try {
    return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0))
  } catch {
    return null
  }
}

const bytesToBase64Url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")

/** The VAPID key pair, base64url: the raw public point and the private
 * scalar `d`. */
export interface VapidKeys {
  publicKey: string
  privateKey: string
}

/** Whether `d` is the private key of `point`: sign with the pair, verify
 * with the public half. */
async function isPair(point: Uint8Array, d: string): Promise<boolean> {
  const x = bytesToBase64Url(point.slice(1, 33))
  const y = bytesToBase64Url(point.slice(33, 65))
  try {
    const algorithm = { name: "ECDSA", namedCurve: "P-256" }
    const signer = await crypto.subtle.importKey(
      "jwk",
      { kty: "EC", crv: "P-256", x, y, d },
      algorithm,
      false,
      ["sign"],
    )
    const verifier = await crypto.subtle.importKey(
      "jwk",
      { kty: "EC", crv: "P-256", x, y },
      algorithm,
      false,
      ["verify"],
    )
    const data = new TextEncoder().encode("vapid pair check")
    const sign = { name: "ECDSA", hash: "SHA-256" }
    const signature = await crypto.subtle.sign(sign, signer, data)
    return await crypto.subtle.verify(sign, verifier, signature, data)
  } catch {
    return false
  }
}

/** The answer for the keys last checked: one check per isolate. */
let checked: { publicKey: string; privateKey: string; ok: boolean } | null = null

/** The keys the Worker sends with, or null when push is not set up here:
 * either key missing or malformed, or a pair that does not match. */
export async function vapidKeys(env: Env): Promise<VapidKeys | null> {
  const publicKey = env.VAPID_PUBLIC_KEY ?? ""
  const privateKey = env.VAPID_PRIVATE_KEY ?? ""
  const point = base64UrlToBytes(publicKey)
  const d = base64UrlToBytes(privateKey)
  if (point?.length !== 65 || point[0] !== 4 || d?.length !== 32) return null
  if (checked?.publicKey !== publicKey || checked.privateKey !== privateKey) {
    checked = { publicKey, privateKey, ok: await isPair(point, privateKey) }
    if (!checked.ok) {
      console.error(
        JSON.stringify({
          event: "vapid_key_mismatch",
          note: "VAPID_PRIVATE_KEY is not the pair of VAPID_PUBLIC_KEY",
        }),
      )
    }
  }
  return checked.ok ? { publicKey, privateKey } : null
}

/** What the push service said: taken (2xx), gone (404 or 410: the
 * subscription is dead and is to be deleted), the VAPID key refused (401 or
 * 403: the key the browser subscribed with is not the one that signed), or
 * any other failure. */
type PushOutcome = "sent" | "gone" | "vapid" | "failed"

/** One send's result: the outcome, the push service's status (0 when no
 * answer came) and a short reason for a person. */
export interface PushResult {
  outcome: PushOutcome
  status: number
  reason: string
}

/** The result of a push service's answer (RFC 8030 §5, RFC 8292 §4). */
export function pushResultOf(status: number): PushResult {
  if (status >= 200 && status < 300) return { outcome: "sent", status, reason: "sent" }
  if (status === 404 || status === 410) {
    return { outcome: "gone", status, reason: "subscription gone" }
  }
  if (status === 401 || status === 403) {
    return { outcome: "vapid", status, reason: "VAPID key refused" }
  }
  const reason =
    status === 0
      ? "no answer"
      : status === 400
        ? "request refused"
        : status === 413
          ? "payload too large"
          : status === 429
            ? "too many requests"
            : "push service error"
  return { outcome: "failed", status, reason }
}

/** The push service's host, for a log line: never the whole endpoint, whose
 * path is the device's address. */
export const endpointHost = (endpoint: string): string => {
  try {
    return new URL(endpoint).host
  } catch {
    return "invalid"
  }
}

/** Send one reminder to one subscription. A failure is logged with the
 * push service's host, status and the start of its answer. */
export async function sendPush(
  keys: VapidKeys,
  target: PushTarget,
  payload: ReminderPayload,
  fetchImpl: typeof fetch = fetch,
): Promise<PushResult> {
  let result: PushResult
  let detail = ""
  try {
    const request = await buildPushPayload(
      {
        data: { ...payload },
        // The topic replaces a reminder the device has not yet received.
        options: { ttl: TTL_SECONDS, urgency: "normal", topic: payload.tag },
      },
      {
        endpoint: target.endpoint,
        expirationTime: null,
        keys: { p256dh: target.p256dh, auth: target.auth },
      },
      { subject: VAPID_SUBJECT, publicKey: keys.publicKey, privateKey: keys.privateKey },
    )
    const response = await fetchImpl(target.endpoint, {
      method: "POST",
      headers: request.headers,
      body: request.body,
    })
    result = pushResultOf(response.status)
    if (result.outcome !== "sent") detail = (await response.text().catch(() => "")).slice(0, 200)
  } catch (error) {
    result = pushResultOf(0)
    detail = error instanceof Error ? error.message : String(error)
  }
  if (result.outcome !== "sent") {
    console.error(
      JSON.stringify({
        event: "push_failed",
        host: endpointHost(target.endpoint),
        ...result,
        detail,
      }),
    )
  }
  return result
}
