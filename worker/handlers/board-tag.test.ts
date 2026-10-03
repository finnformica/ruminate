import { beforeEach, describe, expect, it } from "vitest"
import { AUTO_TAG_MODEL, type TagFeature } from "../../src/data/auto-tag"
import { createMcpTestEnv, type McpTestEnv } from "../mcp/test-support"
import { anthropicKey } from "./anthropic-key"
import { boardTag } from "./board-tag"

/**
 * The tagging route, with the Anthropic API stubbed: there is no key to
 * call it with from a test, and the point here is what the route does
 * around the call — who may call, what it refuses before spending, what it
 * sends, and how it reads the answer back.
 */

const USER = 7
const KEY = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCD"
const IMAGE = "img_abcdefghijkl"
const ANTHROPIC = "https://api.anthropic.com/v1/messages"

const FEATURES: TagFeature[] = [
  { label: "Location", multi: false, values: ["Mauritius", "Lisbon"] },
  { label: "Fixture", multi: true, values: [] },
]

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
    headers: {
      "Content-Type": "application/json",
      Cookie: "gh_refresh=session",
      Authorization: "Bearer good",
    },
    body: JSON.stringify({ key: KEY }),
  })
  expect((await anthropicKey(request, harness.env, fetchStub)).status).toBe(200)
}

beforeEach(async () => {
  harness = await createMcpTestEnv()
  await harness.addUser(USER)
  await harness.putImage(
    USER,
    IMAGE,
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]),
    "image/png",
  )
  anthropic = {
    calls: [],
    reply: () =>
      messageWith({
        caption: "A rattan lamp",
        features: [
          { label: "Location", values: ["Mauritius"] },
          { label: "Fixture", values: ["Lamp", "lamp"] },
        ],
      }),
  }
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

  it("says clearly when no key is kept, and spends nothing", async () => {
    const response = await send(tagRequest({ imageId: IMAGE, features: FEATURES }))
    expect(response.status).toBe(412)
    expect((await bodyOf(response)).error).toBe("no_api_key")
    expect(anthropic.calls).toEqual([])
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
    const rows = await harness.control.exec("SELECT calls_today FROM anthropic_keys")
    expect(rows).toEqual([{ calls_today: 0 }])
  })

  it("stops at the daily limit", async () => {
    await keepKey()
    expect(
      (await send(tagRequest({ imageId: IMAGE, features: [] }), { dailyLimit: 1 })).status,
    ).toBe(200)
    const response = await send(tagRequest({ imageId: IMAGE, features: [] }), { dailyLimit: 1 })
    expect(response.status).toBe(429)
    expect((await bodyOf(response)).error).toBe("daily_limit")
    expect(response.headers.get("Retry-After")).toBe("3600")
    expect(anthropic.calls).toHaveLength(1)
  })
})

describe("the call", () => {
  it("sends the picture and the features with the kept key, and reads the answer back", async () => {
    await keepKey()
    const response = await send(tagRequest({ imageId: IMAGE, features: FEATURES }))
    expect(response.status).toBe(200)
    expect(await bodyOf(response)).toEqual({
      suggestion: {
        caption: "A rattan lamp",
        features: [
          { label: "Location", values: ["Mauritius"] },
          { label: "Fixture", values: ["Lamp"] },
        ],
      },
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

  it("answers 502 when the API fails, or answers something other than asked", async () => {
    await keepKey()
    anthropic.reply = () =>
      new Response(
        JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "x" } }),
        { status: 529, headers: { "Content-Type": "application/json" } },
      )
    let response = await send(tagRequest({ imageId: IMAGE, features: FEATURES }))
    expect(response.status).toBe(502)
    expect(await bodyOf(response)).toEqual({ error: "anthropic_error", status: 529 })

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
    expect(response.status).toBe(502)

    anthropic.reply = () => messageWith({ caption: 3 })
    response = await send(tagRequest({ imageId: IMAGE, features: FEATURES }))
    expect(response.status).toBe(502)
  })

  it("answers 422 when the model declines", async () => {
    await keepKey()
    anthropic.reply = () => messageWith({ caption: "", features: [] }, "refusal")
    const response = await send(tagRequest({ imageId: IMAGE, features: FEATURES }))
    expect(response.status).toBe(422)
    expect((await bodyOf(response)).error).toBe("refused")
  })
})
