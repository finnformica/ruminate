-- Migration number: 0033    2026-11-02
--
-- The first screen a new device asks for (`GET /api/replica/first-screen`,
-- docs/events-log-cache.md, "Sync is the log") holds the pinned nodes, read
-- by their `props.pinned_at` key as the device's own ladder reads them
-- (`events_log_cache_pinned`, src/data/corpus-schema.ts). Without this index
-- that read scans the tenant's whole partition; with it, a seek. The other
-- partial lookup indexes are 0032's.
CREATE INDEX events_log_cache_pinned ON events_log_cache (user_id, value)
  WHERE key = 'props.pinned_at';
