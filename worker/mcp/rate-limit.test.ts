import { beforeEach, describe, expect, it } from "vitest"
import { mcp } from "../handlers/mcp"
import {
  BURST_LIMIT,
  BURST_WINDOW_SECONDS,
  DAILY_LIMIT,
  checkRateLimit,
  dayOf,
  spendDailyCall,
  type RateLimiter,
} from "./rate-limit"
import { listTokens, mintToken } from "./tokens"
import { createMcpTestEnv, mcpRequest, type McpTestEnv } from "./test-support"

/**
 * The rate limit: per token, two limits, and a refusal a model can act on
 * (docs/mcp-rate-limiting.md).
 *
 * The properties worth pinning are the ones that are easy to get subtly wrong:
 * that the day resets without anything sweeping it, that a token over its
 * limit stops WRITING as well as stops being served, that one token running
 * out does not take another with it, and that a refusal is shaped as advice to
 * a model rather than as a malformed-call error it will try to rephrase its
 * way out of.
 */

const USER = 7
const NOTE = "blk_note"
const DAY_MS = 24 * 60 * 60 * 1000

let harness: McpTestEnv

const mint = async (name = "Agent"): Promise<{ id: string; token: string }> => {
  const minted = await mintToken(harness.control, {
    userId: USER,
    name,
    permissions: ["read"],
    noteIds: null,
    expiresAt: null,
  })
  return { id: minted.summary.id, token: minted.token }
}

/** A burst binding that refuses every call — the runaway-loop case. */
const alwaysOver: RateLimiter = { limit: () => Promise.resolve({ success: false }) }
/** One that allows every call, so the daily half can be tested through it. */
const neverOver: RateLimiter = { limit: () => Promise.resolve({ success: true }) }

beforeEach(async () => {
  harness = await createMcpTestEnv()
  await harness.addUser(USER)
  await harness.seedNote(USER, { id: NOTE, title: "A note", markdown: "- hello world\n" })
})

describe("the daily count", () => {
  it("counts up, and refuses the call past the cap", async () => {
    const { id } = await mint()
    const now = Date.now()
    for (let call = 1; call <= 3; call += 1) {
      const verdict = await spendDailyCall(harness.control, id, now, 3)
      expect(verdict.ok).toBe(true)
      if (verdict.ok) expect(verdict.spend.callsToday).toBe(call)
    }
    const over = await spendDailyCall(harness.control, id, now, 3)
    expect(over.ok).toBe(false)
    if (!over.ok) {
      expect(over.refusal.limit).toBe("daily")
      expect(over.refusal.retryAfter).toBeGreaterThan(0)
      expect(over.refusal.message).toMatch(/Stop retrying/)
    }
  })

  it("stops writing once the day is spent, so the counter cannot outrun its own limit", async () => {
    const { id } = await mint()
    const now = Date.now()
    await spendDailyCall(harness.control, id, now, 1)

    const before = await harness.control.exec("SELECT last_used_at FROM mcp_tokens WHERE id = ?1", [
      id,
    ])
    const refused = await spendDailyCall(harness.control, id, now + 5_000, 1)
    const after = await harness.control.exec("SELECT last_used_at FROM mcp_tokens WHERE id = ?1", [
      id,
    ])

    expect(refused.ok).toBe(false)
    // The statement matched no row: `last_used_at` did not move either, which
    // is the observable shape of "nothing was written".
    expect(after[0].last_used_at).toEqual(before[0].last_used_at)
  })

  it("starts again on the next UTC day, with nothing sweeping the row", async () => {
    const { id } = await mint()
    const now = Date.now()
    await spendDailyCall(harness.control, id, now, 1)
    expect((await spendDailyCall(harness.control, id, now, 1)).ok).toBe(false)

    const tomorrow = (dayOf(now) + 1) * DAY_MS + 1_000
    const fresh = await spendDailyCall(harness.control, id, tomorrow, 1)
    expect(fresh.ok).toBe(true)
    if (fresh.ok) expect(fresh.spend.callsToday).toBe(1)
  })

  it("is per token: one running out does not stop another", async () => {
    const one = await mint("One")
    const two = await mint("Two")
    const now = Date.now()

    await spendDailyCall(harness.control, one.id, now, 1)
    expect((await spendDailyCall(harness.control, one.id, now, 1)).ok).toBe(false)
    expect((await spendDailyCall(harness.control, two.id, now, 1)).ok).toBe(true)
  })

  it("stamps `last_used_at` as it counts, so the two cannot disagree", async () => {
    const { id } = await mint()
    const now = Date.now()
    await spendDailyCall(harness.control, id, now)
    const rows = await harness.control.exec("SELECT last_used_at FROM mcp_tokens WHERE id = ?1", [
      id,
    ])
    expect(Number(rows[0].last_used_at)).toBe(now)
  })
})

describe("the burst limit", () => {
  it("refuses before the database is touched, so refusing is cheaper than answering", async () => {
    const { id } = await mint()
    const verdict = await checkRateLimit(harness.control, id, alwaysOver)
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) {
      expect(verdict.refusal.limit).toBe("burst")
      expect(verdict.refusal.retryAfter).toBe(BURST_WINDOW_SECONDS)
      expect(verdict.refusal.message).toContain(String(BURST_LIMIT))
    }
    // Nothing was counted: the day's budget is not spent by being throttled.
    const summaries = await listTokens(harness.control, USER)
    expect(summaries[0].callsToday).toBe(0)
  })

  it("falls through to the daily count when the binding allows the call", async () => {
    const { id } = await mint()
    const verdict = await checkRateLimit(harness.control, id, neverOver)
    expect(verdict.ok).toBe(true)
    if (verdict.ok) expect(verdict.spend.callsToday).toBe(1)
  })

  it("is skipped, not failed closed, when no binding is configured", async () => {
    // A missing binding is a deployment that has not been rolled out, not an
    // attack — and the daily limit still applies.
    const { id } = await mint()
    const verdict = await checkRateLimit(harness.control, id, undefined)
    expect(verdict.ok).toBe(true)
  })
})

describe("what a refused caller is told", () => {
  const send = (request: Request, burst?: RateLimiter) =>
    mcp(request, { ...harness.env, MCP_BURST: burst })

  it("answers a throttled tool call with 429, Retry-After, and a TOOL error", async () => {
    // A tool error, not a protocol error: the call was perfectly well formed,
    // so telling the model it was malformed would invite it to rephrase and
    // try again. It is told to wait instead.
    const { token } = await mint()
    const response = await send(
      mcpRequest("tools/call", { name: "list_notes" }, { token }),
      alwaysOver,
    )
    expect(response.status).toBe(429)
    expect(response.headers.get("Retry-After")).toBe(String(BURST_WINDOW_SECONDS))

    const body = (await response.json()) as any
    expect(body.error).toBeUndefined()
    expect(body.result.isError).toBe(true)
    expect(body.result.content[0].text).toMatch(/too fast/)
  })

  it("answers a throttled non-tool method with a protocol error", async () => {
    // There is no tool to fail, so there is nothing to hand a model as a tool
    // result; the JSON-RPC error is the honest shape.
    const { token } = await mint()
    const response = await send(mcpRequest("tools/list", {}, { token }), alwaysOver)
    expect(response.status).toBe(429)
    expect(response.headers.get("Retry-After")).toBe(String(BURST_WINDOW_SECONDS))
    expect(((await response.json()) as any).error.message).toMatch(/too fast/)
  })

  it("serves the call, and counts it, when the token is inside its limits", async () => {
    const { token } = await mint()
    const response = await send(mcpRequest("tools/call", { name: "list_notes" }, { token }))
    expect(response.status).toBe(200)
    expect(response.headers.get("Retry-After")).toBeNull()

    const summaries = await listTokens(harness.control, USER)
    expect(summaries[0].callsToday).toBe(1)
    expect(summaries[0].dailyLimit).toBe(DAILY_LIMIT)
  })

  it("counts a call that failed, so failing is not a way round the limit", async () => {
    const { token } = await mint()
    await send(mcpRequest("tools/call", { name: "read_note" }, { token }))
    expect((await listTokens(harness.control, USER))[0].callsToday).toBe(1)
  })

  it("never counts an unauthenticated request against anybody", async () => {
    await send(mcpRequest("tools/call", { name: "list_notes" }, { token: "rmn_mcp_nope" }))
    const { token } = await mint()
    await send(mcpRequest("tools/call", { name: "list_notes" }, { token }))
    expect((await listTokens(harness.control, USER))[0].callsToday).toBe(1)
  })

  it("shows the day's usage beside the token, and forgets it tomorrow", async () => {
    const { token } = await mint()
    await send(mcpRequest("tools/call", { name: "list_notes" }, { token }))
    expect((await listTokens(harness.control, USER))[0].callsToday).toBe(1)
    // Yesterday's count is history, not today's usage — which is what makes
    // the reset free.
    const tomorrow = Date.now() + DAY_MS
    expect((await listTokens(harness.control, USER, tomorrow))[0].callsToday).toBe(0)
  })
})
