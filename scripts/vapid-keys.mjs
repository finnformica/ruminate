#!/usr/bin/env node
// Print a new VAPID key pair for habit reminders (docs/reminders.md).
//
//   node scripts/vapid-keys.mjs
//
// The private key is a P-256 JWK: set it as the Worker secret, never in a
// file in this repo.
//   npx wrangler secret put VAPID_PRIVATE_KEY   (paste the JWK line)
// The public key (base64url) may go in wrangler.jsonc as VAPID_PUBLIC_KEY;
// left empty, the Worker derives it from the secret.
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
const publicKey = Buffer.from(raw).toString("base64url")
const privateJwk = JSON.stringify({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, d: jwk.d })

console.log(`VAPID_PUBLIC_KEY=${publicKey}`)
console.log(`VAPID_PRIVATE_KEY=${privateJwk}`)
