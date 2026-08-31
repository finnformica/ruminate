# Scaling thresholds: when to stop replicating the whole corpus

Ruminate replicates a user's **entire** corpus to the device: the local
SQLite store is a full replica, not a cache. That is what makes search
instant, editing work offline, and the push queue's never-lose-work
guarantee possible (see `graph-storage.md`).

It is also the thing that eventually stops scaling. This document exists so
the decision to change it is made on a measurement rather than a feeling —
and so nobody rebuilds the sync layer while the current one is comfortable.

The successor design is **partial replication + server-side search**: the
client loads only what the current view needs, and search/filter queries the
server so it still spans the whole corpus. The two halves go together — a
server search while the client holds everything is pure added latency, and
partial loading without server search can only find what happens to be
local.

## Measured baseline (2026-08-31)

From the owner's production corpus:

| Measure                  | Value         |
| ------------------------ | ------------- |
| Blocks (nodes)           | 333           |
| Links                    | 329           |
| Node content             | 22.5 KB       |
| Link content             | 14.2 KB       |
| **Total corpus content** | **36.6 KB**   |
| Average block text       | 42 characters |

Derived density, used for every projection below: **~110 bytes of content
per block** (67 node + 43 link), which becomes **~230 bytes per block on the
wire** as JSON (field names roughly double it) and **~50 bytes gzipped**.

Note the density assumption: 42-character blocks is an outline-style corpus.
Long-form paragraph notes hit the same byte totals at far fewer blocks —
**which is why the byte thresholds below matter more than the block counts.**

## Thresholds

| Corpus                      | Initial pull (gzip) | JS heap (est.) | Search latency | Action                   |
| --------------------------- | ------------------- | -------------- | -------------- | ------------------------ |
| **< 10k blocks** (< 1 MB)   | ~0.5 MB             | < 10 MB        | < 20 ms        | Nothing. Current design. |
| **10k–50k** (1–5 MB)        | 0.5–2.5 MB          | 10–45 MB       | 20–60 ms       | Instrument only.         |
| **50k–100k** (5–11 MB)      | 2.5–5 MB            | 45–90 MB       | 60–150 ms      | Design + build window.   |
| **> 100k blocks** (> 11 MB) | > 5 MB              | > 90 MB        | > 150 ms       | Migrate.                 |

Heap estimates assume the parsed `BlockDoc` map, the block index, and the
fuzzy searcher hold roughly 8× the raw content in JS objects (string and
object headers, plus the index duplicating text). Mobile Safari starts
evicting tabs somewhere around 200–400 MB, so it — not the desktop — sets
the ceiling.

**The owner's corpus today sits at 0.3% of the migrate threshold**, i.e.
roughly 300× headroom. This is not a near-term project.

## Symptom triggers (any one of these beats the table)

Counts are a proxy; these are the actual failures. Act if:

- **Cold start** (sign-in → notes visible) exceeds **3 s** on a normal
  connection. Parsing, not transfer, is usually the culprit first.
- **Initial pull** exceeds **5 MB** gzipped.
- **Search** costs more than **100 ms** per keystroke.
- A **mobile tab reloads itself** while Ruminate is open — that is memory
  eviction, and it is the hard stop regardless of what the table says.
- **OPFS** growth becomes a problem (unlikely; the quota is far larger than
  the other limits).

## Instrument before migrating

The trigger should fire from data. Before any of this is built, add to the
Settings → Storage diagnostics panel:

- corpus size in blocks **and** content bytes (the store already counts rows;
  bytes is a `SUM(LENGTH(...))` away),
- last initial-pull payload size and duration,
- time from store-open to first render,
- `performance.memory.usedJSHeapSize` where the browser exposes it.

Watching those over a few months makes the migration decision obvious rather
than speculative.

## What the migration would involve

Recorded here so the size of the job is not a surprise. It is a bigger change
than it looks, because the current sync protocol assumes a full replica:

- **Working set definition** — what "relevant to the view" means (open note,
  recents, pinned, search results?) and how it is evicted.
- **Sync protocol rework** — deletion-by-absence sends the complete id list
  and the client deletes what is missing; that is incoherent when the client
  is meant to hold a subset. Soft deletes (tombstones) already remove the
  need for those lists, which is why they are a prerequisite worth having
  first.
- **Offline behavior** — currently everything works offline. Afterwards only
  the working set does. Writes should stay local-first for loaded notes so
  the never-lose-work guarantee survives for what you are actually editing.
- **Server-side search** — indexed SQL (`nodes.type` is already indexed) plus
  FTS5 for text, tenant-scoped, returning the same hit shape the client
  renders today. The search UI is built behind a data-source interface for
  exactly this swap.
- **Search when offline** — degrade to the working set, and say so.

## Related

- `graph-storage.md` — the current replication and sync design.
- `event-sourcing-design.md` — the op log makes pulls O(changes) rather than
  O(corpus), which raises these thresholds without abandoning full
  replication. Worth weighing before committing to partial replication.
