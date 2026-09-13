// The tenant wall around the vector index (docs/semantic-search.md).
//
// The interesting assertions here are the ones about what a store CANNOT do:
// name another namespace, read a vector it did not write, or delete one.

import { describe, expect, test } from "vitest"
import { createMcpTestEnv } from "../mcp/test-support"
import { tenantVectorStore, workersAiEmbedder } from "./vector-index"

/** A vector of the index's real width, with the leading values given — the
 * adapter checks the width, so a two-element test vector would be refused. */
const vec = (...values: number[]): number[] =>
  Array.from({ length: 1024 }, (_, index) => values[index] ?? 0)

/** A Vectorize stand-in that records exactly what the adapter sent it, and
 * partitions by namespace the way the real one does. */
function fakeVectorize() {
  const rows: { id: string; values: number[]; namespace: string }[] = []
  return {
    rows,
    query(vector: number[], options: { topK: number; namespace: string }) {
      const matches = rows
        .filter((row) => row.namespace === options.namespace)
        .map((row) => ({
          id: row.id,
          score: row.values.reduce((sum, value, index) => sum + value * vector[index], 0),
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, options.topK)
      return Promise.resolve({ matches })
    },
    upsert(vectors: { id: string; values: number[]; namespace: string }[]) {
      for (const vector of vectors) {
        const existing = rows.findIndex((row) => row.id === vector.id)
        if (existing >= 0) rows[existing] = vector
        else rows.push(vector)
      }
      return Promise.resolve({})
    },
    deleteByIds(ids: string[]) {
      // Deliberately NOT namespaced — this is the real API's shape, and the
      // reason the adapter prefixes its ids.
      for (const id of ids) {
        const at = rows.findIndex((row) => row.id === id)
        if (at >= 0) rows.splice(at, 1)
      }
      return Promise.resolve({})
    },
  }
}

describe("tenantVectorStore", () => {
  test("writes under the tenant's namespace, and prefixes the id with it", async () => {
    const env = await createMcpTestEnv()
    const index = fakeVectorize()

    await tenantVectorStore(index, env.tenant(42536816)).upsert([
      { id: "note_a#0", values: vec(1, 0) },
    ])

    expect(index.rows).toEqual([
      { id: "42536816:note_a#0", values: vec(1, 0), namespace: "42536816" },
    ])
  })

  test("a query cannot reach another tenant's vectors", async () => {
    const env = await createMcpTestEnv()
    const index = fakeVectorize()
    const mine = tenantVectorStore(index, env.tenant(1))
    const theirs = tenantVectorStore(index, env.tenant(2))

    await mine.upsert([{ id: "note_a#0", values: vec(1, 0) }])
    await theirs.upsert([{ id: "note_b#0", values: vec(1, 0) }])

    // The same query vector, the same index, two partitions.
    expect(await mine.search(vec(1, 0), 10)).toEqual([{ id: "note_a#0", score: 1 }])
    expect(await theirs.search(vec(1, 0), 10)).toEqual([{ id: "note_b#0", score: 1 }])
  })

  test("a delete cannot reach another tenant's vectors, even with colliding ids", async () => {
    const env = await createMcpTestEnv()
    const index = fakeVectorize()
    const mine = tenantVectorStore(index, env.tenant(1))
    const theirs = tenantVectorStore(index, env.tenant(2))

    // The SAME note id in both tenants — unlikely, but `deleteByIds` takes no
    // namespace, so "unlikely" would be the whole guarantee without the prefix.
    await mine.upsert([{ id: "note_same#0", values: vec(1, 0) }])
    await theirs.upsert([{ id: "note_same#0", values: vec(0, 1) }])
    await mine.remove(["note_same#0"])

    expect(index.rows).toEqual([{ id: "2:note_same#0", values: vec(0, 1), namespace: "2" }])
  })

  test("a wrong-width vector is refused, naming the chunk", async () => {
    const env = await createMcpTestEnv()

    await expect(
      tenantVectorStore(fakeVectorize(), env.tenant(1)).upsert([
        { id: "note_a#0", values: [1, 2, 3] },
      ]),
    ).rejects.toThrow(/note_a#0: 3 dimensions, index expects 1024/)
  })

  test("a delete of nothing is not a call", async () => {
    const env = await createMcpTestEnv()
    const index = fakeVectorize()
    let calls = 0
    const counted = {
      ...index,
      deleteByIds: (ids: string[]) => {
        calls += 1
        return index.deleteByIds(ids)
      },
    }

    await tenantVectorStore(counted, env.tenant(1)).remove([])

    expect(calls).toBe(0)
  })
})

describe("workersAiEmbedder", () => {
  test("batches, and keeps the order the caller asked in", async () => {
    const seen: string[][] = []
    const embedder = workersAiEmbedder({
      run: (_model, inputs) => {
        seen.push(inputs.text)
        return Promise.resolve({ data: inputs.text.map((text) => [text.length]) })
      },
    })

    const texts = Array.from({ length: 120 }, (_, index) => "x".repeat(index + 1))
    const vectors = await embedder.embed(texts)

    expect(seen.map((batch) => batch.length)).toEqual([50, 50, 20])
    expect(vectors).toEqual(texts.map((text) => [text.length]))
  })

  test("a short answer is an error, not a silent misalignment", async () => {
    const embedder = workersAiEmbedder({
      run: () => Promise.resolve({ data: [[1]] }),
    })

    await expect(embedder.embed(["a", "b"])).rejects.toThrow(/returned 1 vectors for 2 texts/)
  })
})
