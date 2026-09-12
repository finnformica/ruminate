// The tools: what an agent can do to a corpus, and the one place a grant is
// checked before it does it (docs/mcp-server.md).
//
// ## Shape
//
// Every tool is one `ToolDef`: its schema, the permission it needs, and a
// `run` that receives already-scoped inputs. Dispatch (`callTool`) does the
// three refusals so no `run` can forget them:
//
//   1. the grant must hold the tool's `permission`;
//   2. `create_note` additionally needs an unrestricted grant
//      (`mayCreateNotes` — see grant.ts for why);
//   3. every `note_id` / `node_id` argument must be inside the grant's view,
//      which is enforced by the accessors in `graph-access.ts` returning null
//      for anything outside it.
//
// A tool the grant cannot use is not merely refused — it is not LISTED
// (`toolsFor`), which the spec explicitly allows: the tool set "MAY vary by
// the authorization presented on the request". A read-only agent is never
// told a `delete_note` exists, which is a better answer than tempting a model
// with a verb it will be refused.
//
// ## Two kinds of failure
//
// - A tool that does not exist for this grant is a JSON-RPC error
//   (`-32602`): the model cannot fix it by retrying with other arguments.
// - A tool that exists but cannot do what was asked — no such note, the note
//   is outside the grant, the markdown was empty — is a TOOL EXECUTION error
//   (`isError: true` with a plain-language message), because that is exactly
//   the case the spec says to hand back to the model so it can self-correct.
//
// ## Results
//
// Every result carries both `structuredContent` (the data) and a `text`
// block (a readable rendering of it). No tool declares an `outputSchema`:
// the field is optional, and declaring one makes the server responsible for
// conforming to it forever, which is not a promise worth making for shapes
// this young.

import { blockId } from "../../src/blocks/id"
import { parse } from "../../src/blocks/parse"
import type { BlockDoc, BlockProps } from "../../src/blocks/types"
import { PAGE_TYPE } from "../../src/data/graph"
import { deletePageOps, docToOps } from "../../src/data/ops"
import { isDatePageId } from "../../src/data/page-identity"
import type { TenantDb } from "../tenancy-db"
import { allows, mayCreateNotes, type Grant, type Permission } from "./grant"
import {
  applyOpsToReplica,
  childrenOf,
  docOf,
  markdownOf,
  nodeOf,
  noteOf,
  notesReaching,
  pageOf,
  parentsOf,
  propsOf,
  scopedGraph,
  sees,
  type ScopedGraph,
} from "./graph-access"

/** What a tool hands back. `ok: false` becomes `isError: true`. */
type ToolOutcome = { ok: true; data: unknown; text: string } | { ok: false; message: string }

interface ToolContext {
  grant: Grant
  tenant: TenantDb
  /** The scoped graph, loaded once per call. */
  graph: ScopedGraph
  now: number
}

export interface ToolDef {
  name: string
  title: string
  description: string
  permission: Permission
  /** Only an unrestricted grant may run this tool (see `mayCreateNotes`). */
  needsAllNotes?: boolean
  inputSchema: Record<string, unknown>
  annotations: {
    readOnlyHint: boolean
    destructiveHint: boolean
    idempotentHint: boolean
    openWorldHint: boolean
  }
  run(args: Record<string, unknown>, context: ToolContext): Promise<ToolOutcome> | ToolOutcome
}

// -----------------------------------------------------------------------------
// Argument reading — hand-rolled, like `parseReplicaPayload`, to keep the
// Worker bundle free of a schema library.
// -----------------------------------------------------------------------------

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200
/** Refuse a markdown body larger than this. A note is prose, and a megabyte
 * of it from an agent is a mistake, not a note. */
const MAX_MARKDOWN_BYTES = 256 * 1024

class BadArgument extends Error {}

const requireString = (args: Record<string, unknown>, key: string): string => {
  const value = args[key]
  if (typeof value !== "string" || value.length === 0) {
    throw new BadArgument(`\`${key}\` is required and must be a non-empty string.`)
  }
  return value
}

const optionalString = (args: Record<string, unknown>, key: string): string | undefined => {
  const value = args[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== "string") throw new BadArgument(`\`${key}\` must be a string.`)
  return value
}

const optionalMarkdown = (args: Record<string, unknown>, key: string): string | undefined => {
  const value = optionalString(args, key)
  if (value !== undefined && new TextEncoder().encode(value).length > MAX_MARKDOWN_BYTES) {
    throw new BadArgument(`\`${key}\` is larger than the ${MAX_MARKDOWN_BYTES / 1024}KB limit.`)
  }
  return value
}

const limitOf = (args: Record<string, unknown>): number => {
  const value = args.limit
  if (value === undefined || value === null) return DEFAULT_LIMIT
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new BadArgument("`limit` must be a positive integer.")
  }
  return Math.min(value, MAX_LIMIT)
}

/** The cursor is the offset into the deterministic order the list is in — an
 * opaque digit string, refused rather than guessed at if it is anything else. */
const offsetOf = (args: Record<string, unknown>): number => {
  const value = args.cursor
  if (value === undefined || value === null) return 0
  if (typeof value !== "string" || !/^\d{1,9}$/.test(value)) {
    throw new BadArgument("`cursor` must be a cursor returned by a previous call.")
  }
  return Number(value)
}

// -----------------------------------------------------------------------------
// Shared shapes
// -----------------------------------------------------------------------------

const OUT_OF_SCOPE =
  "No such note, or this token is not scoped to it. Call `list_notes` to see what it can reach."

const NODE_OUT_OF_SCOPE =
  "No such block, or this token is not scoped to the note it belongs to. " +
  "Call `list_notes`, then `read_note`, to find block ids this token can reach."

const preview = (text: string, words = 20): string => {
  const parts = text.trim().split(/\s+/).filter(Boolean)
  return parts.length > words ? `${parts.slice(0, words).join(" ")}…` : parts.join(" ")
}

/** A block, as the traversal tools describe one. */
const describeNode = (graph: ScopedGraph, id: string) => {
  const row = nodeOf(graph, id)
  if (!row) return null
  return {
    id: row.id,
    type: row.type,
    text: row.text,
    props: propsOf(graph, id),
    /** The note the block was written in — where it shows if nothing links
     * to it any more. Absent for pages and for pre-`notes_id` rows. */
    writtenInNoteId: row.notes_id ?? null,
    childCount: childrenOf(graph, id).length,
  }
}

const noteSummary = (graph: ScopedGraph, id: string) => {
  const note = noteOf(graph, id)
  if (!note) return null
  return {
    id: note.id,
    title: note.displayName,
    type: note.type,
    tags: note.tags,
    updatedAt: note.updatedAt,
    taskCount: note.tasks.length,
    openTaskCount: note.tasks.filter((task) => !task.completed).length,
    preview: preview(note.text),
  }
}

/** Notes sorted the way a person would expect a note list: most recently
 * updated first, undated last, id breaking every tie so the order — and
 * therefore the cursor — is stable. */
const byRecency = (
  a: { updatedAt: number | null; id: string },
  b: { updatedAt: number | null; id: string },
) => {
  if (a.updatedAt !== b.updatedAt) {
    if (a.updatedAt === null) return 1
    if (b.updatedAt === null) return -1
    return b.updatedAt - a.updatedAt
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/** Apply a doc edit to a page and persist it. The shared tail of every write
 * tool: one op batch, one atomic push, one summary. */
async function writeDoc(
  context: ToolContext,
  noteId: string,
  doc: BlockDoc,
  verb: string,
): Promise<ToolOutcome> {
  const ops = docToOps(noteId, doc, context.graph.snapshot)
  const written = await applyOpsToReplica(context.tenant, context.graph.snapshot, ops, context.now)
  return {
    ok: true,
    data: { noteId, ops: ops.length, rowsWritten: written.nodes + written.links },
    text: `${verb} note ${noteId} (${ops.length} change${ops.length === 1 ? "" : "s"}).`,
  }
}

/** The page's props with `title` set, cleared, or left alone. Keeps `null`
 * as `null` so an untitled note with no metadata does not gain an empty
 * props object just by being edited. */
function withTitle(props: BlockProps | null, title: string | undefined): BlockProps | null {
  if (title === undefined) return props
  if (title === "") {
    if (props === null) return null
    const { title: _dropped, ...rest } = props
    return Object.keys(rest).length > 0 ? rest : null
  }
  return { ...(props ?? {}), title }
}

// -----------------------------------------------------------------------------
// The tools
// -----------------------------------------------------------------------------

const readOnly = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const

const writes = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const

export const TOOLS: ToolDef[] = [
  {
    name: "list_notes",
    title: "List notes",
    description:
      "List the notes this token can reach, most recently updated first. " +
      "Optionally filter by a word in the title or body (`query`), by `tag`, " +
      "or by `type` (`note`, `daily`, `weekly`). Returns note ids — pass one " +
      "to `read_note`. Page with `cursor` when `nextCursor` comes back.",
    permission: "read",
    annotations: readOnly,
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Match notes whose title or body contains this." },
        tag: {
          type: "string",
          description: "Only notes carrying this tag. Without the leading '#'. Matches sub-tags.",
        },
        type: {
          type: "string",
          enum: ["note", "daily", "weekly"],
          description: "Only notes of this kind.",
        },
        limit: { type: "integer", minimum: 1, maximum: MAX_LIMIT, description: "Default 50." },
        cursor: { type: "string", description: "`nextCursor` from a previous call." },
      },
      additionalProperties: false,
    },
    run(args, { graph }) {
      const query = optionalString(args, "query")?.toLowerCase()
      const tag = optionalString(args, "tag")?.replace(/^#/, "").toLowerCase()
      const type = optionalString(args, "type")
      const limit = limitOf(args)
      const offset = offsetOf(args)

      const matches = graph
        .pages()
        .map((id) => noteSummary(graph, id))
        .filter((note): note is NonNullable<typeof note> => note !== null)
        .filter((note) => type === undefined || note.type === type)
        .filter((note) => tag === undefined || note.tags.some((t) => t.toLowerCase() === tag))
        .filter((note) => {
          if (query === undefined) return true
          return (
            note.title.toLowerCase().includes(query) || note.preview.toLowerCase().includes(query)
          )
        })
        .sort(byRecency)

      const page = matches.slice(offset, offset + limit)
      const nextCursor = offset + limit < matches.length ? String(offset + limit) : null

      return {
        ok: true,
        data: { notes: page, total: matches.length, nextCursor },
        text:
          page.length === 0
            ? "No notes matched."
            : page.map((note) => `${note.id}  ${note.title}`).join("\n") +
              (nextCursor ? `\n\n${matches.length - offset - page.length} more.` : ""),
      }
    },
  },

  {
    name: "search",
    title: "Search blocks",
    description:
      "Find blocks whose text contains `query` (case-insensitive substring, not " +
      "the app's query language). Each hit names the block and the notes it " +
      "appears in, so it is the way to get from a phrase to a note or a block id.",
    permission: "read",
    annotations: readOnly,
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The text to look for." },
        limit: { type: "integer", minimum: 1, maximum: MAX_LIMIT, description: "Default 50." },
      },
      required: ["query"],
      additionalProperties: false,
    },
    run(args, { graph }) {
      const query = requireString(args, "query").toLowerCase()
      const limit = limitOf(args)

      const hits: {
        id: string
        type: string
        text: string
        noteIds: string[]
        noteTitles: string[]
      }[] = []
      // Sorted ids so the result — and therefore any truncation — is the same
      // for the same corpus and query.
      const ids = [...graph.snapshot.nodes.keys()].filter((id) => sees(graph, id)).sort()
      for (const id of ids) {
        const row = graph.snapshot.nodes.get(id)
        if (!row || row.type === PAGE_TYPE) continue
        if (!row.text.toLowerCase().includes(query)) continue
        const noteIds = notesReaching(graph, id)
        hits.push({
          id,
          type: row.type,
          text: row.text,
          noteIds,
          noteTitles: noteIds.map((noteId) => noteOf(graph, noteId)?.displayName ?? noteId),
        })
        if (hits.length >= limit) break
      }

      return {
        ok: true,
        data: { hits, truncated: hits.length >= limit },
        text:
          hits.length === 0
            ? `Nothing matched "${query}".`
            : hits
                .map(
                  (hit) =>
                    `${hit.id}  [${hit.noteTitles.join(", ") || "unassigned"}]  ${preview(hit.text, 14)}`,
                )
                .join("\n"),
      }
    },
  },

  {
    name: "read_note",
    title: "Read a note",
    description:
      "A note in full: its title, tags, metadata, tasks, headings, and its " +
      "markdown. The markdown carries an `id::` line under every block — KEEP " +
      "THEM if you intend to write the note back with `update_note`, because " +
      "they are what lets an edited block stay the same block instead of " +
      "becoming a new one.",
    permission: "read",
    annotations: readOnly,
    inputSchema: {
      type: "object",
      properties: { note_id: { type: "string", description: "From `list_notes` or `search`." } },
      required: ["note_id"],
      additionalProperties: false,
    },
    run(args, { graph }) {
      const noteId = requireString(args, "note_id")
      const note = noteOf(graph, noteId)
      const markdown = markdownOf(graph, noteId)
      if (!note || markdown === null) return { ok: false, message: OUT_OF_SCOPE }

      return {
        ok: true,
        data: {
          id: note.id,
          title: note.displayName,
          type: note.type,
          tags: note.tags,
          props: note.props,
          updatedAt: note.updatedAt,
          headings: note.headings,
          tasks: note.tasks,
          markdown,
          rootBlockIds: childrenOf(graph, noteId),
        },
        text: `# ${note.displayName}\n\n${markdown}`,
      }
    },
  },

  {
    name: "get_node",
    title: "Get a block",
    description:
      "One block (or page) by id: its type, text, metadata, how many children " +
      "it has, which blocks hold it, and which notes it appears in. The " +
      "starting point for walking the graph with `list_children` and `list_parents`.",
    permission: "read",
    annotations: readOnly,
    inputSchema: {
      type: "object",
      properties: { node_id: { type: "string", description: "A block id or a note id." } },
      required: ["node_id"],
      additionalProperties: false,
    },
    run(args, { graph }) {
      const id = requireString(args, "node_id")
      const described = describeNode(graph, id)
      if (!described) return { ok: false, message: NODE_OUT_OF_SCOPE }

      const data = {
        ...described,
        parentIds: parentsOf(graph, id),
        noteIds: notesReaching(graph, id),
        isPage: described.type === PAGE_TYPE,
      }
      return {
        ok: true,
        data,
        text:
          `${data.id} (${data.type})\n${data.text}\n\n` +
          `children: ${data.childCount}, parents: ${data.parentIds.length}, ` +
          `in notes: ${data.noteIds.join(", ") || "none"}`,
      }
    },
  },

  {
    name: "list_children",
    title: "List a block's children",
    description:
      "The blocks directly beneath this one, in outline order. Pass a note id " +
      "to get the note's top-level blocks. Walk down by calling this again " +
      "with a child's id.",
    permission: "read",
    annotations: readOnly,
    inputSchema: {
      type: "object",
      properties: {
        node_id: { type: "string", description: "A block id or a note id." },
        limit: { type: "integer", minimum: 1, maximum: MAX_LIMIT, description: "Default 50." },
      },
      required: ["node_id"],
      additionalProperties: false,
    },
    run(args, { graph }) {
      const id = requireString(args, "node_id")
      const limit = limitOf(args)
      if (nodeOf(graph, id) === null) return { ok: false, message: NODE_OUT_OF_SCOPE }

      const all = childrenOf(graph, id)
      const children = all
        .slice(0, limit)
        .map((childId) => describeNode(graph, childId))
        .filter((child): child is NonNullable<typeof child> => child !== null)

      return {
        ok: true,
        data: { nodeId: id, children, total: all.length },
        text:
          children.length === 0
            ? "No children."
            : children
                .map((child) => `${child.id} (${child.type})  ${preview(child.text, 14)}`)
                .join("\n"),
      }
    },
  },

  {
    name: "list_parents",
    title: "List a block's parents",
    description:
      "The blocks that hold this one, and the notes it appears in. A block can " +
      "sit under several parents at once — that is how the same block shows in " +
      "more than one note. Walk up by calling this again with a parent's id.",
    permission: "read",
    annotations: readOnly,
    inputSchema: {
      type: "object",
      properties: { node_id: { type: "string", description: "A block id or a note id." } },
      required: ["node_id"],
      additionalProperties: false,
    },
    run(args, { graph }) {
      const id = requireString(args, "node_id")
      if (nodeOf(graph, id) === null) return { ok: false, message: NODE_OUT_OF_SCOPE }

      const parents = parentsOf(graph, id)
        .map((parentId) => describeNode(graph, parentId))
        .filter((parent): parent is NonNullable<typeof parent> => parent !== null)
      const noteIds = notesReaching(graph, id)

      return {
        ok: true,
        data: {
          nodeId: id,
          parents,
          noteIds,
          notes: noteIds.map((noteId) => ({
            id: noteId,
            title: noteOf(graph, noteId)?.displayName ?? noteId,
          })),
        },
        text:
          parents.length === 0
            ? `Nothing holds ${id}. It shows in its note's Unassigned basket.`
            : parents
                .map((parent) => `${parent.id} (${parent.type})  ${preview(parent.text, 14)}`)
                .join("\n"),
      }
    },
  },

  {
    name: "list_tags",
    title: "List tags",
    description:
      "Every tag across the notes this token can reach, with how many notes " +
      "carry it. Pass one to `list_notes` as `tag` to see them.",
    permission: "read",
    annotations: readOnly,
    inputSchema: { type: "object", additionalProperties: false },
    run(_args, { graph }) {
      const counts = new Map<string, number>()
      for (const pageId of graph.pages()) {
        for (const tag of noteOf(graph, pageId)?.tags ?? []) {
          counts.set(tag, (counts.get(tag) ?? 0) + 1)
        }
      }
      const tags = [...counts.entries()]
        .map(([tag, noteCount]) => ({ tag, noteCount }))
        .sort((a, b) => b.noteCount - a.noteCount || (a.tag < b.tag ? -1 : 1))

      return {
        ok: true,
        data: { tags },
        text:
          tags.length === 0
            ? "No tags."
            : tags.map((entry) => `#${entry.tag}  ${entry.noteCount}`).join("\n"),
      }
    },
  },

  {
    name: "create_note",
    title: "Create a note",
    description:
      "Make a new note from markdown. `markdown` is an outline: two spaces of " +
      "indent per level, `#` for a heading, `-` for a bullet, `- [ ]` for a " +
      "task. Returns the new note's id. Pass `note_id` as a date " +
      "(`2026-09-12`) or an ISO week (`2026-W37`) to create that day's or " +
      "week's note; otherwise an id is minted.",
    permission: "write",
    needsAllNotes: true,
    annotations: writes,
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "The note's title. Optional." },
        markdown: { type: "string", description: "The note's body as a markdown outline." },
        note_id: {
          type: "string",
          description: "Only for a daily (`YYYY-MM-DD`) or weekly (`YYYY-Www`) note.",
        },
      },
      additionalProperties: false,
    },
    async run(args, context) {
      const { graph } = context
      const title = optionalString(args, "title")
      const markdown = optionalMarkdown(args, "markdown") ?? ""
      const requested = optionalString(args, "note_id")

      if (requested !== undefined && !isDatePageId(requested)) {
        return {
          ok: false,
          message:
            "`note_id` may only be given for a daily (`YYYY-MM-DD`) or weekly " +
            "(`YYYY-Www`) note. Leave it out and an id will be minted.",
        }
      }
      const noteId = requested ?? blockId()
      if (graph.snapshot.nodes.has(noteId)) {
        return {
          ok: false,
          message: `${noteId} already exists — use \`update_note\` or \`append_to_note\`.`,
        }
      }

      const parsed = parse(markdown)
      const doc: BlockDoc = {
        props: title !== undefined && title !== "" ? { title } : null,
        rootBlockIds: parsed.rootBlockIds,
        blocks: parsed.blocks,
      }
      const outcome = await writeDoc(context, noteId, doc, "Created")
      return outcome.ok
        ? {
            ...outcome,
            data: { ...(outcome.data as object), noteId },
            text: `Created note ${noteId}.`,
          }
        : outcome
    },
  },

  {
    name: "update_note",
    title: "Replace a note's content",
    description:
      "Replace a note's body with `markdown`, and optionally retitle it. " +
      "Read the note first and send its markdown back WITH the `id::` lines " +
      "intact: a block whose id you keep is edited in place, and a block whose " +
      "id you drop becomes a new block while the original — if it still holds " +
      "anything — moves to the note's Unassigned basket rather than being " +
      "deleted. To add to a note without rewriting it, use `append_to_note`.",
    permission: "write",
    annotations: writes,
    inputSchema: {
      type: "object",
      properties: {
        note_id: { type: "string" },
        markdown: { type: "string", description: "The note's new body." },
        title: { type: "string", description: "A new title. Omit to keep it; '' to clear it." },
      },
      required: ["note_id", "markdown"],
      additionalProperties: false,
    },
    async run(args, context) {
      const noteId = requireString(args, "note_id")
      const markdown = optionalMarkdown(args, "markdown") ?? ""
      const title = optionalString(args, "title")

      const existing = docOf(context.graph, noteId)
      if (existing === null) return { ok: false, message: OUT_OF_SCOPE }

      const parsed = parse(markdown)
      const doc: BlockDoc = {
        props: withTitle(existing.props, title),
        rootBlockIds: parsed.rootBlockIds,
        blocks: parsed.blocks,
      }
      return writeDoc(context, noteId, doc, "Updated")
    },
  },

  {
    name: "append_to_note",
    title: "Append to a note",
    description:
      "Add `markdown` to the end of a note, leaving everything already in it " +
      "untouched. The safe way to add to a note — nothing existing can be lost, " +
      "and you do not have to read the note first.",
    permission: "write",
    annotations: { ...writes, idempotentHint: false },
    inputSchema: {
      type: "object",
      properties: {
        note_id: { type: "string" },
        markdown: { type: "string", description: "The blocks to add, as a markdown outline." },
      },
      required: ["note_id", "markdown"],
      additionalProperties: false,
    },
    async run(args, context) {
      const noteId = requireString(args, "note_id")
      const markdown = optionalMarkdown(args, "markdown") ?? ""

      const existing = docOf(context.graph, noteId)
      if (existing === null) return { ok: false, message: OUT_OF_SCOPE }
      if (markdown.trim() === "") {
        return { ok: false, message: "`markdown` is empty — there is nothing to append." }
      }

      const added = parse(markdown)
      const doc: BlockDoc = {
        props: existing.props,
        rootBlockIds: [...existing.rootBlockIds, ...added.rootBlockIds],
        blocks: { ...existing.blocks, ...added.blocks },
      }
      return writeDoc(context, noteId, doc, "Appended to")
    },
  },

  {
    name: "delete_note",
    title: "Delete a note",
    description:
      "Delete a note and the blocks only it holds. A block that also appears " +
      "in another note survives there. Nothing is erased from the database — " +
      "deleted rows are kept as tombstones — but the note disappears from the " +
      "app and this tool cannot put it back.",
    permission: "delete",
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      properties: { note_id: { type: "string" } },
      required: ["note_id"],
      additionalProperties: false,
    },
    async run(args, context) {
      const noteId = requireString(args, "note_id")
      if (pageOf(context.graph, noteId) === null) return { ok: false, message: OUT_OF_SCOPE }

      const title = noteOf(context.graph, noteId)?.displayName ?? noteId
      const ops = deletePageOps(noteId, context.graph.snapshot)
      const written = await applyOpsToReplica(
        context.tenant,
        context.graph.snapshot,
        ops,
        context.now,
      )
      return {
        ok: true,
        data: { noteId, deleted: ops.length, rowsWritten: written.nodes + written.links },
        text: `Deleted note ${noteId} ("${title}") and ${ops.length - 1} block(s).`,
      }
    },
  },
]

// -----------------------------------------------------------------------------
// Dispatch
// -----------------------------------------------------------------------------

/** Can this grant use this tool at all? The single predicate behind both
 * `toolsFor` (what is listed) and `callTool` (what runs), so the two can
 * never disagree about which tools exist. */
const grantHasTool = (grant: Grant, tool: ToolDef): boolean =>
  tool.needsAllNotes === true ? mayCreateNotes(grant) : allows(grant, tool.permission)

/** The tools this grant may use, in declaration order (deterministic, as the
 * spec asks, so clients and prompt caches can rely on it). */
export const toolsFor = (grant: Grant): ToolDef[] =>
  TOOLS.filter((tool) => grantHasTool(grant, tool))

export type CallResult =
  | { kind: "result"; outcome: ToolOutcome }
  /** No such tool for this grant — a JSON-RPC error, not a tool error. */
  | { kind: "unknown_tool"; message: string }

/**
 * Run one tool call. The graph is loaded here, once, and handed to the tool
 * already scoped — a tool never sees the tenant's raw snapshot, and never
 * sees the grant's note list either, so there is nothing in a `run` to get
 * the scope check wrong with.
 */
export async function callTool(
  grant: Grant,
  tenant: TenantDb,
  name: string,
  args: Record<string, unknown>,
  now: number = Date.now(),
): Promise<CallResult> {
  const tool = TOOLS.find((candidate) => candidate.name === name)
  if (!tool) return { kind: "unknown_tool", message: `Unknown tool: ${name}` }

  if (!grantHasTool(grant, tool)) {
    // Deliberately specific: the agent cannot fix this, but the PERSON
    // reading the transcript can — by minting a token that allows it.
    const why =
      tool.needsAllNotes === true && allows(grant, tool.permission)
        ? "this token is scoped to specific notes, and creating a note is not one of them"
        : `this token does not have the '${tool.permission}' permission`
    return { kind: "unknown_tool", message: `Tool '${name}' is not available: ${why}.` }
  }

  const graph = await scopedGraph(tenant, grant)
  try {
    return { kind: "result", outcome: await tool.run(args, { grant, tenant, graph, now }) }
  } catch (error) {
    if (error instanceof BadArgument)
      return { kind: "result", outcome: { ok: false, message: error.message } }
    throw error
  }
}
