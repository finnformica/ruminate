import { Searcher } from "fast-fuzzy"
import { atom } from "jotai"
import { atomWithMachine } from "jotai-xstate"
import { atomWithStorage, selectAtom } from "jotai/utils"
import { assign, createMachine } from "xstate"
import { GitHubUser, Note, NoteId, Template, githubUserSchema, templateSchema } from "./schema"
import { databaseFilesAtom } from "./data/database-mode"
import { GITHUB_USER_STORAGE_KEY, clearSession, seedSession } from "./utils/github-session"
import type { BlockRevealRequest, OutlineItem } from "./utils/note-outline"
import { parseNote } from "./utils/parse-note"
import { removeTemplateFrontmatter } from "./utils/remove-template-frontmatter"
import { getSampleMarkdownFiles } from "./utils/sample-markdown-files"

// -----------------------------------------------------------------------------
// State machine
// -----------------------------------------------------------------------------

/**
 * The auth machine: resolve the GitHub identity at boot, handle sign-in and
 * sign-out, and serve the signed-out sample notes. GitHub is identity only —
 * the note corpus itself lives in the database (docs/graph-storage.md): the
 * local SQL store is the runtime store and D1 behind the Worker is the
 * authoritative cross-device copy, mounted by `useDatabaseMode` whenever a
 * user is signed in.
 */

type Context = {
  githubUser: GitHubUser | null
  /** Signed-out demo content only (path → markdown). The signed-in corpus is
   * served by `databaseFilesAtom` (src/data/database-mode.ts). */
  markdownFiles: Record<string, string>
}

type Event = { type: "SIGN_IN"; githubUser: GitHubUser } | { type: "SIGN_OUT" }

function createGlobalStateMachine() {
  return createMachine(
    {
      id: "global",
      tsTypes: {} as import("./global-state.typegen").Typegen0,
      schema: {} as {
        context: Context
        events: Event
        services: {
          resolveUser: {
            data: { githubUser: GitHubUser }
          }
        }
      },
      predictableActionArguments: true,
      initial: "resolvingUser",
      context: {
        githubUser: null,
        markdownFiles: {},
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
          entry: ["clearGitHubUser", "clearGitHubUserLocalStorage", "setSampleMarkdownFiles"],
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
        },
      },
    },
    {
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
              // Seed the live token session used for Worker API auth + refresh.
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
        setSampleMarkdownFiles: assign({
          markdownFiles: getSampleMarkdownFiles(),
        }),
        clearMarkdownFiles: assign({
          markdownFiles: {},
        }),
      },
    },
  )
}

export const globalStateMachineAtom = atomWithMachine(createGlobalStateMachine)

const machineMarkdownFilesAtom = selectAtom(
  globalStateMachineAtom,
  (state) => state.context.markdownFiles,
)

const machineGithubUserAtom = selectAtom(
  globalStateMachineAtom,
  (state) => state.context.githubUser,
)

/**
 * Signed in — the database-backed note corpus is the active experience: the
 * local SQL store serves the notes and D1 syncs them across devices
 * (docs/graph-storage.md). Signed out, the machine's sample notes render
 * instead. This is also the "notes are ready" gate: the store serves local
 * contents immediately, so there is no loading screen to wait behind.
 */
export const isDatabaseModeAtom = atom((get) => get(machineGithubUserAtom) !== null)

/**
 * The note corpus, in repo-file shape (path → content, notes plus view-state
 * sidecars). Signed in it is synthesized from the local SQL store by
 * `src/data/database-mode.ts`; signed out it is the machine's sample notes.
 * Every consumer above `src/data` reads this atom.
 */
export const markdownFilesAtom = atom((get) =>
  get(isDatabaseModeAtom) ? get(databaseFilesAtom) : get(machineMarkdownFilesAtom),
)

export const isSignedOutAtom = selectAtom(globalStateMachineAtom, (state) =>
  state.matches("signedOut"),
)

// -----------------------------------------------------------------------------
// GitHub
// -----------------------------------------------------------------------------

export const githubUserAtom = machineGithubUserAtom

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
