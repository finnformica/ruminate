/**
 * THROWAWAY EXPERIMENT — the question that had to be answered before any of
 * the semantic-search code was written, kept because the answer is the
 * argument for the code's shape (docs/semantic-search.md).
 *
 *   npx vite-node scripts/chunking-experiment.ts
 *
 * It costs a few hundred Workers AI neurons and writes nothing anywhere.
 *
 * ## The question
 *
 * This corpus is an OUTLINER, not a document store. Measured on production:
 * 634 blocks, 25,847 characters, longest block 175 characters — a mean of
 * about 41, roughly eight words. Embedding an eight-word fragment on its own
 * may retrieve nothing useful, and if it does not, no amount of good plumbing
 * downstream saves it. So: embed WHAT?
 *
 * Three candidates, run over the same fixture corpus and the same queries:
 *
 *   1. `bare`     — the block's own text, alone.
 *   2. `titled`   — the block's text prefixed with the title of the note it
 *                   was written in (`notes_id` — one stable value set once at
 *                   creation, NOT a path). Deliberately not an ancestor path:
 *                   this is a graph, a block is reachable by many paths, and
 *                   there is no single "the" path to store.
 *   3. `section`  — a heading plus its whole subtree as ONE chunk, resolved
 *                   back to the blocks inside it when it is retrieved.
 *
 * against two baselines:
 *
 *   - `lexical`   — the app's own fuzzy matcher over block text (`fast-fuzzy`,
 *                   `threshold: 0.8` — the exact configuration `BlockIndex`
 *                   builds in src/utils/block-search.ts).
 *   - `hybrid`    — reciprocal-rank fusion of `lexical` with the best
 *                   embedding strategy, which is what the feature ships.
 *
 * ## How it is judged
 *
 * Every query is a PARAPHRASE with a known target block (scripts/chunking-fixture.ts).
 * Two thirds are written to share no meaningful word with their target — the
 * case embeddings exist for. The rest name the thing exactly — jargon, a
 * number, a proper noun — the case embeddings are worst at and a fuzzy matcher
 * is perfect at. Reporting only the first group would rig the result.
 *
 * `section` is scored generously on rank (a section "hits" when it CONTAINS
 * the target) and then charged for it: `blocks read` is how many blocks an
 * agent would have to pull back to reach the target through that ranking,
 * which is the cost a coarser chunk actually imposes.
 */
import { Searcher } from "fast-fuzzy"
import { getPlatformProxy } from "wrangler"
import { FIXTURE_NOTES, FIXTURE_QUERIES, type FixtureBlock } from "./chunking-fixture"

const MODEL = "@cf/baai/bge-m3"
/** Texts per Workers AI call. Well inside the batch limit, and this corpus is
 * a dozen calls whatever the number. */
const BATCH = 50
/** Ranks past this are "not found" — an agent is not reading 50 candidates. */
const CUTOFF = 20

// -----------------------------------------------------------------------------
// The corpus, flattened
// -----------------------------------------------------------------------------

interface Block {
  id: string
  type: string
  text: string
  noteId: string
  noteTitle: string
  /** The nearest heading above it, if any — used only to build `section`. */
  sectionId: string
}

function flatten(): Block[] {
  const blocks: Block[] = []
  for (const note of FIXTURE_NOTES) {
    let sectionId = `${note.id}_preamble`
    const walk = (rows: FixtureBlock[]) => {
      for (const row of rows) {
        if (row.type === "h2" || row.type === "h3") sectionId = row.id
        blocks.push({
          id: row.id,
          type: row.type,
          text: row.text,
          noteId: note.id,
          noteTitle: note.title,
          sectionId,
        })
        if (row.children) walk(row.children)
      }
    }
    walk(note.blocks)
  }
  return blocks
}

// -----------------------------------------------------------------------------
// The strategies
// -----------------------------------------------------------------------------

/** One embeddable chunk, and the blocks retrieving it hands back. */
interface Chunk {
  text: string
  blockIds: string[]
}

const bareChunks = (blocks: Block[]): Chunk[] =>
  blocks.map((block) => ({ text: block.text, blockIds: [block.id] }))

const titledChunks = (blocks: Block[]): Chunk[] =>
  blocks.map((block) => ({ text: `${block.noteTitle}: ${block.text}`, blockIds: [block.id] }))

function sectionChunks(blocks: Block[]): Chunk[] {
  const bySection = new Map<string, Block[]>()
  for (const block of blocks) {
    const rows = bySection.get(block.sectionId)
    if (rows) rows.push(block)
    else bySection.set(block.sectionId, [block])
  }
  return [...bySection.values()].map((rows) => ({
    text: `${rows[0].noteTitle}: ${rows.map((row) => row.text).join("\n")}`,
    blockIds: rows.map((row) => row.id),
  }))
}

// -----------------------------------------------------------------------------
// Embedding
// -----------------------------------------------------------------------------

interface AiBinding {
  run(model: string, input: { text: string[] }): Promise<{ data: number[][]; meta?: unknown }>
}

let neurons = 0
let inputTokens = 0

/** What one call to `embed` cost — reported per strategy, because "what does a
 * full index of this corpus cost?" is the operator's question and the answer
 * depends entirely on which strategy won. */
interface Spend {
  tokens: number
  neurons: number
}

async function embed(ai: AiBinding, texts: string[]): Promise<[Float32Array[], Spend]> {
  const out: Float32Array[] = []
  const spend: Spend = { tokens: 0, neurons: 0 }
  for (let start = 0; start < texts.length; start += BATCH) {
    const response = await ai.run(MODEL, { text: texts.slice(start, start + BATCH) })
    const meta = response.meta as { neurons?: number; cost_metric_value_1?: number } | undefined
    spend.neurons += meta?.neurons ?? 0
    spend.tokens += meta?.cost_metric_value_1 ?? 0
    for (const vector of response.data) out.push(normalize(vector))
  }
  neurons += spend.neurons
  inputTokens += spend.tokens
  return [out, spend]
}

function normalize(vector: number[]): Float32Array {
  let sum = 0
  for (const value of vector) sum += value * value
  const length = Math.sqrt(sum) || 1
  const out = new Float32Array(vector.length)
  for (let index = 0; index < vector.length; index += 1) out[index] = vector[index] / length
  return out
}

const dot = (a: Float32Array, b: Float32Array): number => {
  let sum = 0
  for (let index = 0; index < a.length; index += 1) sum += a[index] * b[index]
  return sum
}

// -----------------------------------------------------------------------------
// Scoring
// -----------------------------------------------------------------------------

/** A ranked list of chunks, best first. */
type Ranking = Chunk[]

interface Score {
  /** 1-based rank of the first chunk containing the target, or 0 for a miss. */
  rank: number
  /** Blocks an agent reads to reach the target through this ranking. */
  blocksRead: number
}

function score(ranking: Ranking, target: string): Score {
  let blocksRead = 0
  for (let index = 0; index < Math.min(ranking.length, CUTOFF); index += 1) {
    blocksRead += ranking[index].blockIds.length
    if (ranking[index].blockIds.includes(target)) return { rank: index + 1, blocksRead }
  }
  return { rank: 0, blocksRead: 0 }
}

interface Summary {
  name: string
  hit1: number
  hit5: number
  mrr: number
  blocksRead: number
  semanticHit5: number
  lexicalHit5: number
}

function summarize(name: string, scores: { score: Score; kind: string }[]): Summary {
  const total = scores.length
  const semantic = scores.filter((entry) => entry.kind === "semantic")
  const lexical = scores.filter((entry) => entry.kind === "lexical")
  const hitsAt = (rows: typeof scores, n: number) =>
    rows.filter((entry) => entry.score.rank > 0 && entry.score.rank <= n).length
  const found = scores.filter((entry) => entry.score.rank > 0)
  return {
    name,
    hit1: hitsAt(scores, 1) / total,
    hit5: hitsAt(scores, 5) / total,
    mrr:
      scores.reduce((sum, entry) => sum + (entry.score.rank ? 1 / entry.score.rank : 0), 0) / total,
    blocksRead: found.length
      ? found.reduce((sum, entry) => sum + entry.score.blocksRead, 0) / found.length
      : 0,
    semanticHit5: semantic.length ? hitsAt(semantic, 5) / semantic.length : 0,
    lexicalHit5: lexical.length ? hitsAt(lexical, 5) / lexical.length : 0,
  }
}

/** Reciprocal-rank fusion — the merge the shipped ranker uses, so the number
 * in the table is the number the feature gets. */
const RRF_K = 60

function fuse(rankings: Ranking[]): Ranking {
  const scores = new Map<string, { chunk: Chunk; score: number }>()
  for (const ranking of rankings) {
    ranking.slice(0, CUTOFF).forEach((chunk, index) => {
      const key = chunk.blockIds.join(",")
      const existing = scores.get(key)
      const points = 1 / (RRF_K + index + 1)
      if (existing) existing.score += points
      else scores.set(key, { chunk, score: points })
    })
  }
  return [...scores.values()].sort((a, b) => b.score - a.score).map((entry) => entry.chunk)
}

// -----------------------------------------------------------------------------
// Run
// -----------------------------------------------------------------------------

const pct = (value: number) => `${(value * 100).toFixed(0)}%`

async function main() {
  const blocks = flatten()
  const lengths = blocks.map((block) => block.text.length)
  const characters = lengths.reduce((sum, length) => sum + length, 0)
  console.log("Fixture corpus")
  console.log(`  notes            ${FIXTURE_NOTES.length}`)
  console.log(`  blocks           ${blocks.length}`)
  console.log(`  characters       ${characters}`)
  console.log(`  mean block       ${(characters / blocks.length).toFixed(1)} chars`)
  console.log(`  longest block    ${Math.max(...lengths)} chars`)
  console.log(`  queries          ${FIXTURE_QUERIES.length}`)
  console.log("  (production: 634 blocks, 25,847 chars, mean 41, longest 175)\n")

  const { env, dispose } = await getPlatformProxy<{ AI: AiBinding }>()
  try {
    const strategies: { name: string; chunks: Chunk[] }[] = [
      { name: "bare", chunks: bareChunks(blocks) },
      { name: "titled", chunks: titledChunks(blocks) },
      { name: "section", chunks: sectionChunks(blocks) },
    ]

    const [queryVectors, querySpend] = await embed(
      env.AI,
      FIXTURE_QUERIES.map((entry) => entry.query),
    )
    console.log(
      `\n${FIXTURE_QUERIES.length} queries: ${querySpend.tokens} tokens, ` +
        `${querySpend.neurons.toFixed(3)} neurons ` +
        `(${(querySpend.neurons / FIXTURE_QUERIES.length).toFixed(4)} per query)\n`,
    )

    const rankings = new Map<string, Ranking[]>()
    for (const strategy of strategies) {
      const [vectors, spend] = await embed(
        env.AI,
        strategy.chunks.map((chunk) => chunk.text),
      )
      rankings.set(
        strategy.name,
        queryVectors.map((query) =>
          strategy.chunks
            .map((chunk, index) => ({ chunk, similarity: dot(query, vectors[index]) }))
            .sort((a, b) => b.similarity - a.similarity)
            .map((entry) => entry.chunk),
        ),
      )
      console.log(
        `embedded ${String(strategy.chunks.length).padStart(4)} ${strategy.name.padEnd(8)} ` +
          `chunks: ${String(spend.tokens).padStart(6)} tokens, ` +
          `${spend.neurons.toFixed(2).padStart(6)} neurons, ` +
          `${(strategy.chunks.length * 1024).toLocaleString()} stored dimensions`,
      )
    }

    // The app's own matcher, configured exactly as `BlockIndex` configures it.
    const bare = bareChunks(blocks)
    const searcher = new Searcher(bare, { keySelector: (chunk) => chunk.text, threshold: 0.8 })
    rankings.set(
      "lexical",
      FIXTURE_QUERIES.map((entry) => searcher.search(entry.query)),
    )

    // Two granularities at once: the section ranking supplies recall (a short
    // block that says almost nothing is still inside a section that says
    // plenty), the block ranking supplies the pinpoint. Fusing them is one
    // ranker, not a two-stage pipeline.
    rankings.set(
      "titled+section",
      FIXTURE_QUERIES.map((_entry, index) =>
        fuse([rankings.get("titled")![index], rankings.get("section")![index]]),
      ),
    )

    // What ships: the app's fuzzy matcher fused with the best embedding side.
    rankings.set(
      "lexical+section",
      FIXTURE_QUERIES.map((_entry, index) =>
        fuse([rankings.get("lexical")![index], rankings.get("section")![index]]),
      ),
    )

    const summaries: Summary[] = []
    for (const [name, perQuery] of rankings) {
      summaries.push(
        summarize(
          name,
          FIXTURE_QUERIES.map((entry, index) => ({
            score: score(perQuery[index], entry.target),
            kind: entry.kind,
          })),
        ),
      )
    }

    console.log(
      "\n| strategy | hit@1 | hit@5 | MRR  | blocks read | paraphrase hit@5 | exact-term hit@5 |",
    )
    console.log(
      "| -------- | ----- | ----- | ---- | ----------- | ---------------- | ---------------- |",
    )
    for (const summary of summaries) {
      console.log(
        `| ${summary.name.padEnd(8)} | ${pct(summary.hit1).padStart(5)} | ` +
          `${pct(summary.hit5).padStart(5)} | ${summary.mrr.toFixed(2)} | ` +
          `${summary.blocksRead.toFixed(1).padStart(11)} | ` +
          `${pct(summary.semanticHit5).padStart(16)} | ${pct(summary.lexicalHit5).padStart(16)} |`,
      )
    }

    console.log("\nPer query (rank, 0 = not in top 20)\n")
    console.log("| query | kind | bare | titled | section | lexical | lexical+section |")
    console.log("| ----- | ---- | ---- | ------- | ------- | ------- | --------------- |")
    FIXTURE_QUERIES.forEach((entry, index) => {
      const cell = (name: string) => String(score(rankings.get(name)![index], entry.target).rank)
      console.log(
        `| ${entry.query} | ${entry.kind} | ${cell("bare")} | ${cell("titled")} | ` +
          `${cell("section")} | ${cell("lexical")} | ${cell("lexical+section")} |`,
      )
    })

    console.log(`\nWorkers AI: ${inputTokens} input tokens, ${neurons.toFixed(2)} neurons`)
  } finally {
    await dispose()
  }
}

await main()
