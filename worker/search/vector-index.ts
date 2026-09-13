// The two Cloudflare-shaped things in this feature, and nothing else knows
// they exist: Workers AI turns text into a vector, Vectorize remembers which
// chunk a vector came from (docs/semantic-search.md).
//
// `engine.ts` and `sync.ts` are written against the `Embedder` / `VectorStore`
// interfaces below, so the ranker and the indexer can be driven by a test
// without a binding and without a network — the same seam `SqlDriver` gives
// the corpus (docs/multi-tenant-design.md §10).
//
// ## One namespace per tenant
//
// The interesting part of this module is not the two adapters, it is the wall
// between them and the tenant. A `VectorStore` is minted from a `TenantDb` and
// binds that tenant's namespace; there is no parameter for a namespace, so a
// caller cannot name one it was not given. That is deliberately the same shape
// `forTenant` has, and for the same reason: a query must be structurally
// unable to reach another tenant's vectors, rather than carefully filtered
// away from them. Metadata filtering is a filter someone can forget; a
// namespace is a different partition.
//
// The vector ids carry the tenant too, and that is not belt and braces — it is
// the other half of the same wall. Vectorize's `deleteByIds` takes ids and no
// namespace, so an id space shared between tenants would be a way for one
// tenant's indexer to delete another's vectors if two note ids ever collided.
// Prefixing makes that impossible rather than unlikely.

import type { TenantDb } from "../tenancy-db"
import type { Env } from "../types"
import type { Embedder, Semantic, VectorStore } from "./engine"

/**
 * The embedding model, and the reason it is this one: 1,075 neurons per
 * million input tokens against `@cf/baai/bge-base-en-v1.5`'s 6,058 — five
 * times cheaper, on a daily free allowance of 10,000 neurons. It is
 * multilingual, which costs nothing here and might matter later.
 *
 * Its output width is the index's width, fixed at creation
 * (`--dimensions=1024`). The two cannot drift apart silently: a vector of the
 * wrong width is refused by Vectorize on upsert.
 */
const EMBEDDING_MODEL = "@cf/baai/bge-m3"

/** What `EMBEDDING_MODEL` emits, and what the index was created with. */
const EMBEDDING_DIMENSIONS = 1024

/**
 * Texts per Workers AI call. The model takes a batch; the corpus is ~130
 * chunks, so a full index is three calls and an incremental pass is one.
 */
const EMBED_BATCH = 50

/** Vectors per Vectorize upsert. Well inside the platform's limit, and a
 * whole note is one call at any realistic note size. */
const UPSERT_BATCH = 100

interface AiBinding {
  run(
    model: typeof EMBEDDING_MODEL,
    inputs: { text: string[] },
  ): Promise<{ data?: number[][]; shape?: number[] }>
}

/** Workers AI as an `Embedder`. */
export function workersAiEmbedder(ai: AiBinding): Embedder {
  return {
    async embed(texts) {
      const vectors: number[][] = []
      for (let start = 0; start < texts.length; start += EMBED_BATCH) {
        const batch = texts.slice(start, start + EMBED_BATCH)
        const response = await ai.run(EMBEDDING_MODEL, { text: [...batch] })
        const data = response.data
        if (!data || data.length !== batch.length) {
          throw new Error(
            `${EMBEDDING_MODEL} returned ${data?.length ?? 0} vectors for ${batch.length} texts`,
          )
        }
        for (const vector of data) vectors.push(vector)
      }
      return vectors
    },
  }
}

interface VectorizeBinding {
  query(
    vector: number[],
    options: { topK: number; namespace: string; returnValues?: boolean },
  ): Promise<{ matches: { id: string; score: number }[] }>
  upsert(vectors: { id: string; values: number[]; namespace: string }[]): Promise<unknown>
  deleteByIds(ids: string[]): Promise<unknown>
}

/**
 * A Vectorize index, scoped to one tenant.
 *
 * Mint it from a `TenantDb` and from nothing else: the namespace and the id
 * prefix both come from the verified id that handle was minted with, so there
 * is no path by which a request can choose which partition it reads.
 */
export function tenantVectorStore(index: VectorizeBinding, tenant: TenantDb): VectorStore {
  const namespace = String(tenant.userId)
  const prefix = `${namespace}:`
  return {
    async search(vector, topK) {
      const { matches } = await index.query(vector, { topK, namespace })
      return matches
        .filter((match) => match.id.startsWith(prefix))
        .map((match) => ({ id: match.id.slice(prefix.length), score: match.score }))
    },
    async upsert(entries) {
      for (const entry of entries) {
        // Vectorize refuses a wrong-width vector, but it refuses it with a
        // platform error a long way from the cause. Say which chunk it was.
        if (entry.values.length !== EMBEDDING_DIMENSIONS) {
          throw new Error(
            `${entry.id}: ${entry.values.length} dimensions, index expects ${EMBEDDING_DIMENSIONS}`,
          )
        }
      }
      for (let start = 0; start < entries.length; start += UPSERT_BATCH) {
        const batch = entries.slice(start, start + UPSERT_BATCH)
        await index.upsert(
          batch.map((entry) => ({ id: prefix + entry.id, values: entry.values, namespace })),
        )
      }
    },
    async remove(ids) {
      if (ids.length === 0) return
      await index.deleteByIds(ids.map((id) => prefix + id))
    },
  }
}

/**
 * The semantic half for this request, or `null`.
 *
 * Null is not an error and never becomes one: a deployment without the
 * bindings — a `wrangler dev` without remote access, a preview that has not
 * had them rolled out — searches lexically and says so in the result
 * (`semanticUsed: false`). The same reading the image routes take of a missing
 * R2 bucket, and the rate limiter takes of a missing rate-limit binding.
 */
export function semanticFor(env: Env, tenant: TenantDb): Semantic | null {
  if (!env.AI || !env.VECTORIZE) return null
  return {
    embedder: workersAiEmbedder(env.AI as unknown as AiBinding),
    store: tenantVectorStore(env.VECTORIZE as unknown as VectorizeBinding, tenant),
  }
}
