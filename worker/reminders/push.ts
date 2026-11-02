// Web Push from the Worker (docs/reminders.md): VAPID (RFC 8292) and the
// aes128gcm payload encryption (RFC 8291), through
// `@block65/webcrypto-web-push`, which uses Web Crypto and so runs on
// Workers (Node's `web-push` does not). aes128gcm, not the older `aesgcm`
// draft: Apple's push service takes only the RFC.
//
// The keys: `VAPID_PRIVATE_KEY` is a Worker secret, the private key as a
// JWK (`node scripts/vapid-keys.mjs` prints a new pair). `VAPID_PUBLIC_KEY`
// is a wrangler var, the public key the browser subscribes with. The public
// key is also in the JWK (`x`, `y`), so with the var empty the Worker
// derives it, and with the var set the Worker refuses a var that does not
// match the secret: a subscription made with the wrong key cannot be sent to.

import { buildPushPayload } from "@block65/webcrypto-web-push"
import type { Env } from "../types"
import type { ReminderPayload } from "./message"

/** Who sends: the VAPID `sub` claim, a contact URL for the push services. */
const VAPID_SUBJECT = "https://github.com/finnformica/ruminate"

/** How long a push service holds a reminder for a device that is offline. */
const TTL_SECONDS = 4 * 60 * 60

/** A subscription as the browser hands it over (`PushSubscription.toJSON()`). */
export interface PushTarget {
  endpoint: string
  p256dh: string
  auth: string
}

const base64UrlToBytes = (value: string): Uint8Array => {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/")
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4)
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0))
}

const bytesToBase64Url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")

/** The private key, parsed; null when the secret is missing or malformed. */
function privateJwk(env: Env): JsonWebKey | null {
  if (!env.VAPID_PRIVATE_KEY) return null
  try {
    const jwk = JSON.parse(env.VAPID_PRIVATE_KEY) as JsonWebKey
    return jwk.kty === "EC" && jwk.crv === "P-256" && jwk.d && jwk.x && jwk.y ? jwk : null
  } catch {
    return null
  }
}

/** The uncompressed P-256 point of a JWK, base64url: the key a browser's
 * `PushManager.subscribe` takes as `applicationServerKey`. */
export function publicKeyOfJwk(jwk: JsonWebKey): string {
  const x = base64UrlToBytes(jwk.x ?? "")
  const y = base64UrlToBytes(jwk.y ?? "")
  const point = new Uint8Array(1 + x.length + y.length)
  point[0] = 4
  point.set(x, 1)
  point.set(y, 1 + x.length)
  return bytesToBase64Url(point)
}

/** The keys the Worker sends with, or null when push is not set up here:
 * no secret, a malformed one, or a public key var that does not match it. */
export function vapidKeys(env: Env): VapidKeys | null {
  const jwk = privateJwk(env)
  if (jwk === null) return null
  const derived = publicKeyOfJwk(jwk)
  if (env.VAPID_PUBLIC_KEY && env.VAPID_PUBLIC_KEY !== derived) {
    console.error(
      JSON.stringify({ event: "vapid_key_mismatch", note: "VAPID_PUBLIC_KEY is not the secret's" }),
    )
    return null
  }
  return { publicKey: derived, privateKey: jwk.d as string }
}

/** The VAPID key pair, base64url: the raw public point and the private
 * scalar (the JWK's `d`). */
export interface VapidKeys {
  publicKey: string
  privateKey: string
}

/** What the push service said: taken, gone (the subscription is dead and is
 * to be deleted: 404 or 410), or any other failure. */
export type PushOutcome = "sent" | "gone" | "failed"

/** Send one reminder to one subscription. */
export async function sendPush(
  keys: VapidKeys,
  target: PushTarget,
  payload: ReminderPayload,
  fetchImpl: typeof fetch = fetch,
): Promise<{ outcome: PushOutcome; status: number }> {
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
    const { status } = response
    if (status === 404 || status === 410) return { outcome: "gone", status }
    return { outcome: response.ok ? "sent" : "failed", status }
  } catch {
    return { outcome: "failed", status: 0 }
  }
}
