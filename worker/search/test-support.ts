// tenant-guard: exempt — test scaffolding; the only SQL here is the fixture's.
//
// A `Semantic` with no network in it: a deterministic bag-of-words embedder
// and an in-memory vector store.
//
// What this can and cannot test is worth being explicit about. It tests the
// PLUMBING — that a chunk reaches the index, that a tombstone removes it, that
// a candidate is resolved through the scoped accessors, that one tenant's
// query cannot reach another's vectors, that fusion ranks the way it says it
// does. It cannot test whether `@cf/baai/bge-m3` retrieves a paraphrase, and
// it does not pretend to: that is a question about a model, it needs the real
// model to answer, and `scripts/chunking-experiment.ts` answers it.
//
// A bag-of-words embedding is chosen because it makes the plumbing tests
// READABLE — a test can say "this query shares a word with that section" and
// the ranking follows — not because it resembles the real model.

import type { Embedder, Semantic, VectorStore } from "./engine"

/** The vocabulary the fake embeds over, built as it goes. Same word, same
 * dimension, for the life of one fake. */
function vocabulary() {
  const index = new Map<string, number>()
  return (word: string): number => {
    const existing = index.get(word)
    if (existing !== undefined) return existing
    const next = index.size
    index.set(word, next)
    return next
  }
}

const WORDS = /[a-z0-9]+/g

/** A fixed width, so every vector is comparable; wider than any fixture's
 * vocabulary, and far cheaper than the real model's 1,024. */
const WIDTH = 256

function fakeEmbedder(): Embedder {
  const dimensionOf = vocabulary()
  return {
    embed(texts) {
      return Promise.resolve(
        texts.map((text) => {
          const vector = new Array<number>(WIDTH).fill(0)
          for (const word of text.toLowerCase().match(WORDS) ?? []) {
            vector[dimensionOf(word) % WIDTH] += 1
          }
          const length = Math.hypot(...vector) || 1
          return vector.map((value) => value / length)
        }),
      )
    },
  }
}

export interface FakeStore extends VectorStore {
  /** Every id currently held — what a test asserts about after a sync. */
  ids(): string[]
  /** How many upserts and deletes have been issued, for cost assertions. */
  readonly calls: { upsert: number; remove: number; search: number }
}

/**
 * An in-memory store with the same contract as the Vectorize adapter,
 * including that it is bound to one partition: two `fakeStore()`s cannot see
 * each other, which is what a namespace buys.
 */
function fakeStore(): FakeStore {
  const vectors = new Map<string, number[]>()
  const calls = { upsert: 0, remove: 0, search: 0 }
  return {
    calls,
    ids: () => [...vectors.keys()].sort(),
    search(vector, topK) {
      calls.search += 1
      const scored = [...vectors.entries()].map(([id, stored]) => ({
        id,
        score: stored.reduce((sum, value, index) => sum + value * vector[index], 0),
      }))
      return Promise.resolve(scored.sort((a, b) => b.score - a.score).slice(0, topK))
    },
    upsert(entries) {
      calls.upsert += 1
      for (const entry of entries) vectors.set(entry.id, entry.values)
      return Promise.resolve()
    },
    remove(ids) {
      calls.remove += 1
      for (const id of ids) vectors.delete(id)
      return Promise.resolve()
    },
  }
}

export function fakeSemantic(): Semantic & { store: FakeStore } {
  return { embedder: fakeEmbedder(), store: fakeStore() }
}
