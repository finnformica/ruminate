import { beforeEach, describe, expect, it } from "vitest"
import { AUTO_TAG_MODEL, CLOUDFLARE_AI_MODEL, type TagFeature } from "../../src/data/auto-tag"
import { spendAiCall } from "../ai-usage"
import { setFeatureAudience } from "../features"
import { createMcpTestEnv, type McpTestEnv } from "../mcp/test-support"
import { anthropicKey } from "./anthropic-key"
import { boardTag } from "./board-tag"
import { preferences } from "./preferences"

/**
 * The tagging route, with both providers stubbed: there is no key to call
 * the Anthropic API with from a test, and Workers AI cannot be reached from
 * here at all. The point is what the route does around the call — who may
 * call, which provider the router picks from the Worker's own truth, what
 * is refused before a call is spent, what goes out, and how the one shared
 * step reads the answer back.
 */

const ADMIN = 42536816
const USER = 7
const KEY = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCD"
const IMAGE = "img_abcdefghijkl"
const ANTHROPIC = "https://api.anthropic.com/v1/messages"

const FEATURES: TagFeature[] = [
  { label: "Location", multi: false, values: ["Mauritius", "Lisbon"] },
  { label: "Fixture", multi: true, values: [] },
]

const GOOD = {
  caption: "A rattan lamp",
  features: [
    { label: "Location", values: ["Mauritius"] },
    { label: "Fixture", values: ["Lamp", "lamp"] },
  ],
}

/** What the route answers with for GOOD, read through the shared step. */
const READ = {
  caption: "A rattan lamp",
  features: [
    { label: "Location", values: ["Mauritius"] },
    { label: "Fixture", values: ["Lamp"] },
  ],
}

let harness: McpTestEnv

/** What the stub answers the Anthropic call with, and what it saw. */
let anthropic: { reply: () => Response; calls: { headers: Headers; body: any }[] }

/** A Messages API answer whose one text block is this JSON. */
function messageWith(output: unknown, stopReason = "end_turn"): Response {
  return new Response(
    JSON.stringify({
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: AUTO_TAG_MODEL,
      content: [{ type: "text", text: JSON.stringify(output) }],
      stop_reason: stopReason,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 10 },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  )
}

const fetchStub = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input)
  if (url === "https://api.github.com/user") {
    const auth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? ""
    const token = /^Bearer (.+)$/.exec(auth)?.[1] ?? ""
    if (token !== "good") return new Response("{}", { status: 401 })
    return new Response(JSON.stringify({ id: USER, login: `u${USER}` }), { status: 200 })
  }
  if (url === ANTHROPIC) {
    anthropic.calls.push({
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)),
    })
    return anthropic.reply()
  }
  throw new Error(`Unexpected outbound fetch: ${url}`)
}) as typeof fetch

/** A Workers AI binding that records what it was asked and answers as told. */
function fakeAi(reply: (model: string, input: any) => unknown) {
  const calls: { model: string; input: any }[] = []
  const binding = {
    async run(model: string, input: any) {
      calls.push({ model, input })
      return reply(model, input)
    },
  }
  return { binding, calls }
}

/** A chat-completion answer whose one message says this. */
const completion = (content: string) => ({
  id: "chatcmpl-1",
  object: "chat.completion",
  created: 1,
  model: CLOUDFLARE_AI_MODEL,
  choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
})

const sessionHeaders = {
  "Content-Type": "application/json",
  Cookie: "gh_refresh=session",
  Authorization: "Bearer good",
}

function tagRequest(body: unknown, session: string | null = "good"): Request {
  return new Request("https://ruminate.test/api/boards/tag", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(session === null
        ? {}
        : { Cookie: "gh_refresh=session", Authorization: `Bearer ${session}` }),
    },
    body: JSON.stringify(body),
  })
}

const send = (request: Request, options: { dailyLimit?: number } = {}) =>
  boardTag(request, harness.env, fetchStub, { clock: () => 5000, ...options })
const bodyOf = async (response: Response) => (await response.json()) as any

async function keepKey() {
  const request = new Request("https://ruminate.test/api/anthropic-key", {
    method: "PUT",
    headers: sessionHeaders,
    body: JSON.stringify({ key: KEY }),
  })
  expect((await anthropicKey(request, harness.env, fetchStub)).status).toBe(200)
}

/** Tick **Use Cloudflare AI** the way the settings card does. */
async function optIntoCloudflare() {
  const request = new Request("https://ruminate.test/api/preferences", {
    method: "PUT",
    headers: sessionHeaders,
    body: JSON.stringify({ preferences: { useCloudflareAi: true } }),
  })
  expect((await preferences(request, harness.env, fetchStub)).status).toBe(200)
}

const allowCloudflare = () => setFeatureAudience(harness.control, "cloudflareAi", "everyone", ADMIN)

const aiCalls = () => harness.control.exec("SELECT calls_today FROM ai_usage")

beforeEach(async () => {
  harness = await createMcpTestEnv()
  await harness.addUser(USER)
  await harness.putImage(
    USER,
    IMAGE,
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]),
    "image/png",
  )
  anthropic = { calls: [], reply: () => messageWith(GOOD) }
})

describe("before the call", () => {
  it("refuses an unauthenticated caller", async () => {
    expect((await send(tagRequest({ imageId: IMAGE, features: [] }, null))).status).toBe(401)
    expect(anthropic.calls).toEqual([])
  })

  it("refuses a body that is not a request", async () => {
    await keepKey()
    for (const body of [
      {},
      { imageId: "../1/img_abcdefghijkl", features: [] },
      { imageId: IMAGE, features: [{ label: "Location" }] },
      { imageId: IMAGE },
      "nonsense",
    ]) {
      expect((await send(tagRequest(body))).status).toBe(400)
    }
    expect(anthropic.calls).toEqual([])
  })

  it("says clearly when nothing is set up, and spends nothing", async () => {
    const response = await send(tagRequest({ imageId: IMAGE, features: FEATURES }))
    expect(response.status).toBe(412)
    expect((await bodyOf(response)).error).toBe("no_provider")
    expect(anthropic.calls).toEqual([])
    expect(await aiCalls()).toEqual([])
  })

  it("answers 404 for a picture that is not the caller's", async () => {
    await keepKey()
    await harness.putImage(8, "img_someoneelses0", new Uint8Array([1]), "image/png")
    const response = await send(tagRequest({ imageId: "img_someoneelses0", features: [] }))
    expect(response.status).toBe(404)
    expect(anthropic.calls).toEqual([])
  })

  it("refuses a format the API does not read, before spending", async () => {
    await keepKey()
    await harness.putImage(USER, "img_avifavifavif", new Uint8Array([1]), "image/avif")
    const response = await send(tagRequest({ imageId: "img_avifavifavif", features: [] }))
    expect(response.status).toBe(415)
    expect(anthropic.calls).toEqual([])
    expect(await aiCalls()).toEqual([])
  })

  it("stops at the daily limit, one count whoever answers", async () => {
    await keepKey()
    expect(
      (await send(tagRequest({ imageId: IMAGE, features: [] }), { dailyLimit: 1 })).status,
    ).toBe(200)
    const response = await send(tagRequest({ imageId: IMAGE, features: [] }), { dailyLimit: 1 })
    expect(response.status).toBe(429)
    expect((await bodyOf(response)).error).toBe("daily_limit")
    expect(response.headers.get("Retry-After")).toBe("3600")
    expect(anthropic.calls).toHaveLength(1)
    expect(await aiCalls()).toEqual([{ calls_today: 1 }])
  })
})

describe("the router, from the Worker's own truth", () => {
  it("picks Anthropic when a key is kept, whatever else is set", async () => {
    await keepKey()
    await allowCloudflare()
    await optIntoCloudflare()
    const ai = fakeAi(() => completion(JSON.stringify(GOOD)))
    Object.assign(harness.env, { AI: ai.binding })
    const response = await send(tagRequest({ imageId: IMAGE, features: FEATURES }))
    expect(response.status).toBe(200)
    expect((await bodyOf(response)).provider).toBe("anthropic")
    expect(anthropic.calls).toHaveLength(1)
    expect(ai.calls).toEqual([])
  })

  it("falls through to Cloudflare when the flag allows and the box is ticked", async () => {
    await allowCloudflare()
    await optIntoCloudflare()
    const ai = fakeAi(() => completion(JSON.stringify(GOOD)))
    Object.assign(harness.env, { AI: ai.binding })
    const response = await send(tagRequest({ imageId: IMAGE, features: FEATURES }))
    expect(response.status).toBe(200)
    expect((await bodyOf(response)).provider).toBe("cloudflare")
    expect(ai.calls).toHaveLength(1)
    expect(anthropic.calls).toEqual([])
  })

  it("never calls Workers AI while the flag is off, however the box is ticked", async () => {
    await optIntoCloudflare()
    const ai = fakeAi(() => completion(JSON.stringify(GOOD)))
    Object.assign(harness.env, { AI: ai.binding })
    const response = await send(tagRequest({ imageId: IMAGE, features: FEATURES }))
    expect(response.status).toBe(412)
    expect((await bodyOf(response)).error).toBe("no_provider")
    expect(ai.calls).toEqual([])
    expect(await aiCalls()).toEqual([])
  })

  it("is nothing when the flag allows but the box is not ticked", async () => {
    await allowCloudflare()
    const ai = fakeAi(() => completion(JSON.stringify(GOOD)))
    Object.assign(harness.env, { AI: ai.binding })
    expect((await send(tagRequest({ imageId: IMAGE, features: FEATURES }))).status).toBe(412)
    expect(ai.calls).toEqual([])
  })

  it("ignores a provider the client names", async () => {
    await keepKey()
    const response = await send(
      tagRequest({ imageId: IMAGE, features: FEATURES, provider: "cloudflare" }),
    )
    expect(response.status).toBe(200)
    expect((await bodyOf(response)).provider).toBe("anthropic")
  })

  it("answers 501 when Cloudflare is chosen but there is no binding", async () => {
    await allowCloudflare()
    await optIntoCloudflare()
    const response = await send(tagRequest({ imageId: IMAGE, features: FEATURES }))
    expect(response.status).toBe(501)
    expect((await bodyOf(response)).error).toBe("ai_disabled")
    expect(await aiCalls()).toEqual([])
  })
})

describe("the Anthropic provider", () => {
  it("sends the picture and the features with the kept key, and the shared step reads the answer", async () => {
    await keepKey()
    const response = await send(tagRequest({ imageId: IMAGE, features: FEATURES }))
    expect(response.status).toBe(200)
    expect(await bodyOf(response)).toEqual({ suggestion: READ, provider: "anthropic" })

    expect(anthropic.calls).toHaveLength(1)
    const { headers, body } = anthropic.calls[0]
    expect(headers.get("x-api-key")).toBe(KEY)
    expect(body.model).toBe(AUTO_TAG_MODEL)
    expect(body.output_config.format.type).toBe("json_schema")
    expect(typeof body.system).toBe("string")
    const [image, text] = body.messages[0].content
    expect(image).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "iVBORwECAw==" },
    })
    expect(text.text).toContain("- Location (one value): Mauritius, Lisbon")
    expect(text.text).toContain("- Fixture (several values): none yet")
  })

  it("tells the caller the key was refused, without the key", async () => {
    await keepKey()
    anthropic.reply = () =>
      new Response(
        JSON.stringify({ type: "error", error: { type: "authentication_error", message: "x" } }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      )
    const response = await send(tagRequest({ imageId: IMAGE, features: FEATURES }))
    expect(response.status).toBe(422)
    const body = await bodyOf(response)
    expect(body.error).toBe("invalid_api_key")
    expect(JSON.stringify(body)).not.toContain(KEY)
  })

  it("passes the API's rate limit on, with its Retry-After", async () => {
    await keepKey()
    anthropic.reply = () =>
      new Response(
        JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "x" } }),
        { status: 429, headers: { "Content-Type": "application/json", "Retry-After": "17" } },
      )
    const response = await send(tagRequest({ imageId: IMAGE, features: FEATURES }))
    expect(response.status).toBe(429)
    expect((await bodyOf(response)).error).toBe("rate_limited")
    expect(response.headers.get("Retry-After")).toBe("17")
    // Once: the client is told to wait, not retried into the same wall.
    expect(anthropic.calls).toHaveLength(1)
  })

  it("answers 502 when the API fails, and 422 when its answer is not a suggestion", async () => {
    await keepKey()
    anthropic.reply = () =>
      new Response(
        JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "x" } }),
        { status: 529, headers: { "Content-Type": "application/json" } },
      )
    let response = await send(tagRequest({ imageId: IMAGE, features: FEATURES }))
    expect(response.status).toBe(502)
    expect(await bodyOf(response)).toEqual({
      error: "provider_error",
      provider: "anthropic",
      status: 529,
    })

    anthropic.reply = () =>
      new Response(
        JSON.stringify({
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: AUTO_TAG_MODEL,
          content: [{ type: "text", text: "not json" }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )
    response = await send(tagRequest({ imageId: IMAGE, features: FEATURES }))
    expect(response.status).toBe(422)
    expect((await bodyOf(response)).error).toBe("bad_answer")

    anthropic.reply = () => messageWith({ caption: 3 })
    response = await send(tagRequest({ imageId: IMAGE, features: FEATURES }))
    expect(response.status).toBe(422)
  })

  it("answers 422 when the model declines", async () => {
    await keepKey()
    anthropic.reply = () => messageWith({ caption: "", features: [] }, "refusal")
    const response = await send(tagRequest({ imageId: IMAGE, features: FEATURES }))
    expect(response.status).toBe(422)
    expect((await bodyOf(response)).error).toBe("refused")
  })
})

describe("the Cloudflare provider", () => {
  beforeEach(async () => {
    await allowCloudflare()
    await optIntoCloudflare()
  })

  it("asks the model with the picture as a data URL, the features, and the schema, and the shared step reads the answer", async () => {
    const ai = fakeAi(() => completion(JSON.stringify(GOOD)))
    Object.assign(harness.env, { AI: ai.binding })
    const response = await send(tagRequest({ imageId: IMAGE, features: FEATURES }))
    expect(response.status).toBe(200)
    expect(await bodyOf(response)).toEqual({ suggestion: READ, provider: "cloudflare" })
    expect(ai.calls).toHaveLength(1)
    const { model, input } = ai.calls[0]
    expect(model).toBe(CLOUDFLARE_AI_MODEL)
    expect(input.response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "tag_suggestion", schema: expect.objectContaining({ type: "object" }) },
    })
    expect(input.messages[0]).toEqual({ role: "system", content: expect.any(String) })
    const [image, text] = input.messages[1].content
    expect(image).toEqual({
      type: "image_url",
      image_url: { url: "data:image/png;base64,iVBORwECAw==" },
    })
    expect(text.text).toContain("- Location (one value): Mauritius, Lisbon")
    expect(text.text).toContain("JSON only")
    expect(await aiCalls()).toEqual([{ calls_today: 1 }])
  })

  it("asks again without response_format when the model refuses it, and reads a fenced answer", async () => {
    const ai = fakeAi((_, input) => {
      if (input.response_format) throw new Error("response_format is not supported")
      return completion(
        "Here you go:\n```json\n" + JSON.stringify(GOOD) + "\n```\nHope that helps.",
      )
    })
    Object.assign(harness.env, { AI: ai.binding })
    const response = await send(tagRequest({ imageId: IMAGE, features: FEATURES }))
    expect(response.status).toBe(200)
    expect((await bodyOf(response)).suggestion).toEqual(READ)
    expect(ai.calls).toHaveLength(2)
    expect(ai.calls[1].input.response_format).toBeUndefined()
    expect(ai.calls[1].input.messages).toEqual(ai.calls[0].input.messages)
  })

  it("reads the older `response` shape too", async () => {
    const ai = fakeAi(() => ({ response: JSON.stringify(GOOD) }))
    Object.assign(harness.env, { AI: ai.binding })
    expect((await send(tagRequest({ imageId: IMAGE, features: FEATURES }))).status).toBe(200)
  })

  it("answers 422 bad_answer when the model's answer is not a suggestion", async () => {
    for (const content of ["I cannot see the picture.", '{"caption": 7}', "{not json"]) {
      const ai = fakeAi(() => completion(content))
      Object.assign(harness.env, { AI: ai.binding })
      const response = await send(tagRequest({ imageId: IMAGE, features: FEATURES }))
      expect(response.status).toBe(422)
      expect((await bodyOf(response)).error).toBe("bad_answer")
    }
  })

  it("answers 502 when the binding fails both ways", async () => {
    const ai = fakeAi(() => {
      throw new Error("InferenceUpstreamError")
    })
    Object.assign(harness.env, { AI: ai.binding })
    const response = await send(tagRequest({ imageId: IMAGE, features: FEATURES }))
    expect(response.status).toBe(502)
    expect(await bodyOf(response)).toEqual({
      error: "provider_error",
      provider: "cloudflare",
      status: null,
    })
    expect(ai.calls).toHaveLength(2)
  })

  it("shares the daily limit with the Anthropic path", async () => {
    const ai = fakeAi(() => completion(JSON.stringify(GOOD)))
    Object.assign(harness.env, { AI: ai.binding })
    expect(
      (await send(tagRequest({ imageId: IMAGE, features: [] }), { dailyLimit: 1 })).status,
    ).toBe(200)
    const response = await send(tagRequest({ imageId: IMAGE, features: [] }), { dailyLimit: 1 })
    expect(response.status).toBe(429)
    expect(ai.calls).toHaveLength(1)
  })
})

describe("spendAiCall", () => {
  const DAY = 24 * 60 * 60 * 1000

  it("counts a day's calls per account, and starts over on a new day", async () => {
    expect(await spendAiCall(harness.control, USER, 10 * DAY, 2)).toEqual({
      ok: true,
      callsToday: 1,
    })
    expect(await spendAiCall(harness.control, USER, 10 * DAY + 1, 2)).toEqual({
      ok: true,
      callsToday: 2,
    })
    expect(await spendAiCall(harness.control, USER, 10 * DAY + 2, 2)).toEqual({
      ok: false,
      reason: "daily_limit",
    })
    expect(await spendAiCall(harness.control, 8, 10 * DAY + 2, 2)).toEqual({
      ok: true,
      callsToday: 1,
    })
    expect(await spendAiCall(harness.control, USER, 11 * DAY, 2)).toEqual({
      ok: true,
      callsToday: 1,
    })
  })
})
