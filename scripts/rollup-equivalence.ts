// Assert the schema v2 rollup invariant over a real corpus of markdown files:
//
//   npx vite-node scripts/rollup-equivalence.ts -- <notes-dir>
//
// For every `.md` file in the directory it checks that ONE ingest+rollup pass
// converges: the first pass may deliberately normalize the bytes (near-miss
// marker spellings like `[] x` / `[X] x` / `* x` / `2) x` become their typed
// canonical form, and frontmatter canonicalizes — see src/data/graph.ts), and
// the normalized output must be a strict byte-for-byte fixpoint of a second
// pass. Files whose canonical form is already normalized round-trip
// byte-identically, which the report counts separately.
// Exits non-zero listing every file that fails.
//
// vite-node applies the app's browser node-polyfills, which shim node:fs into
// a stub — reach the real builtins the same way sql-node-test-driver does.
const { readdirSync, readFileSync } = process.getBuiltinModule("node:fs")
const path = process.getBuiltinModule("node:path")
import { parse } from "../src/blocks/parse"
import { serialize } from "../src/blocks/serialize"
import { buildGraphSnapshot, docToGraph, rollup } from "../src/data/graph"

const [notesDir] = process.argv.slice(2).filter((a) => a !== "--")
if (!notesDir) {
  console.error("usage: npx vite-node scripts/rollup-equivalence.ts -- <notes-dir>")
  process.exit(2)
}

const viaGraph = (id: string, markdown: string): string | null => {
  const { nodes, links } = docToGraph(id, markdown, 0)
  return rollup(id, buildGraphSnapshot(nodes, links))
}

const failures: string[] = []
let checked = 0
let normalized = 0

for (const file of readdirSync(notesDir).sort()) {
  if (!file.endsWith(".md")) continue
  const id = file.slice(0, -3)
  const raw = readFileSync(path.join(notesDir, file), "utf8")
  const canonical = serialize(parse(raw))

  const first = viaGraph(id, canonical)
  checked += 1
  if (first === null) {
    failures.push(file)
    console.error(`✗ ${file}\n  rollup returned null (page node missing)`)
    continue
  }
  if (first !== canonical) normalized += 1

  const second = viaGraph(id, first)
  if (second !== first) {
    failures.push(file)
    console.error(`✗ ${file} (normalized form is not a fixpoint)`)
    // Show the first diverging line for a fast diagnosis.
    const a = first.split("\n")
    const b = (second ?? "").split("\n")
    for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
      if (a[i] !== b[i]) {
        console.error(`  line ${i + 1}:`)
        console.error(`    first pass:  ${JSON.stringify(a[i])}`)
        console.error(`    second pass: ${JSON.stringify(b[i])}`)
        break
      }
    }
  }
}

if (failures.length > 0) {
  console.error(`\nrollup equivalence: ${failures.length}/${checked} files FAILED`)
  process.exit(1)
}
console.log(
  `rollup equivalence: ${checked} files OK (${normalized} normalized on first pass, ` +
    `${checked - normalized} byte-identical)`,
)
