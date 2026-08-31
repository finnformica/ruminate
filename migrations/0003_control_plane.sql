-- Migration number: 0003    2026-08-31
--
-- Multi-tenancy control plane (docs/multi-tenant-design.md §3).
--
-- The D1 database stops being THE corpus and becomes the control plane:
-- identity and signup gating. Each user's corpus lives in their `UserCorpus`
-- Durable Object (worker/corpus-do.ts), addressed by the verified GitHub id.
-- The v2 corpus tables (nodes/link/meta) are deliberately left in place —
-- they hold tenant #1's pre-multi-tenant rows until the DO migration
-- (POST /api/admin/migrate-corpus, or the lazy owner fallback) has soaked;
-- dropping them is §6 step 6, much later and manual.
--
-- Unlike 0001/0002 this file is D1-only: it is NOT part of the corpus ladder
-- the local store and the DO apply (src/data/corpus-schema.ts).

CREATE TABLE users (
  github_id  INTEGER PRIMARY KEY,             -- the tenant key (verified GitHub id)
  login      TEXT NOT NULL,                   -- display/debug only, never an address
  name       TEXT,
  status     TEXT NOT NULL DEFAULT 'active',  -- 'active' | 'blocked'
  created_at INTEGER NOT NULL,                -- ms epoch
  created_by TEXT NOT NULL DEFAULT 'signup',  -- 'signup' | 'allowlist' | 'admin'
  last_seen_at INTEGER
);

CREATE TABLE allowlist (
  github_id INTEGER PRIMARY KEY,  -- pre-approved ids while signups are gated
  note TEXT
);

-- Seed with the standing owner: ALLOWED_GITHUB_ID's value (wrangler.jsonc),
-- which retires into this row. The var itself stays configured as the
-- fail-closed bootstrap (worker/handlers/tenancy.ts treats it as an implicit
-- allowlist entry), so this seed and the var can never disagree about the
-- owner getting in.
INSERT INTO allowlist (github_id, note) VALUES (42536816, 'owner — seeded by 0003_control_plane');
