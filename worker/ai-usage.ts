// A day's calls to Workers AI, per account (migrations/0019) — the fuse on
// the free provider's path in worker/handlers/board-tag.ts.
//
// The same shape as an MCP token's day (worker/mcp/rate-limit.ts) and the
// Anthropic key's (worker/handlers/anthropic-key.ts): one statement counts
// the call, and a day already spent matches nothing, so nothing is written
// and the caller is refused. An account with no row yet starts at one.

import { AUTO_TAG_DAILY_LIMIT } from "../src/data/auto-tag"
import type { SqlDriver } from "../src/data/sql-driver"
import { dayOf } from "./mcp/rate-limit"

export type AiSpend = { ok: true; callsToday: number } | { ok: false; reason: "daily_limit" }

export async function spendAiCall(
  driver: SqlDriver,
  userId: number,
  now: number,
  limit: number = AUTO_TAG_DAILY_LIMIT,
): Promise<AiSpend> {
  const today = dayOf(now)
  const rows = await driver.exec(
    "INSERT INTO ai_usage (user_id, calls_day, calls_today) VALUES (?1, ?2, 1) " +
      "ON CONFLICT (user_id) DO UPDATE SET calls_day = ?2, " +
      "calls_today = CASE WHEN calls_day = ?2 THEN calls_today + 1 ELSE 1 END " +
      "WHERE calls_day <> ?2 OR calls_today < ?3 " +
      "RETURNING calls_today",
    [userId, today, limit],
  )
  const row = rows[0]
  if (row) return { ok: true, callsToday: Number(row.calls_today) }
  return { ok: false, reason: "daily_limit" }
}
