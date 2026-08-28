import git from "isomorphic-git"
import { fs } from "../utils/fs"
import { REPO_DIR } from "../utils/git"
import { GitHistoryApi, createNoteHistory } from "../utils/note-history"

/**
 * The real `GitHistoryApi`: read-only isomorphic-git operations over the
 * lightning-fs repo. Like the other read paths (`isRepoSynced`,
 * `getRemoteOriginUrl` in utils/git.ts), these don't take the git lock —
 * reads are safe against the object store, and a concurrent sync simply
 * moves HEAD, which the page cache keys on.
 */
const api: GitHistoryApi = {
  resolveHead: () => git.resolveRef({ fs, dir: REPO_DIR, ref: "HEAD" }),

  async readCommit(sha) {
    const { commit } = await git.readCommit({ fs, dir: REPO_DIR, oid: sha })
    return { parents: commit.parent, timestamp: commit.committer.timestamp }
  },

  async resolveFileOid(sha, filepath) {
    // Resolve the file's *oid* (not its content) by reading the containing
    // tree — comparing oids is how the walk skips commits that didn't touch
    // this file, without ever inflating blobs.
    const segments = filepath.split("/")
    const basename = segments.pop()
    const dirPath = segments.join("/")
    try {
      const { tree } = await git.readTree({
        fs,
        dir: REPO_DIR,
        oid: sha,
        filepath: dirPath || undefined,
      })
      const entry = tree.find((e) => e.path === basename && e.type === "blob")
      return entry?.oid ?? null
    } catch {
      // The path (or a parent directory) doesn't exist in this commit.
      return null
    }
  },

  async readBlobText(oid) {
    const { blob } = await git.readBlob({ fs, dir: REPO_DIR, oid })
    return new TextDecoder().decode(blob)
  },
}

export const { listNoteVersions, readNoteVersion } = createNoteHistory(api)
