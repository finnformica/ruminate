import { z } from "zod"

export type NoteId = string

export type NoteType = "note" | "daily" | "weekly" | "template"

export type Task = {
  completed: boolean
  text: string
  links: NoteId[]
  tags: string[]
  date: string | null
  priority: 1 | 2 | 3 | null
  /** The character offset where the task starts in the content (for position-based updates) */
  startOffset: number
}

export type Note = {
  /** The markdown file path without the extension (e.g. `foo/bar.md` → `foo/bar`) */
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
  /** If the markdown file contains an h1 (e.g. `# title`), we use that as the title */
  title: string
  /** If the title contains a link (e.g. `# [title](url)`), we use that as the url */
  url: string | null
  /** The alias to use when linking to this note, from alias frontmatter */
  alias: string | null
  /** If the note is pinned */
  pinned: boolean
  /** When the note was last updated (from `updated_at` frontmatter), null if not set */
  updatedAt: number | null
  /** The ids of all notes that are linked to from this note */
  links: NoteId[]
  dates: string[]
  tags: string[]
  /** The tasks in the note (e.g. `- [ ] Do laundry` → `{ completed: false, text: "Do laundry" }`) */
  tasks: Task[]

  // ↓ Derived from links

  /** The ids of all notes that link to this note */
  backlinks: NoteId[]
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
