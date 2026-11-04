#!/usr/bin/env node
// Optional: rotate the VAPID key pair of habit reminders (docs/reminders.md).
// Not a setup step: the pair is already set. Use it only to replace the pair.
//
//   node scripts/vapid-keys.mjs
//
// It prints both keys, base64url, in the format of web-push's
// `generateVAPIDKeys`: the public key is the uncompressed P-256 point
// (65 bytes), the private key the raw scalar `d` (32 bytes).
//   1. Put the public key in wrangler.jsonc as VAPID_PUBLIC_KEY (`vars` and
//      `previews.vars`).
//   2. Set the private key with `npx wrangler secret put VAPID_PRIVATE_KEY`.
//      Never put it in a file in this repo.
//
// A new pair ends every existing subscription: each browser subscribed with
// the old public key, so each must turn reminders on again.

const { webcrypto } = await import("node:crypto")

const pair = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
  "sign",
  "verify",
])
const jwk = await webcrypto.subtle.exportKey("jwk", pair.privateKey)
const raw = new Uint8Array(await webcrypto.subtle.exportKey("raw", pair.publicKey))

console.log(`VAPID_PUBLIC_KEY=${Buffer.from(raw).toString("base64url")}`)
console.log(`VAPID_PRIVATE_KEY=${jwk.d}`)
