import { beforeEach, describe, expect, it } from "vitest"
import type { NotesRequest } from "../../src/data/auto-notes"
import { AUTO_TAG_MODEL, CLOUDFLARE_AI_MODEL } from "../../src/data/auto-tag"
import { setFeatureAudience } from "../features"
import { createMcpTestEnv, type McpTestEnv } from "../mcp/test-support"
import { anthropicKey } from "./anthropic-key"
import { boardNotes } from "./board-notes"
import { boardTag } from "./board-tag"
import { preferences } from "./preferences"

/**
 * The notes route, with both providers stubbed, as the tag route's tests
 * stub them. The point is what the route does around the call: who may
 * call, the shared router, what is refused before a call is spent, what
 * goes out — the board's name, each feature's values and the notes already
 * written — and how the shared step reads the answer back, with the day's
 * fuse shared with tagging.
 */

const ADMIN = 42536816
const USER = 7
const KEY = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCD"
const ANTHROPIC = "https://api.anthropic.com/v1/messages"

const REQUEST: NotesRequest = {
  board: "Home inspiration",
  features: [
    {
      label: "Location",
      type: "place",
      multi: false,
      values: ["Mauritius", "Lisbon"],
      notes: "where the picture was taken, named as a person would say it",
    },
    { label: "Material", type: "text", multi: true, values: ["Oak", "Brass"], notes: "" },
    { label: "Link", type: "link", multi: true, values: [], notes: "" },
  ],
}

const GOOD = {
  notes: [
    { label: "Material", notes: " what that thing is made of " },
    { label: "Link", notes: "where the picture came from, the product or the article" },
  ],
}

const READ = [
  { label: "Material", notes: "what that thing is made of" },
  { label: "Link", notes: "where the picture came from, the product or the article" },
]

let harness: McpTestEnv
let anthropic: { reply: () => Response; calls: { headers: Headers; body: any }[] }

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

function notesRequest(body: unknown = REQUEST, session: string | null = "good"): Request {
  return new Request("https://ruminate.test/api/boards/notes", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(session === null
        ? {}
        : { Cookie: "gh_refresh=session", Authorization: `Bearer ${session}` }),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  })
}

const send = (request: Request, options: { dailyLimit?: number } = {}) =>
  boardNotes(request, harness.env, fetchStub, { clock: () => 5000, ...options })
const bodyOf = async (response: Response) => (await response.json()) as any

async function keepKey() {
  const request = new Request("https://ruminate.test/api/anthropic-key", {
    method: "PUT",
    headers: sessionHeaders,
    body: JSON.stringify({ key: KEY }),
  })
  expect((await anthropicKey(request, harness.env, fetchStub)).status).toBe(200)
}

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
})

describe("before the call", () => {
  it("refuses an unauthenticated caller", async () => {
    expect((await send(notesRequest(REQUEST, null))).status).toBe(401)
    expect(anthropic.calls).toEqual([])
  })

  it("refuses a body that is not a board with features, and spends nothing", async () => {
    await keepKey()
    for (const body of [
      "{not json",
      { features: [] },
      { board: "b" },
      { board: "b", features: [{ label: "L" }] },
    ]) {
      expect((await send(notesRequest(body))).status).toBe(400)
    }
    expect(anthropic.calls).toEqual([])
    expect(await aiCalls()).toEqual([])
  })

  it("refuses any other method", async () => {
    const request = new Request("https://ruminate.test/api/boards/notes", {
      headers: sessionHeaders,
    })
    expect((await send(request)).status).toBe(405)
  })

  it("says clearly when nothing is set up, and spends nothing", async () => {
    const response = await send(notesRequest())
    expect(response.status).toBe(412)
    expect((await bodyOf(response)).error).toBe("no_provider")
    expect(await aiCalls()).toEqual([])
  })

  it("answers 501 when Cloudflare is chosen but there is no binding", async () => {
    await allowCloudflare()
    await optIntoCloudflare()
    expect((await send(notesRequest())).status).toBe(501)
    expect(await aiCalls()).toEqual([])
  })

  it("shares the daily fuse with tagging: one count, whichever route asked", async () => {
    await keepKey()
    const picture = new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])], {
      type: "image/jpeg",
    })
    const form = new FormData()
    form.set("image", picture, "picture")
    form.set("features", JSON.stringify({ features: [] }))
    anthropic.reply = () => messageWith({ caption: "A lamp", features: [] })
    const tag = new Request("https://ruminate.test/api/boards/tag", {
      method: "POST",
      headers: { Cookie: "gh_refresh=session", Authorization: "Bearer good" },
      body: form,
    })
    expect(
      (await boardTag(tag, harness.env, fetchStub, { clock: () => 5000, dailyLimit: 1 })).status,
    ).toBe(200)
    anthropic.reply = () => messageWith(GOOD)
    const response = await send(notesRequest(), { dailyLimit: 1 })
    expect(response.status).toBe(429)
    expect((await bodyOf(response)).error).toBe("daily_limit")
    expect(response.headers.get("Retry-After")).toBe("3600")
    expect(await aiCalls()).toEqual([{ calls_today: 1 }])
  })
})

describe("the Anthropic provider", () => {
  it("sends the board's name, every feature's values and its notes, with the kept key and no picture", async () => {
    await keepKey()
    const response = await send(notesRequest())
    expect(response.status).toBe(200)
    expect(await bodyOf(response)).toEqual({
      notes: READ,
      provider: "anthropic",
      model: AUTO_TAG_MODEL,
    })
    expect(anthropic.calls).toHaveLength(1)
    const { headers, body } = anthropic.calls[0]
    expect(headers.get("x-api-key")).toBe(KEY)
    expect(body.model).toBe(AUTO_TAG_MODEL)
    expect(body.output_config.format.type).toBe("json_schema")
    expect(body.system).toContain("mood board")
    expect(body.messages[0].content).toHaveLength(1)
    const [text] = body.messages[0].content
    expect(text.type).toBe("text")
    expect(text.text).toContain("Board: Home inspiration")
    expect(text.text).toContain(
      "- Material (text, several values): Values in use: Oak, Brass. Notes: none",
    )
    expect(text.text).toContain(
      "Notes: where the picture was taken, named as a person would say it",
    )
    expect(text.text).toContain("Write notes for: Material, Link.")
    expect(await aiCalls()).toEqual([{ calls_today: 1 }])
  })

  it("tells the caller the key was refused, without the key", async () => {
    await keepKey()
    anthropic.reply = () =>
      new Response(
        JSON.stringify({ type: "error", error: { type: "authentication_error", message: "x" } }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      )
    const response = await send(notesRequest())
    expect(response.status).toBe(422)
    const body = await bodyOf(response)
    expect(body.error).toBe("invalid_api_key")
    expect(JSON.stringify(body)).not.toContain(KEY)
  })

  it("answers 422 bad_answer with the answer as it came, and 502 with the provider's words", async () => {
    await keepKey()
    anthropic.reply = () =>
      new Response(
        JSON.stringify({
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: AUTO_TAG_MODEL,
          content: [{ type: "text", text: "I would rather not." }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )
    const bad = await send(notesRequest())
    expect(bad.status).toBe(422)
    expect(await bodyOf(bad)).toEqual({
      error: "bad_answer",
      detail: { provider: "anthropic", model: AUTO_TAG_MODEL, answer: "I would rather not." },
      provider: "anthropic",
      model: AUTO_TAG_MODEL,
    })
    anthropic.reply = () =>
      new Response(
        JSON.stringify({
          type: "error",
          error: { type: "overloaded_error", message: "Overloaded" },
        }),
        {
          status: 529,
          headers: { "Content-Type": "application/json" },
        },
      )
    const failed = await send(notesRequest())
    expect(failed.status).toBe(502)
    const body = await bodyOf(failed)
    expect(body.error).toBe("provider_error")
    expect(body.status).toBe(529)
    expect(body.message).toContain("Overloaded")
    expect(JSON.stringify(body)).not.toContain(KEY)
  })
})

describe("the Cloudflare provider", () => {
  beforeEach(async () => {
    await allowCloudflare()
    await optIntoCloudflare()
  })

  it("asks through the gateway with the schema, no picture, and reads the answer", async () => {
    const ai = fakeAi(() => completion(JSON.stringify(GOOD)))
    ai.binding.aiGatewayLogId = "01LOG"
    Object.assign(harness.env, { AI: ai.binding })
    const response = await send(notesRequest())
    expect(response.status).toBe(200)
    expect(await bodyOf(response)).toEqual({
      notes: READ,
      provider: "cloudflare",
      model: CLOUDFLARE_AI_MODEL,
      log: "01LOG",
    })
    const { model, input, options } = ai.calls[0]
    expect(model).toBe(CLOUDFLARE_AI_MODEL)
    expect(options).toEqual({ gateway: { id: "default" } })
    expect(input.response_format).toEqual({
      type: "json_schema",
      json_schema: {
        name: "notes_suggestion",
        schema: expect.objectContaining({ type: "object" }),
      },
    })
    expect(input.chat_template_kwargs).toEqual({ enable_thinking: false })
    expect(input.messages[1].content).toHaveLength(1)
    expect(input.messages[1].content[0].text).toContain("Board: Home inspiration")
    expect(input.messages[1].content[0].text).toContain("JSON only")
    expect(await aiCalls()).toEqual([{ calls_today: 1 }])
  })

  it("answers 422 for an answer that is not notes, carrying the log id", async () => {
    const ai = fakeAi(() => completion("No."))
    ai.binding.aiGatewayLogId = "01LOG"
    Object.assign(harness.env, { AI: ai.binding })
    const response = await send(notesRequest())
    expect(response.status).toBe(422)
    expect((await bodyOf(response)).log).toBe("01LOG")
  })

  it("answers 502 when the binding fails both ways", async () => {
    const ai = fakeAi(() => {
      throw new Error("InferenceUpstreamError")
    })
    Object.assign(harness.env, { AI: ai.binding })
    const response = await send(notesRequest())
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
})
