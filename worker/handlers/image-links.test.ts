import { describe, expect, it } from "vitest"
import {
  imageLinkParams,
  signImageLink,
  verifyImageLink,
  type ImageLinkClaims,
} from "./image-links"

const SECRET = "a-secret"
const claims: ImageLinkClaims = {
  userId: 1001,
  imageId: "img_abcdefghijkl",
  tokenId: "mcp_token",
  expiresAt: 1_800_000_900,
}

describe("signed image links", () => {
  it("signs a link the verifier accepts, and only under the same secret", async () => {
    const query = await signImageLink(SECRET, claims)
    const params = imageLinkParams(
      new URL(`https://ruminate.test/api/images/${claims.imageId}?${query}`),
    )
    expect(params).toEqual({
      expiresAt: claims.expiresAt,
      tokenId: claims.tokenId,
      sig: expect.any(String),
    })
    expect(await verifyImageLink(SECRET, claims, params!.sig)).toBe(true)
    expect(await verifyImageLink("another-secret", claims, params!.sig)).toBe(false)
  })

  it("binds every claim: a changed tenant, asset, token or expiry fails", async () => {
    const sig = imageLinkParams(
      new URL(`https://x/api/images/i?${await signImageLink(SECRET, claims)}`),
    )!.sig
    expect(await verifyImageLink(SECRET, { ...claims, userId: 1002 }, sig)).toBe(false)
    expect(await verifyImageLink(SECRET, { ...claims, imageId: "img_zzzzzzzzzzzz" }, sig)).toBe(
      false,
    )
    expect(await verifyImageLink(SECRET, { ...claims, tokenId: "mcp_other" }, sig)).toBe(false)
    expect(await verifyImageLink(SECRET, { ...claims, expiresAt: claims.expiresAt + 1 }, sig)).toBe(
      false,
    )
  })

  it("refuses a signature that is not base64url, or is truncated", async () => {
    const sig = imageLinkParams(
      new URL(`https://x/api/images/i?${await signImageLink(SECRET, claims)}`),
    )!.sig
    expect(await verifyImageLink(SECRET, claims, "not base64!")).toBe(false)
    expect(await verifyImageLink(SECRET, claims, sig.slice(0, -4))).toBe(false)
    expect(await verifyImageLink(SECRET, claims, "")).toBe(false)
  })

  it("tells a plain read from a link, and a half-formed link from either", () => {
    expect(imageLinkParams(new URL("https://x/api/images/img_a"))).toBeNull()
    // Any of the three present makes it a link attempt — never a fall-through
    // to the session path with parameters left dangling.
    expect(imageLinkParams(new URL("https://x/api/images/img_a?sig=abc"))).toEqual({
      expiresAt: 0,
      tokenId: "",
      sig: "",
    })
    expect(imageLinkParams(new URL("https://x/api/images/img_a?exp=soon&tok=t&sig=s"))).toEqual({
      expiresAt: 0,
      tokenId: "t",
      sig: "s",
    })
  })
})
