import { describe, expect, it } from "vitest"
import { SuggestError, suggestDetail } from "./suggest-tags"

describe("suggestDetail", () => {
  it("lines up what a failing call can be found by, and what the provider said", () => {
    const detail = suggestDetail({
      message: "The model’s answer made no sense — try again.",
      code: "bad_answer",
      status: 422,
      body: {
        error: "bad_answer",
        provider: "cloudflare",
        model: "@cf/some/model",
        log: "01HXYZ",
        detail: { provider: "cloudflare", answer: "I cannot see the picture." },
      },
      cfRay: "8a1b2c3d-LHR",
    })
    expect(detail).toBe(
      [
        "The model’s answer made no sense — try again.",
        "code: bad_answer",
        "status: 422",
        "provider: cloudflare",
        "model: @cf/some/model",
        "log: 01HXYZ",
        "cf-ray: 8a1b2c3d-LHR",
        "detail: " +
          JSON.stringify({ provider: "cloudflare", answer: "I cannot see the picture." }, null, 2),
      ].join("\n"),
    )
  })

  it("carries the provider's own status and message", () => {
    const detail = suggestDetail({
      message: "The model couldn’t answer — try again in a moment.",
      code: "provider_error",
      status: 502,
      body: { provider: "anthropic", model: "m", status: 529, message: "Overloaded" },
      cfRay: null,
    })
    expect(detail).toContain("provider status: 529")
    expect(detail).toContain("message: Overloaded")
    expect(detail).not.toContain("cf-ray")
  })

  it("falls back to the raw body when it was not JSON", () => {
    const detail = suggestDetail({
      message: "Couldn’t suggest tags (503).",
      code: "failed",
      status: 503,
      body: null,
      rawBody: "<html>Service unavailable</html>",
    })
    expect(detail).toContain("body: <html>Service unavailable</html>")
  })

  it("is what the error carries, the message alone by default", () => {
    expect(new SuggestError("x", "Nope").detail).toBe("Nope")
    expect(new SuggestError("x", "Nope", "Nope\ncode: x").detail).toBe("Nope\ncode: x")
  })
})
