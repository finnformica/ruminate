// The history of an account's calls to a model (migrations/0022,
// docs/boards.md, "The history"): one row per call made, written by the
// one AI path (worker/ai.ts, `askAndRead`) whichever way the call ends.
// Nothing reads it yet; it is the record an interface over past
// suggestions would be built on.
//
// A row is a record of a call, not the call itself: the ask has already
// been answered or has already failed when the row is written, so a write
// that fails is logged and loses the row, never the answer.

import type { AiKind } from "../src/data/ai-kinds"
import { MAX_HISTORY_TEXT_LENGTH } from "../src/data/ai-limits"
import type { AiProvider } from "../src/data/auto-tag"
import type { SqlDriver } from "../src/data/sql-driver"

export interface AiHistoryRow {
  userId: number
  createdAt: number
  durationMs: number
  kind: AiKind
  provider: AiProvider
  model: string
  log?: string
  system: string
  prompt: string
  image?: { mimeType: string; bytes: number }
  answer?: string
  result?: unknown
  /** `ok`, or the refusal's code. */
  outcome: string
  detail?: string
}

const keep = (text: string | undefined): string | null =>
  text === undefined ? null : text.slice(0, MAX_HISTORY_TEXT_LENGTH)

export async function recordAiCall(driver: SqlDriver, row: AiHistoryRow): Promise<void> {
  try {
    await driver.exec(
      "INSERT INTO ai_history (user_id, created_at, duration_ms, kind, provider, model, log, " +
        "system, prompt, image_type, image_bytes, answer, result, outcome, detail) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
      [
        row.userId,
        row.createdAt,
        row.durationMs,
        row.kind,
        row.provider,
        row.model,
        row.log ?? null,
        keep(row.system),
        keep(row.prompt),
        row.image?.mimeType ?? null,
        row.image?.bytes ?? null,
        keep(row.answer),
        row.result === undefined ? null : keep(JSON.stringify(row.result)),
        row.outcome,
        keep(row.detail),
      ],
    )
  } catch (error) {
    console.error("ai_history: a call was not recorded", error)
  }
}
