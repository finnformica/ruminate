import { describe, expect, it } from "vitest"
import { resolveAiProvider } from "./ai-router"

describe("resolveAiProvider", () => {
  it("is Anthropic first, whenever a key is kept", () => {
    expect(
      resolveAiProvider({ hasKey: true, cloudflareAllowed: false, cloudflareOptIn: false }),
    ).toBe("anthropic")
    // Even with Cloudflare allowed and ticked.
    expect(
      resolveAiProvider({ hasKey: true, cloudflareAllowed: true, cloudflareOptIn: true }),
    ).toBe("anthropic")
  })

  it("falls through to Cloudflare when the flag allows and the box is ticked", () => {
    expect(
      resolveAiProvider({ hasKey: false, cloudflareAllowed: true, cloudflareOptIn: true }),
    ).toBe("cloudflare")
  })

  it("is none when the box is ticked but the flag does not allow", () => {
    expect(
      resolveAiProvider({ hasKey: false, cloudflareAllowed: false, cloudflareOptIn: true }),
    ).toBeNull()
  })

  it("is none when the flag allows but the box is not ticked", () => {
    expect(
      resolveAiProvider({ hasKey: false, cloudflareAllowed: true, cloudflareOptIn: false }),
    ).toBeNull()
  })

  it("is none with nothing set", () => {
    expect(
      resolveAiProvider({ hasKey: false, cloudflareAllowed: false, cloudflareOptIn: false }),
    ).toBeNull()
  })
})
