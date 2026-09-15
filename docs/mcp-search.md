# Search: one surface for the person and the agent

**Status: the shared query language is built; the semantic half is not.**
`search` (worker/mcp/tools.ts) now runs the app's own engine — `parseQuery` and
`searchBlocks` — over the grant's scoped graph (worker/search/engine.ts), so
`in:<note or block id>`, `type:todo,done`, `-type:done`, `sort:updated` and
free text mean over MCP exactly what they mean in the search box. The
embedding-based half sketched below was built and measured (section chunks
retrieved paraphrases 85% of the time against the fuzzy matcher's 0%) and set
aside for cost and complexity; the engine is shaped so it can slot back in as a
second candidate list. What follows is the original design, kept for that day.

---

Today the MCP endpoint has
its own substring matcher (`search`, worker/mcp/tools.ts) which shares nothing with the
app's query language (docs/query-language.md, `src/utils/search.ts`). Two search
semantics over one corpus is one too many.

## The workflow this has to serve

> Connect an agent, have it find a subtree that gives context on a specific problem, and
> research around a topic.

That is a **retrieval** problem before it is a traversal problem. The traversal half
already works — `get_block`, `list_children`, `list_parents` walk the graph fine. What is
weak is _finding the place to start_.

Substring matching cannot do it. "authentication" does not match "auth" or "login";
"deployment went wrong" does not match "the deploy broke". An agent asked to research a
topic will phrase the query in its own words, and lexical search only rewards a user who
already knows the corpus's vocabulary — which is precisely the knowledge the agent lacks.

## Why listing is not the fallback

`list_notes` used to offer a `query` filter that matched a note's title and its first
twenty words, so a term further down a note silently returned nothing: a filter that lied.
It has been removed.

Unbounded listing is not the answer either. A paginated dump of every note is low signal
for an agent, spends context, and invites it to confuse "the notes I was shown" with "the
notes that exist". Enumeration is worth keeping only in its _filtered_ forms — by type,
by date — which answer real questions ("what did I write this week?") that no semantic
query can.

## The shape

One tool, not two:

```
search(query?, type?, kind?: "notes" | "blocks" | "both", limit?, cursor?)
```

- `query` optional — omitted, it is an enumeration filtered by the structured fields.
- Returns notes and/or blocks, ranked, each hit carrying enough to decide whether to walk
  into it: the block, its note, and a **snippet around the match** rather than its whole
  text. (Today `search` returns each hit's full text, which on a broad query is a lot of
  context for no ranking.)
- Cursor-paged, which `search` currently is not.

Settle this shape first. Once it is right, swapping the matcher underneath touches one
function.

## Matching: hybrid, and in that order

**1. Lexical, properly.** Reuse the app's query language rather than reimplementing it, so
the agent and the person search the same way and a query that works in the UI works over
MCP. The cost is that `src/utils/search.ts` pulls `chrono-node` and `fast-fuzzy` into the
Worker bundle — real, but measurable and probably acceptable; the fuzzy matching is a
large part of what makes it better than substring.

**2. Semantic, on top.** Embeddings answer the "entry point" question lexical search
cannot. Cloudflare has both halves (Workers AI for embeddings, Vectorize for the index) on
the account already.

Hybrid rather than pure semantic: exact terms — a name, an id, a bit of jargon —
are where embeddings are worst and lexical is perfect. Rank by combining both.

### Keeping an index in sync, without coupling the write path

The obvious design — embed on write — is wrong here, because **MCP is not the only
writer**. The browser pushes edits through the replica (`corpusPut`), and an index that
only sees agent writes would be quietly wrong about everything the person typed.

Use the sequence instead. Migration `0005` gave every row a server-assigned `seq`,
monotonic per tenant, precisely so that "what changed since?" is a single exact query.
An indexer can then be:

```
read meta 'embed_cursor'  →  SELECT … WHERE seq > cursor  →  embed  →  upsert  →  store new cursor
```

That covers every writer by construction, needs no hook in either write path, is
restartable, and reuses machinery that already exists and is already tested. Run it on a
cron trigger, or opportunistically.

Scale makes this easy: the corpus is ~630 blocks. A full reindex is one batch; an
incremental pass is usually zero rows.

Decisions still open:

- **Granularity.** Block-level pinpoints an entry block, which is what the workflow wants;
  note-level is cheaper and more stable but too coarse to find a subtree. Probably blocks,
  skipping ones too short to carry meaning.
- **Deletes.** A tombstoned row must leave the index, or search will return blocks the
  person cannot see. The `seq` walk sees tombstones (they take a sequence value like any
  write), so this falls out — as long as the indexer acts on `deleted_at` rather than
  skipping it.
- **Scope.** Vectorize results must be filtered by tenant _and_ by the grant's note scope
  before anything is returned. Safest is to treat the index as a candidate generator only,
  then resolve every candidate through the existing scoped accessors — so the scope check
  stays in one place (`graph-access.ts`) rather than being reimplemented as a vector
  filter.
