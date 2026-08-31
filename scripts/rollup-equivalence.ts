// Assert the schema v2 rollup invariant over a real corpus of markdown files:
//
//   npx vite-node scripts/rollup-equivalence.ts -- <notes-dir>
//
// For every `.md` file in the directory it checks, byte-for-byte:
//   rollup(docToGraph(canonicalize(md))) === canonicalize(md)
// where `canonicalize` is the editor's own `serialize(parse(md))` fixpoint
// (raw files without `id::` lines get ids minted by canonicalization first).
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

const failures: string[] = []
let checked = 0

for (const file of readdirSync(notesDir).sort()) {
  if (!file.endsWith(".md")) continue
  const id = file.slice(0, -3)
  const raw = readFileSync(path.join(notesDir, file), "utf8")
  const canonical = serialize(parse(raw))

  const { nodes, links } = docToGraph(id, canonical, 0)
  const rolled = rollup(id, buildGraphSnapshot(nodes, links))
  checked += 1

  if (rolled !== canonical) {
    failures.push(file)
    console.error(`✗ ${file}`)
    if (rolled === null) {
      console.error("  rollup returned null (page node missing)")
      continue
    }
    // Show the first diverging line for a fast diagnosis.
    const a = canonical.split("\n")
    const b = rolled.split("\n")
    for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
      if (a[i] !== b[i]) {
        console.error(`  line ${i + 1}:`)
        console.error(`    canonical: ${JSON.stringify(a[i])}`)
        console.error(`    rollup:    ${JSON.stringify(b[i])}`)
        break
      }
    }
  }
}

if (failures.length > 0) {
  console.error(`\nrollup equivalence: ${failures.length}/${checked} files FAILED`)
  process.exit(1)
}
console.log(`rollup equivalence: ${checked} files OK`)
