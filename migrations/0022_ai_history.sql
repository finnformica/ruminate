-- Migration number: 0022    2026-10-06
--
-- Every call an account has made to a model, kept (docs/boards.md, "The
-- history"): what was asked, what came back, and how it went. The routes
-- that ask a model (worker/ai.ts) write one row per call made, whichever
-- way it ends — an answer read, an answer that was not a suggestion, a
-- refusal the provider passed on, or a failure — and nothing for a call
-- refused before a model was asked (a spent day, a bad request). The
-- table is written and never read by the app yet: it is the record an
-- interface over past suggestions would be built on.
--
-- `kind` is the use the call was made for, a short name the code gives
-- each one (src/data/ai-kinds.ts): `board-tag` for a picture's caption and
-- tags, `board-notes` for a board's feature notes. The prompt kept is the
-- one the chosen provider was sent — the plain text on the Anthropic path,
-- the text with the JSON shape asked for in so many words on the
-- Cloudflare path — beside the fixed system prompt; a picture is kept as
-- its type and size, never its bytes. `answer` is the model's text as it
-- came and `result` what was read from it, both as sent back to the
-- client; the text columns are cut to `MAX_HISTORY_TEXT_LENGTH`
-- (src/data/ai-limits.ts). `outcome` is `ok` or the refusal's code
-- (`SUGGEST_CODES`, src/data/ai-codes.ts), with the provider's words in
-- `detail` when it failed. Kept for good: there is no retention yet.
--
-- Control-plane, like 0013, 0014, 0018 and 0019: D1 only, not part of the
-- ladder the browser store applies (src/data/corpus-schema.ts), reached
-- through `controlPlaneDriver`, never a `TenantDb`.

CREATE TABLE ai_history (
  id          INTEGER PRIMARY KEY,  -- the row's own, in order of writing
  user_id     INTEGER NOT NULL,     -- the verified GitHub id
  created_at  INTEGER NOT NULL,     -- ms epoch, when the model was asked
  duration_ms INTEGER NOT NULL,     -- from the ask to the answer or the failure
  kind        TEXT NOT NULL,        -- the use, as src/data/ai-kinds.ts names it
  provider    TEXT NOT NULL,        -- 'anthropic' or 'cloudflare'
  model       TEXT NOT NULL,
  log         TEXT,                 -- the AI Gateway log id, on the Cloudflare path
  system      TEXT NOT NULL,        -- the system prompt
  prompt      TEXT NOT NULL,        -- the user prompt, as the chosen provider was sent it
  image_type  TEXT,                 -- the picture's media type, when there was one
  image_bytes INTEGER,              -- and its size; the bytes are never kept
  answer      TEXT,                 -- the model's text as it came; null when none came
  result      TEXT,                 -- what was read from it, as JSON; null unless read
  outcome     TEXT NOT NULL,        -- 'ok', or the refusal's code
  detail      TEXT                  -- the provider's words, when it failed
);

CREATE INDEX ai_history_by_user ON ai_history (user_id, created_at);
