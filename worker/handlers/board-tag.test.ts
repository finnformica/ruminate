import { beforeEach, describe, expect, it } from "vitest"
import {
  AUTO_TAG_MAX_IMAGE_BYTES,
  AUTO_TAG_MODEL,
  CLOUDFLARE_AI_MODEL,
  type TagFeature,
} from "../../src/data/auto-tag"
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
 * is refused before a call is spent, what goes out (the bytes the client
 * sent, as they came), and how the one shared step reads the answer back.
 */

const ADMIN = 42536816
const USER = 7
const KEY = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCD"
const ANTHROPIC = "https://api.anthropic.com/v1/messages"

/** A few bytes that stand for a fitted JPEG. */
const PICTURE = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])
const PICTURE_BASE64 = "/9j/4AECAw=="

const FEATURES: TagFeature[] = [
  { label: "Location", multi: false, values: ["Mauritius", "Lisbon"], place: true },
  { label: "Object", multi: true, values: [] },
]

const GOOD = {
  caption: "A rattan lamp",
  features: [
    { label: "Location", values: ["Mauritius"] },
    { label: "Object", values: ["Lamp", "lamp"] },
  ],
}

/** What the route answers with for GOOD, read through the shared step. */
const READ = {
  caption: "A rattan lamp",
  features: [
    { label: "Location", values: ["Mauritius"] },
    { label: "Object", values: ["Lamp"] },
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

/** What the stub answers Nominatim with, and what it was asked. */
let nominatim: { reply: () => Response; calls: string[] }

const fetchStub = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input)
  if (url.startsWith("https://nominatim.openstreetmap.org/reverse")) {
    nominatim.calls.push(url)
    return nominatim.reply()
  }
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
  const calls: { model: string; input: any; options: unknown }[] = []
  const binding: {
    run: (model: string, input: any, options?: unknown) => Promise<unknown>
    aiGatewayLogId?: string
  } = {
    async run(model: string, input: any, options?: unknown) {
      calls.push({ model, input, options })
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

/** The form the client sends: the picture as `image`, the features as
 * `features`. Either may be left out, or the picture given another type. */
function tagRequest(
  parts: { image?: Blob | string | null; features?: unknown } = {},
  session: string | null = "good",
): Request {
  const form = new FormData()
  const image =
    parts.image === undefined ? new Blob([PICTURE], { type: "image/jpeg" }) : parts.image
  if (typeof image === "string") form.set("image", image)
  else if (image !== null) form.set("image", image, "picture")
  if (parts.features !== null) {
    form.set(
      "features",
      typeof parts.features === "string"
        ? parts.features
        : JSON.stringify(parts.features === undefined ? FEATURES : parts.features),
    )
  }
  return new Request("https://ruminate.test/api/boards/tag", {
    method: "POST",
    headers:
      session === null ? {} : { Cookie: "gh_refresh=session", Authorization: `Bearer ${session}` },
    body: form,
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
  anthropic = { calls: [], reply: () => messageWith(GOOD) }
  nominatim = {
    calls: [],
    reply: () =>
      new Response(JSON.stringify({ display_name: "Ljubljana, Slovenia" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  }
})

describe("before the call", () => {
  it("refuses an unauthenticated caller", async () => {
    expect((await send(tagRequest({}, null))).status).toBe(401)
    expect(anthropic.calls).toEqual([])
  })

  it("refuses a request that is not a form with a picture and features", async () => {
    await keepKey()
    for (const parts of [
      { image: null },
      { image: "not a file" },
      { features: null },
      { features: "{not json" },
      { features: [{ label: "Location" }] },
      { features: "nonsense" },
    ]) {
      expect((await send(tagRequest(parts))).status).toBe(400)
    }
    const notAForm = new Request("https://ruminate.test/api/boards/tag", {
      method: "POST",
      headers: sessionHeaders,
      body: JSON.stringify({ features: FEATURES }),
    })
    expect((await send(notAForm)).status).toBe(400)
    expect(anthropic.calls).toEqual([])
    expect(await aiCalls()).toEqual([])
  })

  it("says clearly when nothing is set up, and spends nothing", async () => {
    const response = await send(tagRequest())
    expect(response.status).toBe(412)
    expect((await bodyOf(response)).error).toBe("no_provider")
    expect(anthropic.calls).toEqual([])
    expect(await aiCalls()).toEqual([])
  })

  it("refuses a format the models do not read, before spending", async () => {
    await keepKey()
    const response = await send(tagRequest({ image: new Blob([PICTURE], { type: "image/avif" }) }))
    expect(response.status).toBe(415)
    expect((await bodyOf(response)).error).toBe("unsupported_image")
    expect(anthropic.calls).toEqual([])
    expect(await aiCalls()).toEqual([])
  })

  it("refuses a picture past the API's limit, before spending", async () => {
    await keepKey()
    const huge = new Blob([new Uint8Array(AUTO_TAG_MAX_IMAGE_BYTES + 1)], { type: "image/jpeg" })
    const response = await send(tagRequest({ image: huge }))
    expect(response.status).toBe(413)
    expect((await bodyOf(response)).error).toBe("image_too_large")
    expect(anthropic.calls).toEqual([])
    expect(await aiCalls()).toEqual([])
  })

  it("refuses an empty picture", async () => {
    await keepKey()
    expect((await send(tagRequest({ image: new Blob([], { type: "image/jpeg" }) }))).status).toBe(
      400,
    )
  })

  it("stops at the daily limit, one count whoever answers", async () => {
    await keepKey()
    expect((await send(tagRequest(), { dailyLimit: 1 })).status).toBe(200)
    const response = await send(tagRequest(), { dailyLimit: 1 })
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
    const response = await send(tagRequest())
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
    const response = await send(tagRequest())
    expect(response.status).toBe(200)
    expect((await bodyOf(response)).provider).toBe("cloudflare")
    expect(ai.calls).toHaveLength(1)
    expect(anthropic.calls).toEqual([])
  })

  it("never calls Workers AI while the flag is off, however the box is ticked", async () => {
    await optIntoCloudflare()
    const ai = fakeAi(() => completion(JSON.stringify(GOOD)))
    Object.assign(harness.env, { AI: ai.binding })
    const response = await send(tagRequest())
    expect(response.status).toBe(412)
    expect((await bodyOf(response)).error).toBe("no_provider")
    expect(ai.calls).toEqual([])
    expect(await aiCalls()).toEqual([])
  })

  it("is nothing when the flag allows but the box is not ticked", async () => {
    await allowCloudflare()
    const ai = fakeAi(() => completion(JSON.stringify(GOOD)))
    Object.assign(harness.env, { AI: ai.binding })
    expect((await send(tagRequest())).status).toBe(412)
    expect(ai.calls).toEqual([])
  })

  it("answers 501 when Cloudflare is chosen but there is no binding", async () => {
    await allowCloudflare()
    await optIntoCloudflare()
    const response = await send(tagRequest())
    expect(response.status).toBe(501)
    expect((await bodyOf(response)).error).toBe("ai_disabled")
    expect(await aiCalls()).toEqual([])
  })
})

describe("the Anthropic provider", () => {
  it("sends the bytes it was given and the features with the kept key, and the shared step reads the answer", async () => {
    await keepKey()
    const response = await send(tagRequest())
    expect(response.status).toBe(200)
    expect(await bodyOf(response)).toEqual({
      suggestion: READ,
      provider: "anthropic",
      model: AUTO_TAG_MODEL,
    })

    expect(anthropic.calls).toHaveLength(1)
    const { headers, body } = anthropic.calls[0]
    expect(headers.get("x-api-key")).toBe(KEY)
    expect(body.model).toBe(AUTO_TAG_MODEL)
    expect(body.output_config.format.type).toBe("json_schema")
    expect(typeof body.system).toBe("string")
    const [image, text] = body.messages[0].content
    expect(image).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: PICTURE_BASE64 },
    })
    expect(text.text).toContain("- Location (one value): Values in use: Mauritius, Lisbon")
    expect(text.text).toContain("- Object (several values): Values in use: none yet")
  })

  it("tells the caller the key was refused, without the key", async () => {
    await keepKey()
    anthropic.reply = () =>
      new Response(
        JSON.stringify({ type: "error", error: { type: "authentication_error", message: "x" } }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      )
    const response = await send(tagRequest())
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
    const response = await send(tagRequest())
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
    let response = await send(tagRequest())
    expect(response.status).toBe(502)
    expect(await bodyOf(response)).toMatchObject({
      error: "provider_error",
      provider: "anthropic",
      model: AUTO_TAG_MODEL,
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
    response = await send(tagRequest())
    expect(response.status).toBe(422)
    expect((await bodyOf(response)).error).toBe("bad_answer")

    anthropic.reply = () => messageWith({ caption: 3 })
    response = await send(tagRequest())
    expect(response.status).toBe(422)
  })

  it("answers 422 when the model declines", async () => {
    await keepKey()
    anthropic.reply = () => messageWith({ caption: "", features: [] }, "refusal")
    const response = await send(tagRequest())
    expect(response.status).toBe(422)
    expect((await bodyOf(response)).error).toBe("refused")
  })
})

describe("the Cloudflare provider", () => {
  beforeEach(async () => {
    await allowCloudflare()
    await optIntoCloudflare()
  })

  it("asks the model with the same bytes as a data URL, the features, and the schema, and the shared step reads the answer", async () => {
    const ai = fakeAi(() => completion(JSON.stringify(GOOD)))
    Object.assign(harness.env, { AI: ai.binding })
    const response = await send(tagRequest())
    expect(response.status).toBe(200)
    expect(await bodyOf(response)).toEqual({
      suggestion: READ,
      provider: "cloudflare",
      model: CLOUDFLARE_AI_MODEL,
    })
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
      image_url: { url: `data:image/jpeg;base64,${PICTURE_BASE64}` },
    })
    expect(text.text).toContain("- Location (one value): Values in use: Mauritius, Lisbon")
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
    const response = await send(tagRequest())
    expect(response.status).toBe(200)
    expect((await bodyOf(response)).suggestion).toEqual(READ)
    expect(ai.calls).toHaveLength(2)
    expect(ai.calls[1].input.response_format).toBeUndefined()
    expect(ai.calls[1].input.messages).toEqual(ai.calls[0].input.messages)
  })

  it("reads the older `response` shape too", async () => {
    const ai = fakeAi(() => ({ response: JSON.stringify(GOOD) }))
    Object.assign(harness.env, { AI: ai.binding })
    expect((await send(tagRequest())).status).toBe(200)
  })

  it("answers 422 bad_answer when the model's answer is not a suggestion", async () => {
    for (const content of ["I cannot see the picture.", '{"caption": 7}', "{not json"]) {
      const ai = fakeAi(() => completion(content))
      Object.assign(harness.env, { AI: ai.binding })
      const response = await send(tagRequest())
      expect(response.status).toBe(422)
      expect((await bodyOf(response)).error).toBe("bad_answer")
    }
  })

  it("answers 502 when the binding fails both ways", async () => {
    const ai = fakeAi(() => {
      throw new Error("InferenceUpstreamError")
    })
    Object.assign(harness.env, { AI: ai.binding })
    const response = await send(tagRequest())
    expect(response.status).toBe(502)
    expect(await bodyOf(response)).toEqual({
      error: "provider_error",
      provider: "cloudflare",
      model: CLOUDFLARE_AI_MODEL,
      status: null,
      message: "InferenceUpstreamError",
    })
    expect(ai.calls).toHaveLength(2)
  })

  it("shares the daily limit with the Anthropic path", async () => {
    const ai = fakeAi(() => completion(JSON.stringify(GOOD)))
    Object.assign(harness.env, { AI: ai.binding })
    expect((await send(tagRequest(), { dailyLimit: 1 })).status).toBe(200)
    const response = await send(tagRequest(), { dailyLimit: 1 })
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

// -----------------------------------------------------------------------------
// What Workers AI is asked, and the shapes it answers in. Stubbed: it
// cannot be reached from here.
// -----------------------------------------------------------------------------

describe("the Cloudflare call, as it goes out and comes back", () => {
  beforeEach(async () => {
    await allowCloudflare()
    await optIntoCloudflare()
  })

  it("asks with reasoning off, a capped output under both names, and through the gateway", async () => {
    const ai = fakeAi(() => completion(JSON.stringify(GOOD)))
    Object.assign(harness.env, { AI: ai.binding })
    expect((await send(tagRequest())).status).toBe(200)
    const { input, options } = ai.calls[0]
    expect(input.chat_template_kwargs).toEqual({ enable_thinking: false })
    expect(input.max_completion_tokens).toBe(400)
    expect(input.max_tokens).toBe(400)
    expect(input.temperature).toBe(0.2)
    expect(options).toEqual({ gateway: { id: "default" } })
  })

  it("reads JSON mode's answer, which comes back already parsed in `response`", async () => {
    const ai = fakeAi(() => ({ response: GOOD }))
    Object.assign(harness.env, { AI: ai.binding })
    const response = await send(tagRequest())
    expect(response.status).toBe(200)
    expect((await bodyOf(response)).suggestion).toEqual(READ)
  })

  it("reads an answer given as parts, and one given parsed on the message", async () => {
    const parts = fakeAi(() => ({
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "```json\n" + JSON.stringify(GOOD).slice(0, 20) },
              { type: "image_url", image_url: { url: "x" } },
              { type: "text", text: JSON.stringify(GOOD).slice(20) + "\n```" },
            ],
          },
          finish_reason: "stop",
        },
      ],
    }))
    Object.assign(harness.env, { AI: parts.binding })
    expect((await bodyOf(await send(tagRequest()))).suggestion).toEqual(READ)

    const parsed = fakeAi(() => ({
      choices: [{ index: 0, message: { role: "assistant", parsed: GOOD }, finish_reason: "stop" }],
    }))
    Object.assign(harness.env, { AI: parsed.binding })
    expect((await bodyOf(await send(tagRequest()))).suggestion).toEqual(READ)
  })

  it("carries the gateway log id on an answer and on a refusal", async () => {
    const ai = fakeAi(() => completion(JSON.stringify(GOOD)))
    ai.binding.aiGatewayLogId = "01LOG"
    Object.assign(harness.env, { AI: ai.binding })
    expect(await bodyOf(await send(tagRequest()))).toEqual({
      suggestion: READ,
      provider: "cloudflare",
      model: CLOUDFLARE_AI_MODEL,
      log: "01LOG",
    })

    const bad = fakeAi(() => completion("I cannot see the picture."))
    bad.binding.aiGatewayLogId = "01BAD"
    Object.assign(harness.env, { AI: bad.binding })
    const response = await send(tagRequest())
    expect(response.status).toBe(422)
    expect(await bodyOf(response)).toEqual({
      error: "bad_answer",
      provider: "cloudflare",
      model: CLOUDFLARE_AI_MODEL,
      log: "01BAD",
      detail: {
        provider: "cloudflare",
        model: CLOUDFLARE_AI_MODEL,
        log: "01BAD",
        answer: "I cannot see the picture.",
      },
    })
  })

  it("says what the binding said when it fails, and never the key", async () => {
    await keepKey()
    // A key kept routes to Anthropic; make that fail instead, so the
    // body's words are an SDK error's, and check the key is not in them.
    anthropic.reply = () =>
      new Response(
        JSON.stringify({
          type: "error",
          error: { type: "overloaded_error", message: "Overloaded" },
        }),
        { status: 529, headers: { "Content-Type": "application/json" } },
      )
    const response = await send(tagRequest())
    expect(response.status).toBe(502)
    const body = await bodyOf(response)
    expect(body).toMatchObject({
      error: "provider_error",
      provider: "anthropic",
      model: AUTO_TAG_MODEL,
      status: 529,
    })
    expect(typeof body.message).toBe("string")
    expect(body.message).toContain("Overloaded")
    expect(JSON.stringify(body)).not.toContain(KEY)
  })
})

// -----------------------------------------------------------------------------
// Where the picture was taken: a place name for the prompt, when the
// block carries coordinates. Nominatim stubbed: it is not called from here.
// -----------------------------------------------------------------------------

describe("a location with the request", () => {
  const AT = { lat: 46.05127, lon: 14.50556 }
  const promptText = () => anthropic.calls[0].body.messages[0].content[1].text as string

  it("names the place for the model, asked of Nominatim once", async () => {
    await keepKey()
    const response = await send(tagRequest({ features: { features: FEATURES, location: AT } }))
    expect(response.status).toBe(200)
    expect(nominatim.calls).toEqual([
      "https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&lat=46.05127&lon=14.50556",
    ])
    expect(promptText()).toContain("- Location (one value): Values in use: Mauritius, Lisbon")
    expect(promptText()).toContain(
      "The picture was taken at: Ljubljana; Slovenia (most specific first). For Location, use a value in use that covers the place; otherwise name it as a person would in conversation — the country by default, or the everyday short name of a notable specific place such as an airport, a landmark or a city.",
    )
  })

  it("gives the coordinates when no place can be found, and still tags", async () => {
    await keepKey()
    nominatim.reply = () => new Response("", { status: 503 })
    const response = await send(tagRequest({ features: { features: FEATURES, location: AT } }))
    expect(response.status).toBe(200)
    expect(promptText()).toContain(
      "The picture was taken at latitude 46.05127, longitude 14.50556: name the town or area for Location.",
    )
  })

  it("says nothing of a location when there is none, and drops one off the globe", async () => {
    await keepKey()
    expect((await send(tagRequest())).status).toBe(200)
    expect(nominatim.calls).toEqual([])
    expect(promptText()).not.toContain("The picture was taken")

    anthropic.calls = []
    const response = await send(
      tagRequest({ features: { features: FEATURES, location: { lat: 95, lon: 14 } } }),
    )
    expect(response.status).toBe(200)
    expect(nominatim.calls).toEqual([])
    expect(promptText()).not.toContain("The picture was taken")
  })

  it("asks Nominatim nothing for a call the day refuses", async () => {
    await keepKey()
    expect(
      (
        await send(tagRequest({ features: { features: FEATURES, location: AT } }), {
          dailyLimit: 1,
        })
      ).status,
    ).toBe(200)
    const response = await send(tagRequest({ features: { features: FEATURES, location: AT } }), {
      dailyLimit: 1,
    })
    expect(response.status).toBe(429)
    expect(nominatim.calls).toHaveLength(1)
  })

  it("asks Nominatim nothing, and says nothing, for a board with no place feature", async () => {
    await keepKey()
    const unplaced = FEATURES.map(({ place: _place, ...feature }) => feature)
    const response = await send(tagRequest({ features: { features: unplaced, location: AT } }))
    expect(response.status).toBe(200)
    expect(nominatim.calls).toEqual([])
    expect(promptText()).not.toContain("The picture was taken")
  })

  it("names the place feature as the board calls it", async () => {
    await keepKey()
    const renamed: TagFeature[] = [
      { label: "Where", multi: false, values: [], place: true },
      { label: "Object", multi: true, values: [] },
    ]
    const response = await send(tagRequest({ features: { features: renamed, location: AT } }))
    expect(response.status).toBe(200)
    expect(promptText()).toContain("For Where, use a value in use that covers the place")
  })

  it("reaches the Cloudflare provider's prompt too", async () => {
    await allowCloudflare()
    await optIntoCloudflare()
    const ai = fakeAi(() => completion(JSON.stringify(GOOD)))
    Object.assign(harness.env, { AI: ai.binding })
    expect(
      (await send(tagRequest({ features: { features: FEATURES, location: AT } }))).status,
    ).toBe(200)
    const text = ai.calls[0].input.messages[1].content[1].text as string
    expect(text).toContain("The picture was taken at: Ljubljana; Slovenia")
  })
})
