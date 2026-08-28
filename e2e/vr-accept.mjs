// Accept a CI run's captured screenshots as the visual-regression baselines.
//
//   npm run test:vr:accept            latest completed CI run on main
//   npm run test:vr:accept -- <run>   a specific run id
//
// Downloads the run's `vr-output` artifact (published by every CI run, pass or
// fail) and installs its `refreshed/` set into e2e/__vr_baselines__. Requires
// the GitHub CLI (`gh`) to be authenticated.
import { execFileSync } from "node:child_process"
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"

const DIR = path.dirname(new URL(import.meta.url).pathname)
const BASELINE_DIR = path.join(DIR, "__vr_baselines__")

const gh = (...args) => execFileSync("gh", args, { encoding: "utf8" }).trim()

let runId = process.argv[2]
if (!runId) {
  runId = gh(
    "run",
    "list",
    "--workflow=CI",
    "--branch=main",
    "--status=completed",
    "--limit=1",
    "--json=databaseId",
    "--jq=.[0].databaseId",
  )
  if (!runId) {
    console.error("No completed CI run found on main.")
    process.exit(1)
  }
}

const tmp = mkdtempSync(path.join(os.tmpdir(), "vr-accept-"))
try {
  gh("run", "download", String(runId), "--name=vr-output", `--dir=${tmp}`)
  const refreshed = path.join(tmp, "refreshed")
  if (!existsSync(refreshed)) {
    console.error(`Run ${runId}'s vr-output artifact has no refreshed/ set.`)
    process.exit(1)
  }
  rmSync(BASELINE_DIR, { recursive: true, force: true })
  cpSync(refreshed, BASELINE_DIR, { recursive: true })
  const count = readdirSync(BASELINE_DIR).filter((f) => f.endsWith(".png")).length
  console.log(`Installed ${count} baselines from run ${runId} into ${BASELINE_DIR}.`)
  console.log("Review with git diff, then commit.")
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
