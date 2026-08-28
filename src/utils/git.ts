import git, { WORKDIR } from "isomorphic-git"
import http from "isomorphic-git/http/web"
import { GitHubRepository, GitHubUser } from "../schema"
import { fs, fsWipe } from "./fs"
import { ensureFreshToken, getAccessToken, withAuthRetry } from "./github-session"
import {
  RecordedConflict,
  buildConflictCopy,
  createConflictRecordingMergeDriver,
  matchConflictPath,
} from "./merge-driver"
import { withGitLock } from "./mutex"
import { gitUserName, hasStagedChanges, isMergeUnsupportedError } from "./sync"
import { startTimer } from "./timer"

/** Basic-auth credentials for GitHub over HTTP. Reads the *live* access token
 * from the session (which may have just been refreshed), falling back to the
 * user's token for the very first call / dev PAT. */
function authFor(user: GitHubUser) {
  return () => ({ username: user.login, password: getAccessToken() ?? user.token })
}

export const REPO_DIR = "/repo"
const DEFAULT_BRANCH = "main"
const CORS_PROXY = "/cors-proxy"

/** git's conventional "infinite" depth — a fetch with this depth unshallows the repo. */
const UNSHALLOW_DEPTH = 2147483647

export async function gitClone(repo: GitHubRepository, user: GitHubUser) {
  const options: Parameters<typeof git.clone>[0] = {
    fs,
    http,
    dir: REPO_DIR,
    // corsProxy: "https://cors.isomorphic-git.org",
    corsProxy: CORS_PROXY,
    url: `https://github.com/${repo.owner}/${repo.name}`,
    ref: DEFAULT_BRANCH,
    singleBranch: true,
    // Full clone (no `depth`): shallow history can make the merge base
    // unresolvable after the branches diverge (MergeNotSupportedError), so new
    // clones never start shallow. Legacy shallow clones recover by deepening
    // on demand in `gitPull`.
    onMessage: (message) => console.debug("onMessage", message),
    onProgress: (progress) => console.debug("onProgress", progress),
    onAuth: authFor(user),
  }

  return withGitLock(async () => {
    // Wipe file system
    // TODO: Only remove the repo directory instead of wiping the entire file system
    // Blocked by https://github.com/isomorphic-git/lightning-fs/issues/71
    fsWipe()

    // Clone repo
    await ensureFreshToken()
    let stopTimer = startTimer(`git clone ${options.url} ${options.dir}`)
    await withAuthRetry(() => git.clone(options))
    stopTimer()

    // Set user in git config
    const userName = gitUserName(user)
    stopTimer = startTimer(`git config user.name "${userName}"`)
    await git.setConfig({ fs, dir: REPO_DIR, path: "user.name", value: userName })
    stopTimer()

    // Set email in git config
    stopTimer = startTimer(`git config user.email "${user.email}"`)
    await git.setConfig({ fs, dir: REPO_DIR, path: "user.email", value: user.email })
    stopTimer()
  })
}

/**
 * Pull = fetch + merge (with our conflict-recording merge driver) + checkout.
 *
 * isomorphic-git's `pull` does not expose `mergeDriver`, and its default merge
 * aborts on any content conflict (which used to dead-end sync until the user
 * re-cloned, losing unpushed work). Our driver merges every content conflict
 * cleanly — ours wins per conflicting hunk, sidecars ours-wins wholesale — and
 * the full remote version of each genuinely conflicted note is preserved as a
 * conflicted-copy note committed right after the merge.
 */
export async function gitPull(user: GitHubUser) {
  return withGitLock(async () => {
    await ensureFreshToken()
    const stopTimer = startTimer("git pull")
    try {
      const fetchResult = await withAuthRetry(() => git.fetch(fetchOptions(user)))
      const theirs = fetchResult.fetchHead ?? `refs/remotes/origin/${DEFAULT_BRANCH}`
      await mergeRemote(user, theirs)
      await git.checkout({ fs, dir: REPO_DIR, ref: DEFAULT_BRANCH })
    } finally {
      stopTimer()
    }
  })
}

function fetchOptions(user: GitHubUser, depth?: number): Parameters<typeof git.fetch>[0] {
  return {
    fs,
    http,
    dir: REPO_DIR,
    corsProxy: CORS_PROXY,
    ref: DEFAULT_BRANCH,
    singleBranch: true,
    ...(depth !== undefined ? { depth } : {}),
    onMessage: (message) => console.debug("onMessage", message),
    onProgress: (progress) => console.debug("onProgress", progress),
    onAuth: authFor(user),
  }
}

async function mergeRemote(user: GitHubUser, theirs: string) {
  const { mergeDriver, conflicts } = createConflictRecordingMergeDriver()
  const identity = { name: gitUserName(user), email: user.email }
  const mergeOptions: Parameters<typeof git.merge>[0] = {
    fs,
    dir: REPO_DIR,
    ours: DEFAULT_BRANCH,
    theirs,
    author: identity,
    committer: identity,
    mergeDriver,
  }

  try {
    await git.merge(mergeOptions)
  } catch (error) {
    // MergeNotSupportedError: no single merge base — almost always a legacy
    // shallow clone whose history doesn't reach the merge base. Deepen
    // (unshallow) and retry the merge ONCE.
    if (!isMergeUnsupportedError(error)) throw error
    await withAuthRetry(() => git.fetch(fetchOptions(user, UNSHALLOW_DEPTH)))
    conflicts.length = 0
    await git.merge(mergeOptions)
  }

  await writeConflictCopies(conflicts)
}

/**
 * For every note that had a real conflicting hunk during the merge, write a
 * conflicted-copy note preserving the full remote version and commit the
 * copies immediately after the merge commit. Nothing is ever silently lost.
 */
async function writeConflictCopies(conflicts: RecordedConflict[]) {
  if (conflicts.length === 0) return

  const notePaths = await listWorkdirFiles((filepath) => filepath.endsWith(".md"))
  const now = new Date()
  const copyPaths: string[] = []

  for (const conflict of conflicts) {
    // The merge driver only sees basenames; re-resolve to the full repo path,
    // disambiguating duplicate basenames by the merged content on disk.
    const candidates = notePaths.filter((p) => p.split("/").pop() === conflict.basename)
    const contentByPath = new Map<string, string>()
    for (const candidate of candidates) {
      const content = await fs.promises.readFile(`${REPO_DIR}/${candidate}`, "utf8")
      contentByPath.set(
        candidate,
        typeof content === "string" ? content : new TextDecoder().decode(content),
      )
    }
    const fullPath = matchConflictPath(conflict, notePaths, (p) => contentByPath.get(p))
    if (!fullPath) continue

    const originalId = fullPath.replace(/\.md$/, "")
    const copy = buildConflictCopy(originalId, conflict.theirs, now)
    const copyPath = `${copy.id}.md`
    await fs.promises.writeFile(`${REPO_DIR}/${copyPath}`, copy.content, "utf8")
    copyPaths.push(copyPath)
  }

  if (copyPaths.length > 0) {
    await gitAdd(copyPaths)
    await gitCommit(`Preserve remote versions from sync conflict: ${copyPaths.join(" ")}`)
  }
}

/** List workdir file paths (repo-relative) matching `filter`, ignoring `.git`. */
async function listWorkdirFiles(filter: (filepath: string) => boolean): Promise<string[]> {
  const entries: (string | undefined)[] = await git.walk({
    fs,
    dir: REPO_DIR,
    trees: [WORKDIR()],
    map: async (filepath, [entry]) => {
      if (!entry) return
      if (filepath.startsWith(".git")) return
      if ((await entry.type()) !== "blob") return
      if (!filter(filepath)) return
      return filepath
    },
  })
  return entries.filter((filepath): filepath is string => typeof filepath === "string")
}

export async function gitPush(user: GitHubUser) {
  const options: Parameters<typeof git.push>[0] = {
    fs,
    http,
    dir: REPO_DIR,
    corsProxy: CORS_PROXY,
    onMessage: (message) => console.debug("onMessage", message),
    onProgress: (progress) => console.debug("onProgress", progress),
    onAuth: authFor(user),
  }

  return withGitLock(async () => {
    await ensureFreshToken()
    const stopTimer = startTimer("git push")
    try {
      await withAuthRetry(() => git.push(options))
    } finally {
      stopTimer()
    }
  })
}

export async function gitAdd(filePaths: string[]) {
  const options: Parameters<typeof git.add>[0] = {
    fs,
    dir: REPO_DIR,
    filepath: filePaths,
  }

  const stopTimer = startTimer(`git add ${filePaths.join(" ")}`)
  await git.add(options)
  stopTimer()
}

export async function gitRemove(filePath: string) {
  const options: Parameters<typeof git.remove>[0] = {
    fs,
    dir: REPO_DIR,
    filepath: filePath,
  }

  const stopTimer = startTimer(`git remove ${filePath}`)
  await git.remove(options)
  stopTimer()
}

export async function gitCommit(message: string) {
  const options: Parameters<typeof git.commit>[0] = {
    fs,
    dir: REPO_DIR,
    message,
  }

  const stopTimer = startTimer(`git commit -m "${message}"`)
  await git.commit(options)
  stopTimer()
}

/**
 * True when any of `filePaths` has staged changes relative to HEAD — i.e. a
 * commit would not be empty. Scoped to the given paths for speed.
 */
export async function gitHasStagedChanges(filePaths: string[]) {
  if (filePaths.length === 0) return false

  const stopTimer = startTimer(`git status ${filePaths.join(" ")}`)
  const matrix = await git.statusMatrix({ fs, dir: REPO_DIR, filepaths: filePaths })
  stopTimer()

  return hasStagedChanges(matrix)
}

/** Check if the repo is synced with the remote origin */
export async function isRepoSynced() {
  const latestLocalCommit = await git.resolveRef({
    fs,
    dir: REPO_DIR,
    ref: `refs/heads/${DEFAULT_BRANCH}`,
  })

  const latestRemoteCommit = await git.resolveRef({
    fs,
    dir: REPO_DIR,
    ref: `refs/remotes/origin/${DEFAULT_BRANCH}`,
  })

  const isSynced = latestLocalCommit === latestRemoteCommit

  return isSynced
}

export async function getRemoteOriginUrl() {
  // Check git config for remote origin url
  const remoteOriginUrl = await git.getConfig({
    fs,
    dir: REPO_DIR,
    path: "remote.origin.url",
  })

  return remoteOriginUrl
}
