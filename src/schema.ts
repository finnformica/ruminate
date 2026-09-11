import { z } from "zod"

export type NoteId = string

type NoteType = "note" | "daily" | "weekly"

/** A heading block: its level (its outline depth, from 1) and text. */
export type Heading = { level: number; text: string }

export type Task = {
  /** The `todo`/`done` block this task is. */
  blockId: string
  completed: boolean
  text: string
  tags: string[]
  priority: 1 | 2 | 3 | null
}

/**
 * What the app knows about a page, read off the graph
 * (`src/data/note-meta.ts`): the page node's text and props, and the blocks
 * it reaches. Never markdown — the rollup is an export (`rollup`), not a
 * field.
 */
export type Note = {
  /**
   * The note's stable, opaque identity — a minted `blk_` id
   * (docs/page-identity-design.md). It never changes, so links and URLs to a
   * note survive every rename. Daily and weekly notes are the exception and
   * keep their date ids (`2026-08-31`, `2026-W35`), where the date IS the
   * identity. Not a name: use `displayName` to show a note to a human.
   */
  id: NoteId
  /** The type of the note */
  type: NoteType
  /** Depending on the type, either the title or the date */
  displayName: string
  /** The page node's props — the note's metadata (pinned, width, font,
   * gist_id, updated_at, tags, dates…), with dates as `Date`s. */
  props: Record<string, unknown>
  /** The page node's text, falling back to the first heading block. */
  title: string
  /** The `url` prop, or the link when the title is one (`[title](url)`). */
  url: string | null
  /** The alias to use when linking to this note, from the `alias` prop */
  alias: string | null
  /** If the note is pinned */
  pinned: boolean
  /** When the note was last updated (the `updated_at` prop), null if not set */
  updatedAt: number | null
  /** The dates this note references (date props, e.g. a birthday) */
  dates: string[]
  tags: string[]
  /** The tasks in the note: its `todo` and `done` blocks. */
  tasks: Task[]
  /** The heading blocks, in document order. */
  headings: Heading[]
  /** The text of every block, in document order — what fuzzy search and
   * previews read. */
  text: string
}

export const githubUserSchema = z.object({
  token: z.string(),
  id: z.number().optional(),
  login: z.string(),
  name: z.string(),
  email: z.string(),
  // Epoch-ms expiries for the short-lived access token and the long-lived
  // refresh token. Non-sensitive (the refresh token itself lives only in an
  // HttpOnly cookie); these drive silent refresh and the session-status UI.
  // Optional so pre-refresh sessions and the dev PAT path still parse.
  accessTokenExpiresAt: z.number().optional(),
  refreshTokenExpiresAt: z.number().optional(),
})

export type GitHubUser = z.infer<typeof githubUserSchema>

export const fontSchema = z.enum(["sans", "serif", "handwriting"])

export const widthSchema = z.enum(["fixed", "full"])

export type Width = z.infer<typeof widthSchema>
