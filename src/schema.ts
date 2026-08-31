import { z } from "zod"

export type NoteId = string

export type NoteType = "note" | "daily" | "weekly" | "template"

export type Task = {
  completed: boolean
  text: string
  tags: string[]
  priority: 1 | 2 | 3 | null
  /** The character offset where the task starts in the content (for position-based updates) */
  startOffset: number
}

export type Note = {
  /**
   * The note's stable, opaque identity — a minted `blk_` id
   * (docs/page-identity-design.md). It never changes, so links and URLs to a
   * note survive every rename. Daily and weekly notes are the exception and
   * keep their date ids (`2026-08-31`, `2026-W35`), where the date IS the
   * identity. Not a name: use `displayName` to show a note to a human.
   */
  id: NoteId
  /** The content of the markdown file */
  content: string

  // ↓ Parsed from the content

  /** The type of the note */
  type: NoteType
  /** Depending on the type, either the title, template name, or the date */
  displayName: string
  /** The frontmatter of the markdown file */
  frontmatter: Record<string, unknown>
  /**
   * The note's title: the projection-owned `title:` frontmatter key (which
   * carries the page node's `text` through the `<id>.md` seam), falling back
   * to an h1 in the content (e.g. `# title`).
   */
  title: string
  /** If the title contains a link (e.g. `# [title](url)`), we use that as the url */
  url: string | null
  /** The alias to use when linking to this note, from alias frontmatter */
  alias: string | null
  /**
   * Former ids of this note, from `aliases` frontmatter. Recorded on rename so
   * old note URLs redirect to the live note instead of opening an empty editor.
   */
  aliases: NoteId[]
  /** If the note is pinned */
  pinned: boolean
  /** When the note was last updated (from `updated_at` frontmatter), null if not set */
  updatedAt: number | null
  /** The dates this note references (frontmatter date properties, e.g. a birthday) */
  dates: string[]
  tags: string[]
  /** The tasks in the note (e.g. `- [ ] Do laundry` → `{ completed: false, text: "Do laundry" }`) */
  tasks: Task[]
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

const templateInputSchema = z.object({
  type: z.literal("string"),
  required: z.boolean().optional(),
  default: z.string().optional(),
  description: z.string().optional(),
})

export const templateSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  inputs: z.record(z.string(), templateInputSchema).optional(),
  body: z.string(),
})

export type Template = z.infer<typeof templateSchema>

export const fontSchema = z.enum(["sans", "serif", "handwriting"])

export type TaskWithNote = Task & {
  note: Note
}

export const widthSchema = z.enum(["fixed", "full"])

export type Width = z.infer<typeof widthSchema>
