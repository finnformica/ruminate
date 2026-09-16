-- Migration number: 0013    2026-09-15
--
-- Feature flags: the admin's switchboard for beta and experimental features.
--
-- A row names a feature (a key the code knows — src/data/feature-flags.ts is
-- the registry) and the AUDIENCE it is on for: `off` (nobody), `admin` (the
-- bootstrap owner only) or `everyone`. A feature with no row is at its code
-- default. The Worker enforces the audience on the feature's routes
-- (worker/features.ts); the client reads the effective set (`GET
-- /api/features`) to know what to show. The admin sets the rows from the
-- admin page (`PUT /api/admin/features/<key>`).
--
-- Control-plane, like 0003, 0007 and 0012: D1 only, not part of the ladder
-- the browser store applies (src/data/corpus-schema.ts), reached through
-- `controlPlaneDriver`, never a `TenantDb`.

CREATE TABLE feature_flags (
  key        TEXT PRIMARY KEY,    -- the feature, as src/data/feature-flags.ts names it
  audience   TEXT NOT NULL CHECK (audience IN ('off', 'admin', 'everyone')),
  updated_at INTEGER NOT NULL,    -- ms epoch
  updated_by INTEGER NOT NULL     -- the admin's verified GitHub id
);
