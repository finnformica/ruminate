import { Searcher } from "fast-fuzzy"
import git, { WORKDIR } from "isomorphic-git"
import { atom } from "jotai"
import { atomWithMachine } from "jotai-xstate"
import { atomWithStorage, selectAtom } from "jotai/utils"
import { assign, createMachine, raise } from "xstate"
import {
  GitHubRepository,
  GitHubUser,
  Note,
  NoteId,
  Template,
  githubUserSchema,
  templateSchema,
} from "./schema"
import { fs, fsWipe } from "./utils/fs"
import { GITHUB_USER_STORAGE_KEY, clearSession, seedSession } from "./utils/github-session"
import {
  MergeNotice,
  REPO_DIR,
  getRemoteOriginUrl,
  gitAdd,
  gitClone,
  gitCommit,
  gitHasStagedChanges,
  gitPull,
  gitPush,
  gitRemove,
  isRepoSynced,
  mergeNoticeKey,
} from "./utils/git"
import { backupUnpushedNotes, restoreUnpushedBackup } from "./utils/local-backup"
import {
  clearMarkdownFilesCache,
  getMarkdownFilesCache,
  setMarkdownFilesCache,
} from "./utils/markdown-cache"
import { withGitLock } from "./utils/mutex"
import { broadcastSynced, isSyncLeader, requestLeaderSync } from "./utils/sync-leader"
import { SyncError, canRetrySync, isPushRejectionError, toSyncError } from "./utils/sync"
import type { BlockRevealRequest, OutlineItem } from "./utils/note-outline"
import { parseNote } from "./utils/parse-note"
import { removeTemplateFrontmatter } from "./utils/remove-template-frontmatter"
import { getSampleMarkdownFiles } from "./utils/sample-markdown-files"
import { startTimer } from "./utils/timer"
import { LEGACY_VIEW_STATE_PATH, VIEW_STATE_DIR } from "./data/paths"

// -----------------------------------------------------------------------------
// State machine
// -----------------------------------------------------------------------------

type Context = {
  githubUser: GitHubUser | null
  githubRepo: GitHubRepository | null
  markdownFiles: Record<string, string>
  error: Error | null
  /** Pull→push attempts in the current sync cycle (bounded by MAX_SYNC_ATTEMPTS). */
  syncAttempts: number
  /** Why the last sync cycle failed (message + coarse category), for the sidebar. */
  syncError: SyncError | null
  /**
   * Conflicting merges resolved by pulls (each pointing at the losing version
   * in git history), accumulated (deduped by note + losing commit) so a
   * follow-up pull can't clear a notice the user hasn't seen. Dismissal is
   * per-tab UI state (`dismissedMergeNoticeIdsAtom`), not machine state.
   */
  mergeNotices: MergeNotice[]
}

type Event =
  | { type: "SIGN_IN"; githubUser: GitHubUser }
  | { type: "SIGN_OUT" }
  | { type: "SELECT_REPO"; githubRepo: GitHubRepository }
  | { type: "SYNC" }
  | { type: "SYNC_DEBOUNCED" }
  // Re-walk the shared worktree into memory without touching the network —
  // sent to follower tabs when the leader broadcasts a finished sync.
  | { type: "REFRESH_FILES" }
  | {
      type: "WRITE_FILES"
      markdownFiles: Record<string, string | null>
      commitMessage?: string
    }
  | { type: "DELETE_FILE"; filepath: string }

function createGlobalStateMachine() {
  return createMachine(
    {
      /** @xstate-layout N4IgpgJg5mDOIC5RQDYHsBGBDFA6ATnGigG4CWAdlAKqxj4DEEaFYulJaA1m6pjgSKlKNOvgQc0AYywAXMiwDaABgC6K1YlAAHNLDLyWWkAA9EAFgDsuABwBmS8qcBWSwEZnygGxu3AGhAAT0QAJhDzXEsvAE5lSxtY6OdfEJsAXzSAvmw8QlhicipaegZ6fDR8XG0UOQAzCoBbXGyBPIKRYvFJGUMKDQ1jXX1e4zMEEPdcaOmvOxCvELt7BwDghDdlaNtHczdwkOc7Nys7DKz0HNx9KFYIAHkAV1kGAGUASQBxADkAfTevgZIEBDAwKCijRBeZxeXDQkKxGzhZz2BKrUJHXAHRx2KEbBLI06ZEAtPDXW5vCivT6-O7UAAqgJ0elBRiBY2c5i2HiiyWiXnizhCaIQ5nCuHMuy8NjcPnM-Ls0TOxIuAjJkApgnywioACUwLomCw2JIeM0VaSyDd1RRNe1dfq0BIKJwemD+mpBsyRmzEABaczOXBeWaihLHaI2Vx2YWWOwRZQBqVeZRuabxEJKklXS3km1tbVQPUGsoVKo1WT1fBNLNqiAa-OFQsOp0uuRutSM4FesEQ8ZWIOC5SHQ5xGzuLzC5EhcXjzxzNzuMeZ83Zq11m0UNCyADC6FurwAogAZA-buk-HUHgAKd07IO9oHZi0xx05CcR0UszmFXn7ouDvjOHyEqxsu-AWmuGpSHuIhFmghqsOwzrcLwK61lBMH2roLbSG2Sgdh6QL3j2PoIPENi2BKOIuAs8LmMKsSBhMHhJAk-52IS5zgauua4NBLCwQ6pT4OUlTVHUjRmtx6E2vxFCCdh3R4X0BGaER3aso+iA2Modi4Hs0LJnKrgxDGbh6Rxw52Mo9iCg4YGXDJfF7pAh4nmeF7XrehFMsMJFaQgdkvhKsTmB+X7Cr4MqRAuSzRCEC4JvMDmqjm1rOUaEB8QAFlgVDGhAKBgAwADqOpvHSB4-AAYm8J4vHeGngqRn64MoqROP+rjSlCkUKtYNnmBxlgShyn7pESNZpeuGW3DleUwOwhXFQAIseB6VTVdUHo1fmaaYiCtUB9gylK5jtUBliRXK07JMGg7ddC5gpRBvFyZA835bgADu+CglQ1VkEVsAIcayGmlNkGyS5WVSLlX2-f9UCA8DOGuvh6g+V2e3NQF0LKG10RLKmuxyjYsyRcOkSzNEC6cjpoqWC9PHpe9sPw4tiPyADQNwMJollhJVZSY500YZln2c393PI7zsBo8p7pqb5LK4wdZFxkG5kKp+exxnElN2IGURLOEsS-u1E1caLUOzR9cMLWwEBgEVMso8VzCISaqHSWL0MSw7X3O67IjuwrvRK56OO9q4BNE7FJkLPYkWIgNsYJVEmzeEOzNOWzktOy7YBu7z-OluJFaSZDb0wwXuDB8Xoe8+H7aY8r2Oq72sYRBszh95Y47eCn-YhDZsxLAqGxuFbyq+7b+ewIEFBSFcDxSFIcAgy8ACaXzbrtnekR4ek6eEewRvEST0UE6Lmfp1l8sBTi00zk1oX7dtZYvy+r+vm+vLvbcPw1oACFaR7wPCtA+D51ajzcJEDkiwgIJjhEOYUYRkRtTmCmcy3gvyIlzh-BeS8V4lkYDvPe0D-Lqw5JiU+PgOQmzxN+G+CAjjxFhFYICCoozSkIfPWu39SEiQqAAvewCDxgOoBAqBWNiL7TGAGSiDhPBODUU4CcrCjjzExLTYM+iDHOH4TXCWQj65gAwGgB4y8RBiP3nIpqXc5h0OSHCFhaxFi7EiLpPYnJpj+KMW-OeJi5pmOdpY6xUhbEUKAaA8B25IFUIUdpSw04pRhD0QY-k6DR4wg5KdLJ-JjGs0ESQ8xESbFUAYCYWAsg5BsCwLUWQ9AAAUGwnAAEoGDVxKaYsp4SrGVKgEktWYx4gRAHhdRwY4EhRHQQqCIY5AnW1SgIvpP9tAPBQCgWxnswacAhu-NZoSymbO2SIFuGMRm9hiIGOIA8cRhWfjYGw6CFjwOhPYdq08IzFJmsQjZWydlVLIYLSuwsen-NKYC85VBLkqTblHQ+AUGG4FNpyPxY5fxXVYQcTBDg5j7AOMNP54sTkwuBVABg1zSKykxJM+Y4QsVWHQckCi08Uxxl8MGbwyzZ42xCR9MxmzYDZV2UaJCByfYCt6eSleIqxVwqUhHVSSKYFjOhITVJUpoRJDxOg6InJMQ6vJmOVMY5X4rNerKoVpyHiitsaCiulZqxHMFV-O1DqlXIXRgimlKKnCwn5BMWY9hGLRHQS8wMrhkQCiWFCKwpL-ZyqqPaxVVL-XqzpRMRwjKwpRBZbimwQ1772DjeTRhSbP5XDKXDMAUguAiBeHU2Q9rQaSpQiLVZ7qa0-zrQ2ptLb7XwsjupaOpFPDTjmIKRY-J3DuMQNg6chq-HHAStKBcVaAUr37Y2qgza5Btr2R2w5wSbUer7dlete6oAHtbfLZVrdFBuHbvI0Z2kdHT3eYiHwi4I1aNHsukKtNRTT18Ja-l3bz29p3Vegd+6h0gydeWF1XbrVQvWbB69g7D0Pp9YrVVY7kXq1SYGWmOlXCD00WsOYkxclm12NrLwW7oVYfg7exDdjM1jCSHk1J8wpSOE2HyYU1k+6RE5CNC2PhDUscwzlbDCHcN2IkVImR3HDqatcQsBdbC9gwnhAUwpgSiSbmdvAIEJI1XULGL6BcWwdjWWTPohm0ZWG+jSfCWNrgyaCjlMzBsHQxDWeSWwiI85iYhvarGJIwpi3bATL44lxwRp-MeLIEL77AoKnFMkSZcwuELAYhEMIUIFg62YsWpNmXex2YxI57OLmExubWJyPSVgZRDTJnsdwVbAtYTQDV0iHn4Hcr7pPemUZJyRlhIy9w869bPSCTKmam4dwwyG3jHLRxkxwksgW6bcdxxdalD1twcn5IDc2+rIaWwhyIlSB+cy5McVrHGUGaZYVrJluY8tqDGHbjXds-YbxQ1GvBlc5Fc1kQdKT2OLMvlkKyX2w5mAIHfojag6c94CHzXIqpAM7D2m8PPyI7ddBwOi0yDLXR+sacXmYgKg4kcJIr3EDHA2FMXShr5QfiWBdlHjsfrSybsDWnUY2ocvcP1Ma1H2cEph9z3wYVScC-ZkLhuJciri8mHFSMAmEoOH8KwmUrhqYcQzqbImM8kfJttcvWnvprJTHjl+JIs6EgtdCL4O7kpClFL++h5HF6V6wDXhvWAFmVbqsXRRVIuwUQJTCGOa+HiDgUV0nA3B-Ipxq5g7gMhtOFxtW8Iic6VhZgbDZ2ws+mIhzBkcL+F5yVA8swB-bleAzIkiFpyNaNco+QKh5XL8YEwKLFoDL4Jz+CMyt7zqx1NsKoC97lJEDiF8WfJBsqy7wtgq9EsOPZOfRCF8Kp70RmPZFRSwh6gGS+5NYtFs1nf+Kl1Z0Qdt9Wsxu6cP3t76mcUYlCMaYZ7QUUTGyCyLFNMPuY4EzNIIAA */
      id: "global",
      tsTypes: {} as import("./global-state.typegen").Typegen0,
      schema: {} as {
        context: Context
        events: Event
        services: {
          resolveUser: {
            data: { githubUser: GitHubUser }
          }
          resolveRepo: {
            data: {
              githubRepo: GitHubRepository
              markdownFiles: Record<string, string>
            }
          }
          cloneRepo: {
            data: { markdownFiles: Record<string, string> }
          }
          pull: {
            data: { markdownFiles: Record<string, string>; mergeNotices: MergeNotice[] }
          }
          push: {
            data: void
          }
          checkStatus: {
            data: { isSynced: boolean }
          }
          refreshFiles: {
            data: { markdownFiles: Record<string, string> }
          }
          writeFiles: {
            data: { committed: boolean }
          }
          deleteFile: {
            data: void
          }
        }
      },
      predictableActionArguments: true,
      initial: "resolvingUser",
      context: {
        githubUser: null,
        githubRepo: null,
        markdownFiles: {},
        error: null,
        syncAttempts: 0,
        syncError: null,
        mergeNotices: [],
      },
      states: {
        resolvingUser: {
          invoke: {
            src: "resolveUser",
            onDone: {
              target: "signedIn",
              actions: ["setGitHubUser", "setGitHubUserLocalStorage"],
            },
            onError: "signedOut",
          },
        },
        signedOut: {
          entry: [
            "clearGitHubUser",
            "clearGitHubUserLocalStorage",
            "clearMarkdownFilesLocalStorage",
            "clearFileSystem",
            "setSampleMarkdownFiles",
          ],
          exit: ["clearMarkdownFiles"],
          on: {
            SIGN_IN: {
              target: "signedIn",
              actions: ["setGitHubUser", "setGitHubUserLocalStorage"],
            },
          },
        },
        signedIn: {
          on: {
            SIGN_OUT: "signedOut",
          },
          initial: "resolvingRepo",
          states: {
            resolvingRepo: {
              invoke: {
                src: "resolveRepo",
                onDone: {
                  target: "cloned",
                  actions: ["setGitHubRepo", "setMarkdownFiles", "setMarkdownFilesLocalStorage"],
                },
                onError: "notCloned",
              },
            },
            notCloned: {
              on: {
                SELECT_REPO: "cloningRepo",
              },
            },
            cloningRepo: {
              entry: ["setGitHubRepo", "clearMarkdownFiles", "clearMarkdownFilesLocalStorage"],
              invoke: {
                src: "cloneRepo",
                onDone: {
                  target: "cloned.sync.success",
                  // Schedule a sync right after the clone so any restored
                  // conflicted-copy notes (see `restoreUnpushedBackup`) reach
                  // GitHub instead of sitting local-only.
                  actions: [
                    "setMarkdownFiles",
                    "setMarkdownFilesLocalStorage",
                    raise("SYNC_DEBOUNCED"),
                  ],
                },
                onError: {
                  target: "notCloned",
                  actions: ["clearGitHubRepo", "setError"],
                },
              },
            },
            cloned: {
              entry: "logUser",
              on: {
                SELECT_REPO: "cloningRepo",
              },
              type: "parallel",
              states: {
                change: {
                  initial: "idle",
                  states: {
                    idle: {
                      on: {
                        WRITE_FILES: "writingFiles",
                        DELETE_FILE: "deletingFile",
                      },
                    },
                    writingFiles: {
                      entry: ["mergeMarkdownFiles", "mergeMarkdownFilesLocalStorage"],
                      invoke: {
                        src: "writeFiles",
                        onDone: [
                          // Only kick off a sync when a commit actually
                          // happened — a no-op write (e.g. unchanged content)
                          // must not schedule a pull/push cycle.
                          {
                            target: "idle",
                            cond: "didCommit",
                            actions: raise("SYNC_DEBOUNCED"),
                          },
                          { target: "idle" },
                        ],
                        onError: {
                          target: "idle",
                          actions: "setError",
                        },
                      },
                    },
                    deletingFile: {
                      entry: ["deleteMarkdownFile", "deleteMarkdownFileLocalStorage"],
                      invoke: {
                        src: "deleteFile",
                        onDone: {
                          target: "idle",
                          actions: raise("SYNC_DEBOUNCED"),
                        },
                        onError: {
                          target: "idle",
                          actions: "setError",
                        },
                      },
                    },
                  },
                },
                sync: {
                  initial: "pulling",
                  states: {
                    success: {
                      entry: "resetSyncAttempts",
                      on: {
                        SYNC: "pulling",
                        SYNC_DEBOUNCED: "debouncing",
                        REFRESH_FILES: "refreshing",
                      },
                    },
                    error: {
                      entry: ["setSyncError", "logError", "resetSyncAttempts"],
                      on: {
                        SYNC: "pulling",
                        SYNC_DEBOUNCED: "debouncing",
                        REFRESH_FILES: "refreshing",
                      },
                    },
                    // Follower tabs land here when the leader tab finishes a
                    // sync: re-walk the shared worktree into memory (and the
                    // localStorage cache) without any network work.
                    refreshing: {
                      invoke: {
                        src: "refreshFiles",
                        onDone: {
                          target: "success",
                          actions: ["setMarkdownFiles", "setMarkdownFilesLocalStorage"],
                        },
                        onError: "success",
                      },
                    },
                    debouncing: {
                      entry: "resetSyncAttempts",
                      after: {
                        1000: "pulling",
                      },
                      on: {
                        SYNC: "pulling",
                        SYNC_DEBOUNCED: "debouncing",
                      },
                    },
                    pulling: {
                      always: [
                        // Don't pull if offline
                        { target: "success", cond: "isOffline" },
                      ],
                      invoke: {
                        src: "pull",
                        onDone: {
                          target: "pushing",
                          actions: [
                            "setMarkdownFiles",
                            "setMarkdownFilesLocalStorage",
                            "setMergeNotices",
                          ],
                        },
                        onError: "error",
                      },
                    },
                    pushing: {
                      always: [
                        // Don't push if offline
                        { target: "success", cond: "isOffline" },
                      ],
                      invoke: {
                        src: "push",
                        onDone: "checkingStatus",
                        onError: [
                          // A rejected push (someone else pushed first) is
                          // fixed by pulling again — bounded per sync cycle so
                          // a persistent rejection can't loop forever. Network
                          // and auth errors fall through to the error state.
                          {
                            target: "pulling",
                            cond: "shouldRetryPush",
                            actions: "incrementSyncAttempts",
                          },
                          { target: "error" },
                        ],
                      },
                    },
                    checkingStatus: {
                      on: {
                        SYNC: "pulling",
                        SYNC_DEBOUNCED: "debouncing",
                      },
                      invoke: {
                        src: "checkStatus",
                        onDone: [
                          {
                            target: "success",
                            cond: "isSynced",
                            // Tell follower tabs to refresh from the worktree
                            // (no-op unless this tab is the sync leader).
                            actions: "broadcastSynced",
                          },
                          // If not synced, pull again — bounded by the same
                          // per-cycle attempt budget as push retries.
                          {
                            target: "pulling",
                            cond: "canRetrySync",
                            actions: "incrementSyncAttempts",
                          },
                          { target: "error" },
                        ],
                        onError: "error",
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    {
      guards: {
        isOffline: () => !navigator.onLine,
        isSynced: (_, event) => event.data.isSynced,
        didCommit: (_, event) => event.data.committed,
        canRetrySync: (context) => canRetrySync(context.syncAttempts),
        shouldRetryPush: (context, event) =>
          canRetrySync(context.syncAttempts) && isPushRejectionError(event.data),
      },
      services: {
        resolveUser: async () => {
          // First, check URL params for user metadata
          const searchParams = new URLSearchParams(window.location.search)
          const token = searchParams.get("user_token")
          const id = searchParams.get("user_id")
          const login = searchParams.get("user_login")
          const name = searchParams.get("user_name")
          const email = searchParams.get("user_email")
          // Only treat these as set when actually present and finite (a missing
          // param is null → Number(null) is 0, which would look like "expired").
          const toEpoch = (raw: string | null) => {
            const n = raw != null ? Number(raw) : NaN
            return Number.isFinite(n) ? n : undefined
          }
          const accessExpires = toEpoch(searchParams.get("access_expires"))
          const refreshExpires = toEpoch(searchParams.get("refresh_expires"))

          if (token && login && name && email) {
            const idNumberRaw = id ? Number(id) : undefined
            const idNumber = Number.isFinite(idNumberRaw) ? idNumberRaw : undefined

            // Remove the auth metadata from the URL without a full reload
            // (window.location.replace would reload and race the localStorage
            // write below). replaceState keeps the SPA state intact.
            searchParams.delete("user_token")
            searchParams.delete("user_id")
            searchParams.delete("user_login")
            searchParams.delete("user_name")
            searchParams.delete("user_email")
            searchParams.delete("access_expires")
            searchParams.delete("refresh_expires")

            window.history.replaceState(
              null,
              "",
              `${window.location.pathname}${
                searchParams.toString() ? `?${searchParams.toString()}` : ""
              }`,
            )

            return {
              githubUser: {
                token,
                id: idNumber,
                login,
                name,
                email,
                accessTokenExpiresAt: accessExpires,
                refreshTokenExpiresAt: refreshExpires,
              },
            }
          }

          // Next, check localStorage for user metadata
          const githubUser = JSON.parse(localStorage.getItem(GITHUB_USER_STORAGE_KEY) ?? "null")
          return { githubUser: githubUserSchema.parse(githubUser) }
        },
        resolveRepo: async () => {
          const stopTimer = startTimer("resolveRepo()")

          const remoteOriginUrl = await getRemoteOriginUrl()

          // Remove https://github.com/ from the beginning of the URL to get the repo name
          const repo = String(remoteOriginUrl).replace(/^https:\/\/github.com\//, "")

          const [owner, name] = repo.split("/")

          if (!owner || !name) {
            throw new Error("Invalid repo")
          }

          const githubRepo = { owner, name }

          // The localStorage cache is a load-time optimization only; when it
          // is absent (never written, or cleared after a quota failure) the
          // worktree walk is the source of truth.
          const markdownFiles = getMarkdownFilesCache() ?? (await getMarkdownFilesFromFs(REPO_DIR))

          stopTimer()

          return { githubRepo, markdownFiles }
        },
        cloneRepo: async (context, event) => {
          if (!context.githubUser) throw new Error("Not signed in")

          // The clone wipes the browser filesystem. Stash any unpushed work
          // first, and restore it as conflicted-copy notes afterwards, so
          // neither "Reset local copy" nor changing the repo can silently
          // lose local-only changes. Both are best-effort and never block.
          await backupUnpushedNotes()

          await gitClone(event.githubRepo, context.githubUser)

          await restoreUnpushedBackup()

          return {
            markdownFiles: await getMarkdownFilesFromFs(REPO_DIR),
          }
        },
        pull: async (context) => {
          if (!context.githubUser) throw new Error("Not signed in")

          // Follower tabs never touch the network: the leader tab pulls into
          // the shared worktree; re-walking it is enough to stay current.
          let mergeNotices: MergeNotice[] = []
          if (isSyncLeader()) {
            mergeNotices = await gitPull(context.githubUser, context.githubRepo)
          }

          return {
            markdownFiles: await getMarkdownFilesFromFs(REPO_DIR),
            mergeNotices,
          }
        },
        push: async (context) => {
          if (!context.githubUser) throw new Error("Not signed in")

          // Follower tabs forward the push (their commits are already in the
          // shared worktree) to the leader instead of racing it.
          if (!isSyncLeader()) {
            requestLeaderSync()
            return
          }

          await gitPush(context.githubUser)
        },
        checkStatus: async () => {
          // Followers treat the cycle as converged — the leader does the real
          // check (and re-pull loop) after the forwarded sync.
          if (!isSyncLeader()) return { isSynced: true }

          return { isSynced: await isRepoSynced() }
        },
        refreshFiles: async () => {
          return {
            markdownFiles: await getMarkdownFilesFromFs(REPO_DIR),
          }
        },
        writeFiles: async (context, event) => {
          if (!context.githubUser) throw new Error("Not signed in")

          // The whole write→stage→commit path holds the git lock so a commit
          // can never land in the middle of a pull/push (and vice versa).
          return withGitLock(async () => {
            const entries = Object.entries(event.markdownFiles)
            const filesToWrite = entries.filter(([, content]) => content !== null)
            const filesToDelete = entries.filter(([, content]) => content === null)
            const fileList = entries.map(([filepath]) => filepath)
            const commitMessage = event.commitMessage ?? `Update ${fileList.join(" ") || "notes"}`

            // Write files to file system
            for (const [filepath, content] of filesToWrite) {
              if (content === null) continue

              // Create directories if needed
              const dirPath = filepath.split("/").slice(0, -1).join("/")
              if (dirPath) {
                let currentPath = REPO_DIR
                const segments = dirPath.split("/")

                for (const segment of segments) {
                  currentPath = `${currentPath}/${segment}`
                  const stats = await fs.promises.stat(currentPath).catch(() => null)
                  const exists = stats !== null
                  if (!exists) {
                    await fs.promises.mkdir(currentPath)
                  }
                }
              }

              // Write file
              await fs.promises.writeFile(`${REPO_DIR}/${filepath}`, content, "utf8")
            }

            // Delete files from file system
            for (const [filepath] of filesToDelete) {
              await fs.promises.unlink(`${REPO_DIR}/${filepath}`).catch(() => null)
            }

            // Stage files
            const filesToAdd = filesToWrite.map(([filepath]) => filepath)
            if (filesToAdd.length > 0) {
              await gitAdd(filesToAdd)
            }

            for (const [filepath] of filesToDelete) {
              try {
                await gitRemove(filepath)
              } catch {
                // Ignore if the file isn't tracked
              }
            }

            // Commit files — but skip the commit entirely when nothing is
            // actually staged (e.g. content identical to HEAD), so no-op
            // writes never produce empty commits or sync cycles.
            const committed = await gitHasStagedChanges(fileList)
            if (committed) {
              await gitCommit(commitMessage)
            }

            return { committed }
          })
        },
        deleteFile: async (context, event) => {
          if (!context.githubUser) throw new Error("Not signed in")

          const { filepath } = event

          await withGitLock(async () => {
            // Delete file from file system
            await fs.promises.unlink(`${REPO_DIR}/${filepath}`)

            // Stage deletion
            await gitRemove(filepath)

            // Commit deletion
            await gitCommit(`Delete ${filepath}`)
          })
        },
      },
      actions: {
        setGitHubUser: assign({
          githubUser: (_, event) => {
            switch (event.type) {
              case "SIGN_IN":
                return event.githubUser
              case "done.invoke.global.resolvingUser:invocation[0]":
                return event.data.githubUser
              default:
                return null
            }
          },
        }),
        setGitHubUserLocalStorage: (_, event) => {
          switch (event.type) {
            case "SIGN_IN":
              localStorage.setItem(GITHUB_USER_STORAGE_KEY, JSON.stringify(event.githubUser))
              // Seed the live token session used for git auth + refresh.
              seedSession(event.githubUser)
              break
            case "done.invoke.global.resolvingUser:invocation[0]":
              localStorage.setItem(GITHUB_USER_STORAGE_KEY, JSON.stringify(event.data.githubUser))
              seedSession(event.data.githubUser)
              break
          }
        },
        clearGitHubUser: assign({
          githubUser: null,
        }),
        clearGitHubUserLocalStorage: () => {
          localStorage.removeItem(GITHUB_USER_STORAGE_KEY)
          clearSession()
        },
        setGitHubRepo: assign({
          githubRepo: (_, event) => {
            switch (event.type) {
              case "SELECT_REPO":
                return event.githubRepo
              case "done.invoke.global.signedIn.resolvingRepo:invocation[0]":
                return event.data.githubRepo
            }
          },
        }),
        clearGitHubRepo: assign({
          githubRepo: null,
        }),
        clearFileSystem: () => {
          fsWipe()
        },
        setMarkdownFiles: assign({
          markdownFiles: (_, event) => event.data.markdownFiles,
        }),
        setSampleMarkdownFiles: assign({
          markdownFiles: getSampleMarkdownFiles(),
        }),
        setMarkdownFilesLocalStorage: (_, event) => {
          setMarkdownFilesCache(event.data.markdownFiles)
        },
        mergeMarkdownFiles: assign({
          markdownFiles: (context, event) => {
            const merged = { ...context.markdownFiles }
            for (const [filepath, content] of Object.entries(event.markdownFiles)) {
              if (content === null) {
                delete merged[filepath]
              } else {
                merged[filepath] = content
              }
            }
            return merged
          },
        }),
        mergeMarkdownFilesLocalStorage: (context, event) => {
          const merged = { ...context.markdownFiles }
          for (const [filepath, content] of Object.entries(event.markdownFiles)) {
            if (content === null) {
              delete merged[filepath]
            } else {
              merged[filepath] = content
            }
          }
          setMarkdownFilesCache(merged)
        },
        deleteMarkdownFile: assign({
          markdownFiles: (context, event) => {
            const { [event.filepath]: _, ...markdownFiles } = context.markdownFiles
            return markdownFiles
          },
        }),
        deleteMarkdownFileLocalStorage: (context, event) => {
          const { [event.filepath]: _, ...markdownFiles } = context.markdownFiles
          setMarkdownFilesCache(markdownFiles)
        },
        clearMarkdownFiles: assign({
          markdownFiles: {},
        }),
        clearMarkdownFilesLocalStorage: () => {
          clearMarkdownFilesCache()
        },
        setError: assign({
          // TODO: Remove `as Error`
          error: (_, event) => event.data as Error,
        }),
        incrementSyncAttempts: assign({
          syncAttempts: (context) => context.syncAttempts + 1,
        }),
        resetSyncAttempts: assign({
          syncAttempts: 0,
        }),
        setSyncError: assign({
          syncError: (_, event) => toSyncError((event as { data?: unknown }).data),
        }),
        setMergeNotices: assign({
          // Accumulate rather than replace: pulls run constantly, and a later
          // conflict-free pull must not clear a notice the user hasn't seen.
          // Deduped by note + losing commit (`mergeNoticeKey`) so a notice can
          // never be raised twice.
          mergeNotices: (context, event) => {
            const incoming = event.data.mergeNotices
            if (incoming.length === 0) return context.mergeNotices
            const known = new Set(context.mergeNotices.map(mergeNoticeKey))
            return [
              ...context.mergeNotices,
              ...incoming.filter((notice) => !known.has(mergeNoticeKey(notice))),
            ]
          },
        }),
        broadcastSynced: () => {
          broadcastSynced()
        },
        logError: (_, event) => {
          console.error(event.data)
        },
        // Analytics logging was removed with the Supabase backend. The action
        // is kept as a no-op so the generated XState typegen stays consistent.
        logUser: () => {},
      },
    },
  )
}

/** Walk the file system and return the contents of all markdown files */
async function getMarkdownFilesFromFs(dir: string) {
  const stopTimer = startTimer("getMarkdownFilesFromFs()")

  const entries = await git.walk({
    fs,
    dir,
    trees: [WORKDIR()],
    map: async (filepath, [entry]) => {
      if (!entry) return null

      // Ignore .git directory
      if (filepath.startsWith(".git")) return

      // Keep markdown notes and the view-state sidecars (per-note files plus
      // the legacy single file, still read for migration); ignore the rest.
      if (
        !filepath.endsWith(".md") &&
        filepath !== LEGACY_VIEW_STATE_PATH &&
        !filepath.startsWith(`${VIEW_STATE_DIR}/`)
      )
        return

      // Get file content
      const content = await entry.content()

      if (!content) return null

      console.debug(filepath, (await entry.stat()).size)

      return [filepath, new TextDecoder().decode(content)]
    },
  })

  const markdownFiles = Object.fromEntries(entries)

  stopTimer()

  return markdownFiles
}

export const globalStateMachineAtom = atomWithMachine(createGlobalStateMachine)

export const markdownFilesAtom = selectAtom(
  globalStateMachineAtom,
  (state) => state.context.markdownFiles,
)

export const isRepoNotClonedAtom = selectAtom(globalStateMachineAtom, (state) =>
  state.matches("signedIn.notCloned"),
)

export const isCloningRepoAtom = selectAtom(globalStateMachineAtom, (state) =>
  state.matches("signedIn.cloningRepo"),
)

export const isRepoClonedAtom = selectAtom(globalStateMachineAtom, (state) =>
  state.matches("signedIn.cloned"),
)

export const isSignedOutAtom = selectAtom(globalStateMachineAtom, (state) =>
  state.matches("signedOut"),
)

/** The last sync failure (message + coarse category); only meaningful while
 * the sync region is in its error state (see `sync-status.tsx`). */
export const syncErrorAtom = selectAtom(globalStateMachineAtom, (state) => state.context.syncError)

/** Conflicting merges resolved by pulls (see `Context.mergeNotices`). */
export const mergeNoticesAtom = selectAtom(
  globalStateMachineAtom,
  (state) => state.context.mergeNotices,
)

/**
 * Keys (`mergeNoticeKey`) of merge notices the user has dismissed (per-tab,
 * not persisted). The banner shows `mergeNoticesAtom` minus these; because the
 * machine dedupes notices by the same key, a dismissed notice can never be
 * re-raised.
 */
export const dismissedMergeNoticeIdsAtom = atom<string[]>([])

// -----------------------------------------------------------------------------
// GitHub
// -----------------------------------------------------------------------------

export const githubUserAtom = selectAtom(
  globalStateMachineAtom,
  (state) => state.context.githubUser,
)

export const githubRepoAtom = selectAtom(
  globalStateMachineAtom,
  (state) => state.context.githubRepo,
)

// -----------------------------------------------------------------------------
// Notes
// -----------------------------------------------------------------------------

export const notesAtom = atom((get) => {
  const markdownFiles = get(markdownFilesAtom)
  const notes: Map<NoteId, Note> = new Map()

  // Parse notes. Non-`.md` tracked files (e.g. the view-state sidecar) are not
  // notes and are skipped here.
  for (const filepath in markdownFiles) {
    if (!filepath.endsWith(".md")) continue
    const id = filepath.replace(/\.md$/, "")
    const content = markdownFiles[filepath]
    notes.set(id, parseNote(id, content))
  }

  // Derive backlinks
  for (const { id: sourceId, links } of notes.values()) {
    for (const targetId of links) {
      const backlinks = notes.get(targetId)?.backlinks
      // Skip if the source note is already a backlink
      if (backlinks?.includes(sourceId)) continue

      // Skip if the source note is linking to itself
      if (targetId === sourceId) continue

      backlinks?.push(sourceId)
    }
  }

  return notes
})

export const backlinksIndexAtom = atom((get) => {
  const notes = get(notesAtom)
  const index: Map<NoteId, NoteId[]> = new Map()

  for (const note of notes.values()) {
    if (note.links.length === 0) continue
    const uniqueTargets = new Set(note.links)
    for (const targetId of uniqueTargets) {
      if (targetId === note.id) continue
      const backlinks = index.get(targetId)
      if (backlinks) {
        backlinks.push(note.id)
      } else {
        index.set(targetId, [note.id])
      }
    }
  }

  return index
})

export const sortedNotesAtom = atom((get) => {
  const notes = get(notesAtom)

  // Sort notes by updatedAt in descending order (most recent first)
  return [...notes.values()].sort((a, b) => {
    // Pinned notes first
    if (a.pinned && !b.pinned) return -1
    if (!a.pinned && b.pinned) return 1

    // Then by updatedAt descending (most recent first)
    // Notes without updatedAt (null) sort to bottom
    if (a.updatedAt !== null && b.updatedAt !== null) {
      if (a.updatedAt !== b.updatedAt) {
        return b.updatedAt - a.updatedAt
      }
    } else if (a.updatedAt !== null) {
      return -1 // a has timestamp, b doesn't -> a first
    } else if (b.updatedAt !== null) {
      return 1 // b has timestamp, a doesn't -> b first
    }

    // Fallback: favor numeric IDs (like timestamps) over non-numeric
    const aNumeric = /^\d+$/.test(a.id)
    const bNumeric = /^\d+$/.test(b.id)
    if (aNumeric && !bNumeric) return -1
    if (!aNumeric && bNumeric) return 1

    return b.id.localeCompare(a.id)
  })
})

export const pinnedNotesAtom = atom((get) => {
  const sortedNotes = get(sortedNotesAtom)
  return sortedNotes.filter((note) => note.pinned)
})

export const noteSearcherAtom = atom((get) => {
  const sortedNotes = get(sortedNotesAtom)
  return new Searcher(sortedNotes, {
    keySelector: (note) => [note.title, note.displayName, note.content, note.id, note.alias || ""],
    threshold: 0.8,
  })
})

// -----------------------------------------------------------------------------
// Tags
// -----------------------------------------------------------------------------

const tagsAtom = atom((get) => {
  const notes = get(notesAtom)
  const tags: Record<string, NoteId[]> = {}

  for (const note of notes.values()) {
    for (const tag of note.tags) {
      // If the tag doesn't exist, create it
      if (!tags[tag]) tags[tag] = []
      // If the note isn't already linked to the tag, link it
      if (!tags[tag].includes(note.id)) tags[tag].push(note.id)
    }
  }

  return tags
})

export const sortedTagEntriesAtom = atom((get) => {
  const tags = get(tagsAtom)
  // Sort tags alphabetically in ascending order
  return Object.entries(tags).sort((a, b) => {
    return a[0].localeCompare(b[0])
  })
})

export const tagSearcherAtom = atom((get) => {
  const sortedTagEntries = get(sortedTagEntriesAtom)
  return new Searcher(sortedTagEntries, {
    keySelector: ([tag]) => tag,
    threshold: 0.8,
  })
})

// -----------------------------------------------------------------------------
// Templates
// -----------------------------------------------------------------------------

const templatesAtom = atom((get) => {
  const notes = get(notesAtom)
  const templates: Record<string, Template> = {}

  for (const { id, content, frontmatter } of notes.values()) {
    const template = frontmatter["template"]

    // Skip if note isn't a template
    if (!template) continue

    try {
      const parsedTemplate = templateSchema.omit({ body: true }).parse(template)

      const body = removeTemplateFrontmatter(content)

      templates[id] = { ...parsedTemplate, body }
    } catch (error) {
      // Template frontmatter didn't match the schema
      console.error(error)
    }
  }

  return templates
})

export const dailyTemplateAtom = selectAtom(templatesAtom, (templates) =>
  Object.values(templates).find((t) => t.name.match(/^daily$/i)),
)

export const weeklyTemplateAtom = selectAtom(templatesAtom, (templates) =>
  Object.values(templates).find((t) => t.name.match(/^weekly$/i)),
)

// -----------------------------------------------------------------------------
// UI state
// -----------------------------------------------------------------------------

/**
 * The user-selectable accent color. Each value maps to a Radix ramp remapped
 * onto the `--accent-*` token family via `[data-accent]` blocks in
 * src/styles/variables.css. "cyan" is the default and needs no attribute.
 */
export type AccentColor = "cyan" | "neutral" | "green" | "violet" | "amber"

export const accentAtom = atomWithStorage<AccentColor>("accent", "cyan")

export const sidebarAtom = atomWithStorage<"expanded" | "collapsed">("sidebar", "expanded")

/** Grid/list layout for note lists, persisted locally (not in the URL). */
export const noteListViewAtom = atomWithStorage<"grid" | "list">("note-list-view", "list")

export const isHelpPanelOpenAtom = atomWithStorage<boolean>("help-panel", false)

/**
 * The live outline (heading blocks) of the note open in the block editor,
 * published by `BlockNoteEditor` on every doc change and read by the command
 * palette's outline mode (⌘P). Null when no editable note is mounted. The
 * palette must check `noteId` against the current route — a stale outline
 * never navigates a different note.
 */
export const noteOutlineAtom = atom<{ noteId: string; items: OutlineItem[] } | null>(null)

/**
 * The outline palette's channel to the block editor: preview (highlight +
 * scroll behind the dialog), commit (Enter), or cancel (restore what the
 * first preview captured). See `BlockRevealRequest` in utils/note-outline.
 */
export const blockRevealAtom = atom<BlockRevealRequest | null>(null)

export const calendarLayoutAtom = atomWithStorage<"week" | "month">("calendar-layout", "week")
