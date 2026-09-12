// How much an agent may ask for, and what it is told when it has asked for
// too much (docs/mcp-rate-limiting.md).
//
// ## Per token
//
// Not per user, not per IP. The token is the thing a person minted, can
// revoke, and can reason about — "this one is looping" is a sentence about a
// token — and it is already read on every request, so keying a limit by it
// costs no extra lookup. A user's other agents keep working while one is shut
// out, which is the behaviour a person would expect from a thing they minted
// separately.
//
// ## Two limits, because the failure modes differ
//
// A **burst** limit catches a runaway loop within a minute, before it has done
// anything much. A **daily** limit catches the slow steady drain a burst limit
// is blind to — an agent politely making one call a second all day is inside
// any per-minute limit worth having and still makes 86,400 calls.
//
// They are enforced by different machinery for the same reason they exist
// separately:
//
//   burst  → Cloudflare's rate-limiting binding. No database round trip at
//            all, which matters because this is the check a runaway loop hits
//            over and over: refusing must be cheaper than answering.
//   daily  → one UPDATE on the token's own row, which the request has already
//            located by hash. A per-call write is a real cost and the reason
//            the counter refuses to increment past the cap: once a token has
//            spent its day, the statement matches no row and writes nothing,
//            so the counter's cost is bounded by the limit it enforces.
//
// The burst check runs FIRST, so a loop that trips it never reaches the write.
//
// ## Answering
//
// HTTP 429 with `Retry-After`, and — for a tool call — a tool-execution error
// rather than a protocol error, because the model can act on this one: the fix
// is to wait, not to rephrase. The message says which limit, and for how long,
// so a transcript tells the PERSON whether to raise a limit or fix an agent.

import type { SqlDriver } from "../../src/data/sql-driver"

/**
 * Calls one token may make in a minute. Generous by design: an agent reading
 * a note, walking two branches and writing a block makes a handful of calls in
 * a second or two, and a limit that interrupts real work teaches a person to
 * raise it rather than to look at what tripped it. This one is a fuse, not a
 * quota.
 */
export const BURST_LIMIT = 120
/** The window the burst limit is measured over. Cloudflare's binding offers 10
 * or 60 seconds; 60 is the one that catches a loop without punishing a flurry. */
export const BURST_WINDOW_SECONDS = 60

/**
 * Calls one token may make in a UTC day.
 *
 * 5,000 against a traversal read of a few dozen rows is well inside D1's
 * 5M-rows-per-day budget even if every one of them were a corpus-wide
 * `search` — and it is far more than an agent doing real work needs. It exists
 * so that a loop slow enough to slip past the burst limit still has an end.
 */
export const DAILY_LIMIT = 5_000

const DAY_MS = 24 * 60 * 60 * 1000

/** The UTC day a timestamp falls in. Stored beside the count, which is what
 * makes the reset free: a new day is a different number, not a swept row. */
export const dayOf = (now: number): number => Math.floor(now / DAY_MS)

/**
 * Cloudflare's rate-limiting binding, structurally — so the Worker's types do
 * not have to carry the whole shape and a test can pass a fake one.
 */
export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>
}

export interface RateRefusal {
  /** Which limit, for the message and for the tests. */
  limit: "burst" | "daily"
  /** Seconds to wait, for `Retry-After`. */
  retryAfter: number
  /** What the model is told. Written to be acted on, not merely reported. */
  message: string
}

/** What a token has spent, for the Settings panel and for a refusal. */
interface RateSpend {
  callsToday: number
  dailyLimit: number
}

export type RateVerdict = { ok: true; spend: RateSpend } | { ok: false; refusal: RateRefusal }

/** Seconds from `now` to the next UTC midnight — how long a spent day lasts. */
const untilTomorrow = (now: number): number => Math.ceil(((dayOf(now) + 1) * DAY_MS - now) / 1000)

/**
 * Count one call against a token's day, and refuse it if the day is spent.
 *
 * One statement does both. The `WHERE` clause is the limit: a row whose
 * `calls_day` is today and whose `calls_today` has reached the cap does not
 * match, so nothing is written and `RETURNING` comes back empty — which is how
 * this function knows to refuse. A row on a different day (or a token that has
 * never been used) matches and starts at 1.
 *
 * `last_used_at` rides along, which is why this replaced the hourly touch it
 * used to be: the write is happening anyway, so the stamp may as well be
 * exact.
 */
export async function spendDailyCall(
  driver: SqlDriver,
  tokenId: string,
  now: number = Date.now(),
  limit: number = DAILY_LIMIT,
): Promise<RateVerdict> {
  const today = dayOf(now)
  const rows = await driver.exec(
    "UPDATE mcp_tokens SET last_used_at = ?2, calls_day = ?3, " +
      "calls_today = CASE WHEN calls_day = ?3 THEN calls_today + 1 ELSE 1 END " +
      "WHERE id = ?1 AND (calls_day IS NULL OR calls_day <> ?3 OR calls_today < ?4) " +
      "RETURNING calls_today",
    [tokenId, now, today, limit],
  )
  if (rows.length === 0) {
    return {
      ok: false,
      refusal: {
        limit: "daily",
        retryAfter: untilTomorrow(now),
        message:
          `This token has made its ${limit} calls for today. It can call again after ` +
          `00:00 UTC. Stop retrying — nothing will succeed until then. If the work is ` +
          `real rather than a loop, ask the person who minted this token for a second one.`,
      },
    }
  }
  return { ok: true, spend: { callsToday: Number(rows[0].calls_today), dailyLimit: limit } }
}

/**
 * The whole check, in the order it must happen: the free one first.
 *
 * With no burst binding configured the burst check is skipped rather than
 * failing closed, and that is deliberate: the binding is infrastructure, and a
 * missing one is a deployment that has not been updated, not an attack. The
 * daily limit still applies, so a Worker without the binding is limited, just
 * more slowly. Tests pass a fake binding to exercise the other half.
 */
export async function checkRateLimit(
  driver: SqlDriver,
  tokenId: string,
  burst: RateLimiter | undefined,
  now: number = Date.now(),
): Promise<RateVerdict> {
  if (burst !== undefined) {
    const { success } = await burst.limit({ key: tokenId })
    if (!success) {
      return {
        ok: false,
        refusal: {
          limit: "burst",
          retryAfter: BURST_WINDOW_SECONDS,
          message:
            `This token is calling too fast — the limit is ${BURST_LIMIT} calls a ` +
            `minute. Wait ${BURST_WINDOW_SECONDS} seconds and continue; the call was ` +
            `not performed, so nothing was half-done. If you are in a loop, stop and ` +
            `say what you were trying to do.`,
        },
      }
    }
  }
  return spendDailyCall(driver, tokenId, now)
}
