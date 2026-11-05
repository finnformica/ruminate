// Shots mode (docs/screenshots.md): the app signed in, with data, for
// screenshots. Only the Vite dev server runs: no Worker, no database. The
// mock layer (src/shots/) answers the API in the browser from a fixture set.
//
//   npm run shots:serve                                  the demo set (committed)
//   npm run shots:serve -- --data profile [--fixtures <dir>]   a profile set
//   npm run shots:serve -- --port 4791                   the port (default 4791)
//
// Prints `shots: ready in <s> s at <url>` once the app answers, then keeps
// serving until it is stopped (Ctrl-C, or kill the process).
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..")
const DEFAULT_PROFILE = "/home/orca/ruminate-prod-clone/fixtures"

const argv = process.argv.slice(2)
const option = (name, fallback) => {
  const at = argv.indexOf(name)
  return at === -1 ? fallback : argv[at + 1]
}
const data = option("--data", "demo")
const port = Number(option("--port", "4791"))
if (data !== "demo" && data !== "profile") fail("--data is demo or profile")
if (!Number.isInteger(port)) fail("--port must be a number")

const fixtures =
  data === "demo"
    ? path.join(ROOT, "shots/demo")
    : path.resolve(option("--fixtures", process.env.RUMINATE_SHOTS_PROFILE || DEFAULT_PROFILE))
if (!existsSync(path.join(fixtures, "fixtures.json"))) {
  fail(
    data === "demo"
      ? "shots/demo/fixtures.json is missing: run npm run shots:demo"
      : `no fixtures.json in ${fixtures}: run npm run shots:profile`,
  )
}

if (data === "profile") {
  const bar = "!".repeat(72)
  console.warn(
    `\x1b[41;97m${bar}\n` +
      " PROFILE MODE: these are a real user's private notes.\n" +
      " Never commit this data or a shot of it. Never post a shot of it in a PR:\n" +
      " finnformica/ruminate is public. Keep profile shots for local checks only.\n" +
      `${bar}\x1b[0m`,
  )
}

const url = `http://127.0.0.1:${port}`
const started = Date.now()
const vite = spawn(
  "npx",
  ["vite", "--mode", "shots", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
  { cwd: ROOT, stdio: "inherit", env: { ...process.env, SHOTS_FIXTURES: fixtures } },
)
vite.on("exit", (code) => process.exit(code ?? 0))
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => vite.kill(signal))

// Ready when the page and the app's entry both answer: the entry's first
// transform is most of a cold start.
for (;;) {
  await new Promise((resolve) => setTimeout(resolve, 500))
  try {
    const page = await fetch(`${url}/`)
    if (!page.ok) continue
    const entry = await fetch(`${url}/src/index.tsx`)
    if (!entry.ok) continue
    break
  } catch {
    // Not up yet.
  }
}
const seconds = ((Date.now() - started) / 1000).toFixed(1)
console.log(`\nshots: ready in ${seconds} s at ${url}/ (${data} data)`)
console.log(`shots: e.g. orca-shot ${url}/settings --viewport 1440x900\n`)

function fail(message) {
  console.error(`shots:serve: ${message}`)
  process.exit(1)
}
