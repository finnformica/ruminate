// tenant-guard: exempt — no SQL here; this route writes meta tags into HTML.
import { describe, expect, it } from "vitest"
import { isSocialPath, socialMeta, SOCIAL_PATHS } from "./social"

/** The `content` of one tag, by its `property` or `name`. */
function tag(html: string, key: string): string | null {
  const match = new RegExp(`(?:property|name)="${key}" content="([^"]*)"`).exec(html)
  return match ? match[1] : null
}

describe("which paths carry a card", () => {
  it("is the app itself and an invite link", () => {
    expect(isSocialPath("/")).toBe(true)
    expect(isSocialPath("/invite")).toBe(true)
    expect(isSocialPath("/invite/rmn_inv_abc")).toBe(true)
  })

  it("is nothing else — a note's address unfurls as no card at all", () => {
    expect(isSocialPath("/notes/2026-09-17")).toBe(false)
    expect(isSocialPath("/settings")).toBe(false)
    expect(isSocialPath("/changelog")).toBe(false)
    // A path that merely starts with the word is not an invite link.
    expect(isSocialPath("/invitations")).toBe(false)
  })

  it("lists those same paths for wrangler to route", () => {
    expect([...SOCIAL_PATHS]).toEqual(["/", "/invite/*"])
    for (const pattern of SOCIAL_PATHS) expect(isSocialPath(pattern.replace("*", "abc"))).toBe(true)
  })
})

describe("the tags", () => {
  const origin = "https://ruminate.example"

  it("names the app for the app's own link", () => {
    const html = socialMeta(origin, "/")
    expect(tag(html, "og:title")).toBe("Ruminate")
    expect(tag(html, "og:image")).toBe("https://ruminate.example/og-card.png")
    expect(tag(html, "og:url")).toBe("https://ruminate.example/")
  })

  it("says it is an invitation for an invite link, with its own picture", () => {
    const html = socialMeta(origin, "/invite/rmn_inv_abc")
    expect(tag(html, "og:title")).toBe("You’re invited to Ruminate")
    expect(tag(html, "og:image")).toBe("https://ruminate.example/og-invite.png")
  })

  it("never puts the token in the card", () => {
    // The address is the secret. It is `og:url` because that is what the
    // reader is about to open anyway — but nothing else repeats it, and no
    // title or description is built from it.
    const html = socialMeta(origin, "/invite/rmn_inv_secret")
    const mentions = html.split("rmn_inv_secret").length - 1
    expect(mentions).toBe(1)
    expect(tag(html, "og:url")).toBe("https://ruminate.example/invite/rmn_inv_secret")
  })

  it("makes the picture absolute on whatever origin served the page", () => {
    // The same Worker answers the production domain, the workers.dev address
    // and every preview URL; a card pointing at another origin is a card
    // that does not load.
    for (const host of ["https://ruminate.example", "https://ruminate.workers.dev"]) {
      expect(tag(socialMeta(host, "/"), "og:image")).toBe(`${host}/og-card.png`)
      expect(tag(socialMeta(host, "/"), "twitter:image")).toBe(`${host}/og-card.png`)
    }
  })

  it("asks for the picture to be shown large, at the size it was drawn", () => {
    const html = socialMeta(origin, "/")
    expect(tag(html, "twitter:card")).toBe("summary_large_image")
    expect(tag(html, "og:image:width")).toBe("1200")
    expect(tag(html, "og:image:height")).toBe("630")
  })

  it("escapes what it writes, so a card is always well-formed markup", () => {
    const html = socialMeta(origin, "/")
    expect(html).not.toMatch(/content="[^"]*"[^ >]/)
    expect(html).toContain('<meta name="description"')
  })
})
