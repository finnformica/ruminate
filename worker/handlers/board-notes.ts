// `POST /api/boards/notes` — notes for a board's features, from a model
// (docs/boards.md, "Features"): the one line each feature's note tells the
// vision model when a picture is tagged, written for the features that lack
// one. The same AI path as tagging (worker/ai.ts): the provider resolved
// from the Worker's own truth, the day's call counted on the same fuse
// (worker/ai-usage.ts), the same refusals. The request is JSON — the
// board's name and its features, all text already on the board, no
// picture (`NotesRequest`, src/data/auto-notes.ts); the answer is read
// leniently (`extractJson`, `readNotesSuggestion`) and returned, and the
// client writes it through the board's ordinary writes. This route writes
// nothing to the graph — the call goes to the history (worker/ai-history.ts)
// as `board-notes` — and reads nothing of the caller's but the session.
//
// Refusals, each a code the client puts into words:
//   400 invalid_body         not a board with features
//   412 no_provider          nothing set up — Settings → AI
//   501 ai_disabled          Cloudflare chosen, but no binding
//   429 daily_limit          the account's calls for today are spent
//   429 rate_limited         the API said to slow down (its Retry-After passed on)
//   422 invalid_api_key      Anthropic refused the key
//   422 refused              the model declined
//   422 bad_answer           the answer is not a suggestion (the answer is in `detail`)
//   502 provider_error       the provider failed (its words are in `message`)

import {
  AUTO_NOTES_SYSTEM_PROMPT,
  cloudflareNotesPrompt,
  notesOutputSchema,
  notesPrompt,
  readNotesRequest,
  readNotesSuggestion,
  type NotesResponse,
} from "../../src/data/auto-notes"
import { SUGGEST_CODES } from "../../src/data/ai-codes"
import { AI_KINDS } from "../../src/data/ai-kinds"
import { extractJson } from "../../src/data/auto-tag"
import { askAndRead, dailyLimitResponse, json, refusal, resolveAsker } from "../ai"
import { spendAiCall } from "../ai-usage"
import { controlPlaneDriver } from "../tenancy-db"
import type { Env } from "../types"
import { requireSession } from "./replica"

export const BOARD_NOTES_PATH = "/api/boards/notes"

export async function boardNotes(
  request: Request,
  env: Env,
  fetchImpl: typeof fetch = fetch,
  options: { clock?: () => number; dailyLimit?: number } = {},
): Promise<Response> {
  if (request.method !== "POST") return refusal(SUGGEST_CODES.methodNotAllowed)
  const session = await requireSession(request, env, fetchImpl)
  if (session instanceof Response) return session

  const body = readNotesRequest(await request.json().catch(() => null))
  if (body === null) return refusal(SUGGEST_CODES.invalidBody)

  // Who answers, before a call is counted.
  const asker = await resolveAsker(env, session, fetchImpl)
  if (asker instanceof Response) return asker

  const now = options.clock?.() ?? Date.now()
  const spend = await spendAiCall(controlPlaneDriver(env), session.id, now, options.dailyLimit)
  if (!spend.ok) return dailyLimitResponse("Suggesting has made its calls for today.")

  const answer = await askAndRead(
    env,
    session,
    asker,
    AI_KINDS.boardNotes,
    {
      system: AUTO_NOTES_SYSTEM_PROMPT,
      prompt: notesPrompt(body),
      cloudflarePrompt: cloudflareNotesPrompt(body),
      schema: notesOutputSchema(),
      schemaName: "notes_suggestion",
    },
    (text) => readNotesSuggestion(extractJson(text), body),
    options.clock,
  )
  if (answer instanceof Response) return answer
  const response: NotesResponse = { ...answer.result, ...answer.found }
  return json(response)
}
