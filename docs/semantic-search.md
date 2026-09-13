# Hybrid search

One search, two matchers, two callers. The person's query language
(docs/query-language.md) parses into structured filters plus free text; the
filters filter, and the free text goes to a fuzzy matcher **and** to an
embedding index. What comes back is ranked by both and resolved through the
same scoped accessors every other read goes through.

|                 |                                                                   |
| --------------- | ----------------------------------------------------------------- |
| MCP tool        | `search` (docs/mcp-server.md §2)                                  |
| HTTP            | `GET /api/search?q=…`, `POST /api/search/index`                   |
| Implementation  | `worker/search/engine.ts` — one ranker, no per-caller copy        |
| Embedding model | `@cf/baai/bge-m3`, 1,024 dimensions                               |
| Index           | Vectorize `ruminate-blocks`, cosine, one **namespace per tenant** |
| Kept in sync by | the `seq` cursor (migration 0005), not by either write path       |

---

## 1. The question that had to be answered first

**What do you embed, in a corpus with no documents in it?**

This is an outliner. Measured on production: **634 blocks, 25,847 characters,
longest block 175 characters** — a mean of about 41, roughly eight words.
Embedding an eight-word fragment on its own may retrieve nothing useful, and if
it does not, no amount of good plumbing downstream saves it.

So it was measured before anything was built.
`scripts/chunking-experiment.ts` builds a 521-block fixture of the same shape
(42 notes, mean 38 characters, longest 169 — deliberately near production's
count, because a 60-block toy corpus flatters any retriever) and 54 queries with
known target blocks. Two thirds are **paraphrases** sharing no meaningful word
with their target — the case embeddings exist for. The rest **name the thing**:
jargon, a number, a proper noun — the case embeddings are worst at. Reporting
only the first group would have rigged the answer.

| strategy                           | hit@1 | hit@5 |  MRR | blocks read | paraphrase hit@5 | exact-term hit@5 |
| ---------------------------------- | ----: | ----: | ---: | ----------: | ---------------: | ---------------: |
| bare block text                    |   44% |   61% | 0.53 |         3.9 |              54% |             100% |
| block + its note's title           |   56% |   67% | 0.61 |         4.1 |              61% |             100% |
| **section** (heading + subtree)    |   65% |   87% | 0.74 |        10.1 |              85% |             100% |
| lexical (`fast-fuzzy`, as shipped) |    7% |    7% | 0.07 |         1.0 |               0% |              50% |
| lexical + section (**what ships**) |   67% |   87% | 0.75 |         9.6 |              85% |             100% |

Three findings, in order of how much they changed the design:

**Bare blocks do not retrieve acceptably.** 54% on paraphrases is a coin toss.
Simpler would have been better and it is not available: the honest reading of
54% is that half the time the agent is told the corpus does not contain
something it does contain, which is the one failure mode a retrieval tool
cannot have.

**A section is a large win — 85% against 54%.** The unit that works is a
heading plus everything under it until the next heading. It has enough words to
mean something ("Cold retard overnight gives the open crumb" retrieves for "how
do I get big holes in the crumb"; "Do not cut it hot" does not, and is in the
same section), and it is also **what the workflow asks for** — an agent wants
"the subtree that gives context on this problem" (docs/mcp-search.md), which is
a section, not a bullet. It costs about 10 blocks read to reach the target
rather than 4, which at 41 characters a block is around 400 characters of
context. That is the trade, and it is cheap.

**The note's title in front of a block helps a little (54% → 61%) and does not
close the gap.** It is kept, because a section chunk leads with it and it costs
nothing — `notes_id` is a single stable value set once at creation. It is
**not** an ancestor path, and no ancestor path is embedded: this is a graph, a
block is reachable by many paths, and there is no single "the" path to store.

**The lexical half contributed no wins on this fixture, and stays anyway.** A
surprise worth stating plainly: `bge-m3` ranked every exactly-named query first
too, so fusion never needed rescuing. `fast-fuzzy` at the app's own threshold
matches a whole query string against a whole block, which a multi-word
paraphrase never does — hence 0% on paraphrases and 7% overall. It stays in the
ranker because it is free, deterministic, needs no network, and is the half
that keeps working when a binding is missing. It does not stay because it wins.

**Is semantic search worth it here?** Yes, and the margin is not subtle: 85%
against 0% on the queries an agent actually asks. The thing that makes it worth
it is the chunk, not the model.

---

## 2. What gets indexed

`src/utils/search-chunks.ts`, a pure function over the note's own document-order
walk (`indexNoteBlocks` — the same walk the block results are drawn from).

- A new chunk starts at **every heading**, and at whatever block overflows
  1,500 characters. Blocks before the first heading are their own chunk.
- Every chunk leads with the **note's display name**.
- A note is at most **64 chunks** (`MAX_CHUNKS_PER_NOTE`). That is not a size
  limit, it is the **delete window** — see §4.

The index stores **no text and no metadata**. A vector's id is
`<tenant>:<noteId>#<ordinal>` and that is all of it. Everything a hit
contains — the block, its type, its note, the heading it sits under — is
resolved out of the graph at query time. Two things follow:

1. **There is no second copy of the corpus to keep in step**, and no second
   place a note-scope check could be got wrong.
2. Vectorize's `topK` caps at 50 **with** metadata and 100 without, so the
   higher cap applies.

---

## 3. How a query runs

```
parseQuery(q)  →  { filters, fuzzy, sorts }

  filters  →  searchBlocks(filters, fuzzy: "")     the admitted set
  fuzzy    →  searchBlocks(filters, fuzzy)         the lexical ranking
           →  embed → Vectorize.query(namespace)   chunk ids
              → sectionChunks(note)                → block ids
              → the scoped BlockIndex              → hits

  fuse(lexical, semantic) by reciprocal rank  →  sorts  →  page
```

**The filters are not semantic.** `tag:work`, `type:todo`, `in:"Reading list"`,
`-tag:x`, `has:`/`no:`, a property key — each has to mean the same thing
whichever half proposed the block, so there is exactly one statement of what
they mean (`searchBlocks` with an empty fuzzy string) and both halves are
intersected with its answer. A query with no free text at all is an
enumeration of what the filters admit, which is what the query language already
says it is.

**Merging is by rank, not by score.** There is no scale on which a cosine
similarity and a fuzzy-match score are comparable, and every attempt to invent
one is a weighting in disguise. Reciprocal-rank fusion (k = 60) needs only each
half's ordering, so neither half can dominate by having bigger numbers.

**Vectorize returns candidates, never answers.** Every candidate is resolved
through `graph-access.ts`'s scoped accessors. A note-scoped grant is not
protected by a metadata filter on the vector query — it is protected by the
fact that a note it cannot see is not in the index the candidates resolve
through, so those candidates evaporate. A filter is something you can forget.

---

## 4. Keeping it in sync, off `seq`

**Not on the write path.** MCP is not the only writer: the browser pushes
through the replica (`corpusPut`), an agent writes through
`applyOpsToReplica`. An index hooked into either would be quietly and
permanently wrong about everything the other did — quietly, because a missing
vector looks exactly like a block that did not match.

Migration 0005 gave every row a server-assigned per-tenant `seq` so that "what
changed since?" is one exact query, and the replica's incremental pull has been
running on it in production since 2026-09-09. The indexer
(`worker/search/sync.ts`) reuses it:

```
read meta 'embed_cursor'
  →  SELECT … WHERE seq > cursor        two index seeks
  →  the notes those rows touch
  →  re-chunk, embed, upsert
  →  delete ordinals [chunks.length, 64)
  →  store the new cursor
```

- **Covers every writer**, by construction.
- **Restartable.** The cursor moves only once everything before it is indexed,
  and every operation is idempotent.
- **Tombstones travel through it** — a delete takes a `seq` like any other
  write — _provided the indexer acts on `deleted_at` rather than skipping it_.
  It does: the changed-row reads are `includingDeleted` reads, and a note whose
  row is tombstoned has all of its vectors removed rather than merely not
  refreshed.
- **A shrinking note leaves nothing behind.** Re-indexing upserts chunks
  `0…n-1` and deletes `n…63`. That fixed window is why the indexer does not
  have to remember how many chunks a note used to have — which would be state
  to keep correct, in a place where being wrong is invisible.

**Cost of a pass.** Nothing changed: two index seeks, no snapshot, no embedding
call, no Vectorize call. Anything changed: one whole-corpus load. That is
deliberate, and not a lapse in the bounded-read discipline of
docs/mcp-server.md §4 — "which notes does this changed block appear in?" is a
question about the whole graph, and the corpus is ~1,700 rows.

**It runs when it is asked to.** `POST /api/search/index`, session-authed.
There is deliberately no cron trigger in `wrangler.jsonc`: embedding a corpus
is an operator's decision the first time, and a cron entry would make it happen
on the next deploy, silently. Adding `"triggers": { "crons": [...] }` is one
line, the day that decision is made.

**A pass is not visible the moment it returns.** Vectorize mutations are
asynchronous: measured against the real index, an upsert took about **28
seconds** to become queryable. So the pass returns, the cursor has moved, and
for the next half-minute a search does not see the change. That is fine for
what this is — a candidate generator over a corpus that changes a few blocks at
a time, with the lexical half unaffected and answering from the graph
immediately — but it is worth knowing before wondering why a freshly indexed
note "did not work". It also means the cursor is not a promise about the index,
only about what has been SENT to it; a pass that dies after upserting and
before storing the cursor repeats harmless upserts, which is the direction that
was chosen deliberately.

### Running the first index

Nothing in this repository has embedded a real note. The fixture in
`scripts/chunking-fixture.ts` is invented, and the experiment runs on that
alone: production holds three tenants' private notes, and putting them through
an embedding model is an operator's decision, not a build step's.

When that decision is made, after a deploy, from the browser console of the
signed-in app:

```js
// A fresh access token from the HttpOnly refresh cookie, then one pass.
const { token } = await (
  await fetch("/github-refresh", { method: "POST", credentials: "same-origin" })
).json()
await (
  await fetch("/api/search/index", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  })
).json()
```

It answers with the pass's report — `{ from, to, changedRows, notesIndexed,
notesRemoved, chunksUpserted, vectorsDeleted }`. The first pass has `from: 0`
and indexes everything; run it again a minute later and it should report
`changedRows: 0`. Each tenant indexes their own corpus by running it
themselves; there is no cross-tenant pass, because there is no handle that
could do one.

`POST /api/search/index?reset=1` moves the cursor back to zero first — for the
changes an incremental pass cannot see because nothing about the rows changed:
a different model, a different chunker, a different index.

To undo the whole thing: `npx wrangler vectorize delete ruminate-blocks`.

---

## 5. One namespace per tenant

Every vector is written and queried under a namespace that is the tenant's user
id, and the store is minted from a `TenantDb` — there is **no parameter for a
namespace**, exactly as there is no parameter for a user id on `TenantDb`
itself. A query in one partition is structurally unable to reach another's
vectors. The free plan allows 1,000 namespaces per index; there are three
tenants.

The ids carry the tenant too, and that is the other half of the same wall
rather than belt and braces: `deleteByIds` takes ids and **no namespace**, so a
shared id space would let one tenant's indexer delete another's vectors if two
note ids ever collided. Prefixing makes that impossible rather than unlikely.

**Metadata filtering was the alternative and was rejected.** It is a filter
someone can forget; a namespace is a different partition.

---

## 6. Cost, measured

Workers AI free allowance is **10,000 neurons a day**; Vectorize's is **5
million stored dimensions**. Measured on the 521-block fixture, scaled to
production's 634 blocks / 25,847 characters:

|                     | fixture (521 blocks) | production (634 blocks, estimated) |  of the free allowance |
| ------------------- | -------------------: | ---------------------------------: | ---------------------: |
| chunks              |                  125 |                               ~155 |                      — |
| full index, tokens  |               10,225 |                            ~13,400 |                      — |
| full index, neurons |            **10.99** |                            **~14** |       0.14% of one day |
| one query, neurons  |           **0.0127** |                             0.0127 | ~787,000 queries a day |
| stored dimensions   |              128,000 |                           ~160,000 |                   3.2% |

A full rebuild of the whole corpus costs about a seventh of one percent of a
day's free neurons. At 1,024 dimensions the 5M allowance is ~4,880 chunks,
which at this corpus's density is around 24,000 blocks — about 38 times what is
there.

Indexing bare blocks instead would have cost 15.03 neurons and **533,504**
stored dimensions for a worse answer: a section index is four times smaller as
well as better, because the text is embedded once instead of once per block.

### Worker bundle

Sharing the app's query language pulls `chrono-node` (relative dates in
`date:`) and `fast-fuzzy` (the fuzzy matcher) into the Worker. Measured with
`npx wrangler deploy --dry-run`:

|                     |         raw |            gzipped |
| ------------------- | ----------: | -----------------: |
| before              |     230,244 |             55,106 |
| after               |     405,234 |             93,933 |
| before, minified    |     125,399 |             40,765 |
| after, minified     |     209,708 |             69,657 |
| **delta, minified** | **+84,309** | **+28,892 (+71%)** |

Of that delta the two libraries are 64,192 raw / 22,144 gzipped when bundled
alone (`import * as` form, minified: chrono-node 45,250 / 13,056, fast-fuzzy
18,887 / 9,072); the remaining ~6.7 KB gzipped is this feature's own code and
the app modules it reaches. docs/mcp-search.md called this cost "real, but
measurable and probably acceptable" before it was measured. It is real: a 71%
increase on a bundle deliberately kept small. It is paid for one thing — that a
query which works in the app works over MCP, and that `tag:`, `type:` and `in:`
are not reimplemented a second time.

---

## 7. What is deliberately not here

**The app's UI does not call this.** The endpoint exists; nothing in `src/`
fetches it. The app's search today makes zero network calls and works offline,
so calling this would make search an online-only escalation — and what should
happen to a person typing with no connection is a product question with more
than one defensible answer (fall back to local fuzzy silently? say so? escalate
only on an explicit gesture?). Shipping the endpoint without answering it is
the point; answering it by accident is what is being avoided.

**`list_notes` is untouched.** Folding it into `search` is intended eventually
(docs/mcp-search.md) and is not this change.

**No reranker.** `@cf/baai/bge-reranker-base` would likely lift the 65% hit@1,
and it is a second model call per query on a corpus where the top five is
already 87%.

---

## 8. Files

|                                  |                                                      |
| -------------------------------- | ---------------------------------------------------- |
| `src/utils/search-chunks.ts`     | What gets embedded — pure, and the whole decision    |
| `worker/search/engine.ts`        | The one ranker: filters, both halves, fusion, paging |
| `worker/search/vector-index.ts`  | Workers AI + Vectorize, and the tenant wall          |
| `worker/search/sync.ts`          | The `seq`-driven indexer                             |
| `worker/handlers/search.ts`      | `GET /api/search`, `POST /api/search/index`          |
| `worker/mcp/tools.ts`            | The `search` tool, a thin caller of the engine       |
| `scripts/chunking-experiment.ts` | The experiment behind §1                             |
| `scripts/chunking-fixture.ts`    | Its corpus and queries — invented, never production  |
