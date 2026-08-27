/**
 * Safety net for the wipe-and-re-clone paths (Settings → "Reset local copy",
 * and Settings → changing the repo): both run `gitClone`, which wipes the
 * browser filesystem. Before the wipe, any *unpushed* work — notes whose local
 * content differs from `origin/main` while local `main` is ahead/diverged — is
 * stashed into localStorage (bounded; skipped on quota). After the clone
 * succeeds, the stash is restored as conflicted-copy notes (reusing the merge
 * driver's conflicted-copy builder), so a re-clone can never silently lose
 * work.
 */

import git, { TREE, WORKDIR } from "isomorphic-git"
import { fs } from "./fs"
import { REPO_DIR, gitAdd, gitCommit } from "./git"
import { buildConflictCopy } from "./merge-driver"

const BACKUP_STORAGE_KEY = "ruminate_unpushed_backup"
const DEFAULT_BRANCH = "main"

/** Upper bound on the stashed payload — localStorage is ~5 MB total and the
 * markdown-files cache already lives there. Files are included smallest-first
 * until the budget runs out, so small notes always survive. */
export const MAX_BACKUP_BYTES = 2 * 1024 * 1024

export type UnpushedBackup = {
  createdAt: number
  files: Record<string, string>
}

/**
 * Pure: pick the notes whose local content differs from the remote tree
 * (modified locally, or absent from the remote entirely). Only `.md` files —
 * view-state sidecars are UI state and not worth a conflicted copy.
 */
export function collectBackupFiles(
  localFiles: Record<string, string>,
  remoteFiles: Record<string, string>,
): Record<string, string> {
  const files: Record<string, string> = {}
  for (const [filepath, content] of Object.entries(localFiles)) {
    if (!filepath.endsWith(".md")) continue
    if (remoteFiles[filepath] !== content) {
      files[filepath] = content
    }
  }
  return files
}

/**
 * Stash the files into localStorage, bounded by `MAX_BACKUP_BYTES`
 * (smallest-first, so as many notes as possible fit). Returns true when a
 * backup was written. Quota failures degrade to no backup (never throw).
 */
export function stashUnpushedBackup(
  files: Record<string, string>,
  now: number = Date.now(),
): boolean {
  const entries = Object.entries(files).sort((a, b) => a[1].length - b[1].length)
  if (entries.length === 0) return false

  const bounded: Record<string, string> = {}
  let bytes = 0
  for (const [filepath, content] of entries) {
    const entryBytes = filepath.length + content.length
    if (bytes + entryBytes > MAX_BACKUP_BYTES) break
    bounded[filepath] = content
    bytes += entryBytes
  }
  if (Object.keys(bounded).length === 0) return false

  const backup: UnpushedBackup = { createdAt: now, files: bounded }
  try {
    window.localStorage.setItem(BACKUP_STORAGE_KEY, JSON.stringify(backup))
    return true
  } catch {
    // Quota exceeded / storage unavailable — skip the backup rather than
    // blocking the re-clone.
    return false
  }
}

/** Read the stashed backup (without clearing it), or null. */
export function peekUnpushedBackup(): UnpushedBackup | null {
  try {
    const raw = window.localStorage.getItem(BACKUP_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as UnpushedBackup
    if (!parsed || typeof parsed !== "object") return null
    if (!parsed.files || typeof parsed.files !== "object") return null
    const files: Record<string, string> = {}
    for (const [filepath, content] of Object.entries(parsed.files)) {
      if (typeof content === "string") files[filepath] = content
    }
    if (Object.keys(files).length === 0) return null
    return { createdAt: typeof parsed.createdAt === "number" ? parsed.createdAt : 0, files }
  } catch {
    return null
  }
}

export function clearUnpushedBackup() {
  try {
    window.localStorage.removeItem(BACKUP_STORAGE_KEY)
  } catch {
    // Storage unavailable — nothing to clear.
  }
}

/**
 * Pure: turn stashed files into conflicted-copy note writes
 * (`<id>-conflict-<yyyymmdd-hhmm>.md`), reusing the merge driver's builder so
 * restored notes look exactly like sync-conflict copies.
 */
export function buildBackupRestoreWrites(
  files: Record<string, string>,
  date: Date,
): Record<string, string> {
  const writes: Record<string, string> = {}
  for (const [filepath, content] of Object.entries(files)) {
    const originalId = filepath.replace(/\.md$/, "")
    const copy = buildConflictCopy(originalId, content, date, {
      notice: `Local copy of [[${originalId}]] saved before this browser's notes were reset — nothing was lost.`,
    })
    writes[`${copy.id}.md`] = copy.content
  }
  return writes
}

/** Read all `.md` files from the given walker tree. */
async function readNotes(tree: ReturnType<typeof WORKDIR>): Promise<Record<string, string>> {
  const entries: ([string, string] | undefined)[] = await git.walk({
    fs,
    dir: REPO_DIR,
    trees: [tree],
    map: async (filepath, [entry]) => {
      if (!entry) return
      if (filepath.startsWith(".git")) return
      if (!filepath.endsWith(".md")) return
      if ((await entry.type()) !== "blob") return
      const content = await entry.content()
      if (!content) return
      return [filepath, new TextDecoder().decode(content)] as [string, string]
    },
  })
  return Object.fromEntries(entries.filter((e): e is [string, string] => Array.isArray(e)))
}

/**
 * Before a wipe: if local `main` is not at `origin/main` (unpushed or diverged
 * work exists), stash every note whose content differs from origin. Best
 * effort — any failure (no repo yet, unreadable refs, quota) results in no
 * backup rather than blocking the clone.
 */
export async function backupUnpushedNotes(): Promise<boolean> {
  try {
    const localHead = await git.resolveRef({
      fs,
      dir: REPO_DIR,
      ref: `refs/heads/${DEFAULT_BRANCH}`,
    })
    const remoteHead = await git.resolveRef({
      fs,
      dir: REPO_DIR,
      ref: `refs/remotes/origin/${DEFAULT_BRANCH}`,
    })
    if (localHead === remoteHead) return false

    const localFiles = await readNotes(WORKDIR())
    const remoteFiles = await readNotes(TREE({ ref: `refs/remotes/origin/${DEFAULT_BRANCH}` }))
    const files = collectBackupFiles(localFiles, remoteFiles)
    return stashUnpushedBackup(files)
  } catch {
    return false
  }
}

/**
 * After a successful clone: write the stashed notes back as conflicted-copy
 * notes and commit them. The stash is only cleared once the restore commit
 * lands, so a failed restore is retried after the next clone. Returns the
 * restored copy paths (empty when there was nothing to restore).
 */
export async function restoreUnpushedBackup(): Promise<string[]> {
  const backup = peekUnpushedBackup()
  if (!backup) return []

  try {
    const writes = buildBackupRestoreWrites(backup.files, new Date())
    const copyPaths = Object.keys(writes)

    for (const [copyPath, content] of Object.entries(writes)) {
      await ensureParentDirs(copyPath)
      await fs.promises.writeFile(`${REPO_DIR}/${copyPath}`, content, "utf8")
    }

    await gitAdd(copyPaths)
    await gitCommit(`Restore unpushed notes as conflicted copies: ${copyPaths.join(" ")}`)

    clearUnpushedBackup()
    return copyPaths
  } catch (error) {
    // Keep the stash for the next attempt; the clone itself succeeded.
    console.error("Failed to restore unpushed-notes backup", error)
    return []
  }
}

async function ensureParentDirs(filepath: string) {
  const dirPath = filepath.split("/").slice(0, -1).join("/")
  if (!dirPath) return
  let currentPath = REPO_DIR
  for (const segment of dirPath.split("/")) {
    currentPath = `${currentPath}/${segment}`
    const stats = await fs.promises.stat(currentPath).catch(() => null)
    if (!stats) {
      await fs.promises.mkdir(currentPath)
    }
  }
}
