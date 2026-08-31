# Page identity: minted ids vs title-keyed pages

Status: **design only** (2026-08-31). Extends
[graph-schema-v2.md](./graph-schema-v2.md) and
[graph-storage.md](./graph-storage.md); mirrors the migration discipline of
[multi-tenant-design.md](./multi-tenant-design.md) §6. Nothing here is
implemented.

The finding, verbatim: _"the pages do not have their own id and just use the
text of the page name."_

## 1. Today: one string is five things

A note's title-derived name is simultaneously:

1. **The note id / filename stem.** `notesAtom` derives the id from the
   `<id>.md` key of `markdownFilesAtom` (`src/global-state.ts:241-244`), which
   `src/data/database-mode.ts:169` synthesizes as `` `${id}.md` `` per page.
2. **The route param.** `/notes/$` reads the splat as the note id
   (`src/routes/_appRoot.notes_.$.tsx:88`) and renders `` `${noteId}.md` `` as
   the window title (`:304`).
3. **The page node's id in the graph — and its text.** Ingest writes the page
   row as `{ id: noteId, text: noteId }` (`src/data/graph.ts:131-138`); the
   "title" column literally stores the id.
4. **The wikilink target.** `[[name]]` parses to `node.data.id`
   (`src/remark-plugins/wikilink.ts:219-254`), `parseNote` collects it into
   `note.links` (`src/utils/parse-note.ts:64-66`), and `NoteLink` navigates
   `params={{ _splat: id }}` (`src/components/note-link.tsx:36-40`).
5. **The visible title.** `NoteTitle` edits the id itself
   (`src/components/block-editor/note-title.tsx:19-50`, mounted at
   `_appRoot.notes_.$.tsx:383-391`), and `displayName` falls back to the id
   when there is no `# ` heading (`src/utils/parse-note.ts:216-224`).

Renaming is therefore id surgery. `useRenameNote` (`src/hooks/note.ts:69-128`)
validates the new name against the filename charset
(`src/utils/note-id.ts:1`), rejects duplicates (`note.ts:88-91`), regex-rewrites
`[[old]]` in **every other note** (`note.ts:97-108` via
`src/utils/update-wikilinks.ts`), writes the content under the new id, and
deletes the old id (`note.ts:110-118`). Downstream of that one gesture:

- The store deletes one page node and ingests another
  (`src/data/sql-note-store.ts:462-527`); block rows survive only because they
  keep their `blk_` ids and get relinked before the old page is deleted.
- Every note containing the link pushes changed rows to the replica — and each
  rewrite bumps `updated_at` on block rows the user never touched, which under
  per-row LWW can clobber a concurrent edit to that block on another device.
- The URL changes (`_appRoot.notes_.$.tsx:281-288` navigates after rename), so
  every old deep link breaks — worse than a 404: visiting the old id shows a
  blank new-note editor, and typing there **mints a duplicate note under the
  dead name** (the guard at `:136` only covers the same session).
- `collapse:<noteId>` localStorage overrides orphan
  (`src/data/view-state.ts:25`).
- Titles are forced unique and confined to the filename charset — no `:`,
  `?`, `#`, `[`, `|` … (`NOTE_ID_REGEX`, `src/utils/note-id.ts:1`).

Two facts make this cheaper to fix than it looks. New notes already mint
opaque ids — `generateNoteId()` is `Date.now().toString()`
(`src/utils/note-id.ts:8-10`, used by `src/hooks/create-new-note.ts:30`,
`src/components/nav-bar.tsx:58`, `src/components/markdown.tsx:686`) — and
`displayName` already has a no-title ladder for them
(`parse-note.ts:216-235`), so "id is opaque, title is data" is half-true
today. And the replica wire format is id-agnostic rows
(`worker/handlers/replica-payload.ts` `NodeRow`/`LinkRow`;
`worker/handlers/replica-corpus.ts:40-48`), so nothing server-side cares what
a page id looks like.

## 2. Options

### (a) Full minted ids — recommended

Pages get minted `pg_` ids (sibling discipline to `blk_`). The title becomes
the page node's `text` — real, mutable data. URLs are id-keyed
(`/notes/pg_…`); name-shaped URLs keep resolving (§3). Wikilinks stay
**name-keyed in authored text** and resolve name→id at read time (§3).

- Rename = update one node row's `text`. No corpus rewrite, no URL change, no
  navigation, no replica churn beyond one row. References and deep links are
  stable by construction.
- Titles escape the filename charset and (structurally) the uniqueness
  constraint.
- This is the discipline graph-schema-v2.md already committed to for the
  semantic-types future: _"stable key minted once, display name renameable"_
  (`docs/graph-schema-v2.md:228-232`). And the reserved op log
  (event-sourcing-design.md, via `graph-schema-v2.md:19-21`: each node is an
  aggregate) needs stable aggregate ids — rename-as-delete+create would
  shatter a page's event history.
- Cost: a read-time name-resolution layer, a data migration, and id-shaped
  URLs for hand-typed navigation (mitigated by name-URL resolution).

**Carve-out: daily/weekly pages keep their date ids.** `2026-08-31` and
`2026-W35` are natural keys — the date _is_ the identity and never renames.
Date detection by id (`_appRoot.notes_.$.tsx:106-112`,
`note-link.tsx:25-31`, `parse-note.ts:194-198`), calendar navigation, and
task-date derivation from `[[date]]` links all keep working untouched. Rule:
mint for renameable things; use the natural key where name = identity.

### (b) Minted ids internally, slug-aliased URLs

Same as (a) plus a slug per page (`/notes/flow-engineering`) with a slug
table and redirects. Rejected: it buys prettier URLs at the cost of a second
name system (slug uniqueness, regeneration-on-rename, redirect chains) — and
this app's URLs are already opaque for every freshly created note
(timestamp ids). Public sharing goes through gists, not app URLs. If pretty
URLs ever matter, (b) is an additive layer on top of (a), so nothing is
foreclosed by skipping it.

### (c) Status quo + rename-as-migration tooling — the cheap rival

Keep title ids. On rename, record `old → new` in a small alias map (a `meta`
JSON key or a two-column table) and teach the route + wikilink resolution to
follow it. Fixes the two user-visible wounds — broken old URLs and the
blank-editor resurrection hazard — for roughly a day's work and zero data
migration. Keeps everything else: corpus-wide rewrites with their LWW
clobber risk, forced-unique charset-limited titles, page-node delete+create
per rename, alias chains that grow forever. Honest assessment in §5.

**Recommendation: (a).** The blocks-first cutover already made the store and
wire id-agnostic, so the price is at its lifetime minimum (the same "before
production data" logic that justified schema v2 — there is one tenant and a
re-seedable corpus). Every planned layer — the op log, semantic types —
keys off stable node ids; (c) would be rework, not a step.

## 3. Wikilink semantics — the crux

Wikilinks are deliberately **name-keyed**: `[[some future note]]` renders as
a valid link before the note exists (`NoteLink` renders `{text || id}` with
`useNoteById` returning undefined, `note-link.tsx:23-49`), and that dangling
state is a feature, not an error. Minted ids must not take it away. Design:

**Resolution timing: read time, in memory.** A derived `pageIndexAtom` maps
name → page id, built from page nodes the same way backlinks are derived
today (in-memory over the corpus, `global-state.ts:249-284`), containing:

1. date/week literals (identity mapping — they are their own ids),
2. every live page title (the page node's `text`),
3. every alias (`props.aliases`, see rename below) — most recent rename wins
   ties among aliases.

Precedence is that order: a live title always beats an alias (a new page
titled "old name" captures links written for it — the author's visible intent
is the current title namespace). Lookup is exact-match, case-sensitive, as
today. Consumers: `NoteLink` navigation, the `/notes/$` route (name-shaped
splats resolve to the page, then `history.replaceState` to the canonical id
URL), backlink derivation (`notesAtom`/`backlinksIndexAtom` resolve
`note.links` names through the index before matching), and the `link:` /
`backlink:` search qualifiers (`src/utils/search-notes.ts:42-56`), which
compare raw strings today and must compare resolved ids.

**Rename behavior: resolve via alias — do not rewrite authored text.** On
rename, the old title is appended to the page's `props.aliases` and the node's
`text` becomes the new title. Existing `[[old name]]` occurrences are left
byte-for-byte and keep resolving through the alias. Why this over today's
rewrite:

- **Never-lose-work.** The user's authored bytes are never mutated behind
  their back; nothing they wrote can be damaged by someone else's rename
  gesture, and a link they wrote yesterday means the same page tomorrow.
- **LWW safety.** Corpus-wide rewrites bump `updated_at` on rows the user
  never edited; under per-row LWW that can silently clobber a concurrent
  same-block edit on another device. An alias touches one row.
- Rename becomes O(1) instead of O(corpus).

The renderer may display the current title for an alias-resolved link (the
`[[old name]]` text swapped visually, never in storage) — same philosophy as
the `alias` frontmatter that already exists (`src/schema.ts:36-37`). A
user-invoked "update links to new title" tidy action can offer the rewrite
explicitly — visible and chosen, not automatic. Dangling behavior is
unchanged: a name matching neither title nor alias renders as today, and the
first save of that name mints a `pg_` id with the name as its title.

**Collisions.** With titles as data, uniqueness is no longer structural: two
devices can rename two pages to the same title and LWW will happily merge
both. Decision: keep uniqueness as an **authoring-time check** (the same
duplicate rejection the title editor shows today, `note.ts:88-91` /
`_appRoot.notes_.$.tsx:272-274`), and make sync-produced duplicates
non-destructive: resolution tiebreak is the lexicographically smallest page
id (mirroring the `findCrossNoteIdCollisions` convention,
`src/data/graph.ts:361-390`), and a Settings diagnostic lists duplicate
titles and shadowed aliases. Nothing is auto-renamed, nothing breaks — one
page temporarily wins the name, deterministically, until the user retitles.

## 4. Blast radius inventory

| Surface                   | Where                                                                                                                         | Change under (a)                                                                                                                                                                                                                                                                                                              |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Route / deep links        | `_appRoot.notes_.$.tsx:88,304`; `?heading=`/`?block=` params `:43-47`                                                         | Splat accepts id or name (name resolves + canonicalizes). `?block=` (`blk_` ids) and `?heading=` (text) untouched.                                                                                                                                                                                                            |
| Rename flow               | `note.ts:69-128`, `update-wikilinks.ts`, `_appRoot.notes_.$.tsx:246-290`, `note-title.tsx`                                    | `useRenameNote` shrinks to a title-set (+ alias append); post-rename `navigate` deleted — the URL never changes. `updateWikilinks` retires.                                                                                                                                                                                   |
| Files seam                | `markdownFilesAtom` (`global-state.ts:218-220,241-244`), `database-mode.ts:169,177,187-188,340`                               | Keys become `<pg id>.md`. The title travels as a projection-owned `title:` frontmatter key: the rollup injects it, `docToGraphParts` lifts it back into node `text`, `parseNote` prefers it over the first `# ` heading (`parse-note.ts:48-58`). The one-atom markdown seam survives intact — and exports carry their titles. |
| Note search               | `noteSearcherAtom` keys incl. `note.id` (`global-state.ts:322-328`); `id:`/`title:`/`link:` filters (`search-notes.ts:21-45`) | `note.id` drops out of fuzzy keys (opaque); `title`/`displayName`/`alias` carry it. `link:`/`backlink:` filters compare resolved ids (§3). Backlink queries built as `` `link:"${noteId}"` `` (`_appRoot.notes_.$.tsx:118,429`) keep working — they already pass the id.                                                      |
| Block search              | hits carry `noteId` (`src/utils/block-search.ts:125-132`)                                                                     | Unchanged — ids flow through to navigation; display uses the note's `displayName` as it does now.                                                                                                                                                                                                                             |
| Gist publishing           | filename `` `${note.id}.md` `` (`src/utils/gist.ts:25`); share route parses the filename stem (`share.$gistId.tsx:47-50`)     | Filename becomes a slugged title (readable), falling back to the id. The share route already accepts any `.md` filename; existing gists unaffected (external copies).                                                                                                                                                         |
| Replica wire format       | `replica-payload.ts`, `replica-corpus.ts`                                                                                     | **No change.** Page rows are ordinary `NodeRow`s; `pg_` is just a TEXT id. `status`'s `type='page'` counts (`replica-corpus.ts:100-115`) untouched.                                                                                                                                                                           |
| Owner/admin endpoints     | `worker/handlers/admin.ts:31` (migrate-corpus), tenancy                                                                       | **No change** — row copies are id-agnostic.                                                                                                                                                                                                                                                                                   |
| localStorage              | `collapse:<noteId>` (`view-state.ts:25`)                                                                                      | Old keys orphan; collapse state is disposable by design (`view-state.ts:6-12`) — accept fallback to defaults, no rekey machinery. Per-note editor width lives in frontmatter (`_appRoot.notes_.$.tsx:229-241`), so it travels with the page; the panel-layout storage (`app-layout.tsx:23-27`) is not note-keyed.             |
| Page-id reservation guard | `graph.ts:96-113`, `sql-note-store.ts:466-471`                                                                                | Simplified: `pg_` vs `blk_` prefixes make page/block collisions structurally impossible; the reserved-set plumbing can eventually retire.                                                                                                                                                                                     |
| Templates / calendar      | `templatesAtom` keys (`global-state.ts:399-422`); daily/weekly detection                                                      | Templates key off page ids transparently; date pages are exempt from minting (§2), so the calendar and task-date links are untouched.                                                                                                                                                                                         |

## 5. Migration path

Mirror multi-tenant-design.md §6: every step deploys alone and reverses
alone. Compose with the in-flight data-quality bundle: that branch introduces
a per-tenant `data_version` meta key with a transform ladder run inside the
DO and the local store (beside the shared schema ladder,
`src/data/corpus-schema.ts`); this migration registers as **version 2** of
that ladder.

1. **Resolution layer, dark (additive).** Ship `pageIndexAtom`, name-accepting
   route resolution, and resolved-id backlinks. With title == id everywhere,
   resolution is the identity function — behavior is unchanged, but the code
   path is live and tested. _Revert: remove it._
2. **Projection title key (additive).** Rollup emits `title:`; ingest lifts
   it; `parseNote` prefers it. For existing pages the emitted title equals the
   id, so rollup-equivalence holds trivially. _Revert: stop emitting._
3. **The transform (data_version 2), DO-first.** Minting is random, so the two
   stores cannot independently agree on ids — **the DO is the only minter.**
   In one transaction per tenant: for each `type='page'` node whose id is not
   a date/week literal and not already `pg_`-prefixed — mint `pg_<fresh>`;
   insert the new node row with `text` = the old id (the name becomes the
   title) and `props` carried over; repoint every `link` row
   (`source_id`/`destination_id`); delete the old row; stamp fresh
   `updated_at` on every touched row; set `data_version = 2`. Wikilink texts
   are **not** touched — they are names, and names resolve (§3).
4. **Client adoption by version fence.** The status/pull responses carry
   `data_version`; pushes carry the client's. A mismatched push is refused
   (409) — the client then full-pulls (the existing
   `isReplicaDrasticallyBehind`-style repair posture), re-keys any unsent
   note-level edits through name→id resolution, and re-pushes. The window is
   the push debounce plus offline time, already bounded by the keepalive
   flush (docs/graph-storage.md, replication section). A local store that
   boots on `data_version 1` never transforms itself: it wipes and
   full-pulls.
5. **URL backward compatibility, permanent.** Name-shaped `/notes/<name>`
   URLs resolve through the index forever (titles first, aliases second) —
   old bookmarks, old gists' back-references, and browser history keep
   working with zero stored redirect data for the migration itself, because
   step 3 made every old id a current title.
6. **Reversibility.** While every title is still unique and matches
   `NOTE_ID_REGEX`, the inverse transform (`id := text`) restores the old
   world exactly — that window closes as users adopt rich or duplicate
   titles, and the doc should say so at flip time. Hard fallback: the DO's
   30-day point-in-time recovery
   (multi-tenant-design.md, SqlStorage bookmarks). The local store is a
   replica; it is never the thing being recovered.

## 6. Honest counter-case

What actually hurts today, ranked: (1) an old URL to a renamed note silently
becomes a blank editor that can resurrect a duplicate note; (2) rename
rewrites the whole corpus and can clobber concurrent edits under LWW;
(3) titles are forced unique and charset-limited. Rename frequency in a
single-tenant corpus of four notes is low; nobody has lost data to this yet.

The cheapest partial — option (c): keep title ids, add an alias map written
on rename (old → current id, flattened transitively), resolve it in the route
and in `NoteLink`, and stop the blank-editor resurrection by redirecting.
No data migration, no wire change, one small table or `meta` key. **It is
enough** for as long as: the op log stays reserved (no aggregate-identity
pressure), semantic types stay unbuilt, and title richness (colons,
duplicates) stays a nice-to-have. It does not remove the corpus-rewrite on
rename or its LWW hazard — the rewrite must stay, because without minted
ids the name in other notes' text _is_ the reference.

The honest trigger for (a) is therefore not rename frequency — it is the
first feature that needs a page to be an **aggregate**: the event-sourcing
layer (each node an aggregate, `graph-schema-v2.md:19-21`), or the
semantic-types layer whose minting discipline the schema doc already adopted
(`graph-schema-v2.md:228-232`). Build (a) as the step _before_ whichever of
those lands first; if neither is imminent and the URL hazard needs fixing
now, do (c)'s alias map as a stopgap — it is an afternoon, and its
resolution code is step 1 of (a) anyway.

## 7. Open items

- Exact-match vs case-insensitive name resolution (today is case-sensitive;
  changing it is a UX call, not an architecture one).
- Whether the tidy action ("update links to new title") ships with v2 or
  later.
- Slug format for gist filenames (readable title-slug vs raw `pg_` id).
- Whether `props.aliases` folds into the user-visible `alias` frontmatter
  (one alias concept, not two) — leaning yes: rename appends to the same
  list the user can already edit.
