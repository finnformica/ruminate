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
//   3. every `note_id` / `block_id` argument must be inside the grant's view,
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
import { isBlockType, type BlockDoc, type BlockProps } from "../../src/blocks/types"
import { PAGE_TYPE, propsJson, sortKeyBetween } from "../../src/data/graph"
import {
  deleteBlockOps,
  deletePageOps,
  deleteSubtreeOps,
  docToOps,
  type Op,
} from "../../src/data/ops"
import { isDatePageId } from "../../src/data/page-identity"
import type { TenantDb } from "../tenancy-db"
import { allows, mayCreateNotes, type Grant, type Permission } from "./grant"
import {
  applyOpsToReplica,
  childLinksOf,
  childrenOf,
  docOf,
  markdownOf,
  nodeOf,
  noteOf,
  notesReaching,
  notesReachingUnscoped,
  pageOf,
  parentsOf,
  propsOf,
  scopedGraph,
  sees,
  unassignedOf,
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

/** `depth`: how many outline levels to return. 0 = unlimited, which is what
 * an omitted value means to `blocksOfNote`. */
const optionalDepth = (args: Record<string, unknown>): number => {
  const value = args.depth
  if (value === undefined || value === null) return 0
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new BadArgument("`depth` must be a positive integer.")
  }
  return value
}

/** A 0-based position among a parent's children. Omitted = the end. */
const optionalIndex = (args: Record<string, unknown>, key = "index"): number | undefined => {
  const value = args[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new BadArgument(`\`${key}\` must be a whole number, 0 or more.`)
  }
  return value
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

const BLOCK_OUT_OF_SCOPE =
  "No such block, or this token is not scoped to the note it belongs to. " +
  "Call `list_notes`, then `read_note`, to find block ids this token can reach."

const preview = (text: string, words = 20): string => {
  const parts = text.trim().split(/\s+/).filter(Boolean)
  return parts.length > words ? `${parts.slice(0, words).join(" ")}…` : parts.join(" ")
}

/** A metadata object argument: an object, or nothing. */
const optionalProps = (args: Record<string, unknown>, key: string): BlockProps | undefined => {
  const value = args[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new BadArgument(`\`${key}\` must be an object.`)
  }
  return value as BlockProps
}

/**
 * The fourth refusal, and the one only the write tools need.
 *
 * The same block can hang in several notes, so changing it changes what each
 * of them shows. For an unrestricted grant that is simply the feature. For a
 * NOTE-SCOPED grant it is a way out: editing a block that a note outside the
 * scope also holds would put a write where the grant does not reach, and
 * neither the agent nor the person reading the grant would see it happen.
 *
 * So a scoped grant may only write a block every one of whose notes it names.
 * The refusal says a note it cannot see holds the block, and not which one —
 * the check must not become a way to enumerate notes the grant excludes.
 */
function sharedOutsideScope(context: ToolContext, blockId: string): ToolOutcome | null {
  const scope = context.grant.noteIds
  if (scope === null) return null
  const outside = notesReachingUnscoped(context.graph, blockId).filter((id) => !scope.has(id))
  if (outside.length === 0) return null
  return {
    ok: false,
    message:
      `${blockId} also appears in a note this token is not scoped to, so changing ` +
      `it would change that note too. Ask for a token covering both notes, or edit a ` +
      `block that only this note holds.`,
  }
}

/** The checks `link_block` and `move_block` share: both ends visible, not a
 * self-link, and the block writable under this grant. */
function linkable(context: ToolContext, parentId: string, blockId: string): ToolOutcome | null {
  const { graph } = context
  if (nodeOf(graph, parentId) === null || nodeOf(graph, blockId) === null) {
    return { ok: false, message: BLOCK_OUT_OF_SCOPE }
  }
  if (parentId === blockId) {
    return { ok: false, message: "A block cannot be put under itself." }
  }
  if (nodeOf(graph, blockId)?.type === PAGE_TYPE) {
    return { ok: false, message: `${blockId} is a note; a note cannot be linked under a block.` }
  }
  return sharedOutsideScope(context, blockId)
}

/**
 * The sort key for inserting at `index` among a parent's children — a
 * fractional index strictly between its new neighbours, so the siblings
 * either side keep the keys they have and no other row is written.
 *
 * `moving` is excluded from the neighbour calculation: when a block is being
 * repositioned under a parent it already sits under, its own current key must
 * not become one of the bounds, or the "between" would be between the block
 * and itself.
 */
function keyAt(
  graph: ScopedGraph,
  parentId: string,
  index: number | undefined,
  moving: string,
): string {
  const siblings = childLinksOf(graph, parentId).filter((link) => link.destination_id !== moving)
  const at = index === undefined ? siblings.length : Math.min(index, siblings.length)
  const before = at > 0 ? siblings[at - 1].sort_key : null
  const after = at < siblings.length ? siblings[at].sort_key : null
  return sortKeyBetween(before, after)
}

/**
 * One block, as the API hands it out: **the stored row**, not a rendering of
 * it. `type` is the stored type (`ul`, `h1`, `todo`…), `text` is marker-free
 * as stored, and `props` is the row's own metadata object.
 *
 * Nothing here is markdown. Markdown is an INPUT format in this API —
 * `create_note` and `append_to_note` parse it — and never an output one. A
 * block read is a row, so an agent editing one names the block by id and
 * changes a field, rather than round-tripping a document and hoping the
 * diff lands where it meant.
 *
 * Empty fields are omitted rather than sent as `null`/`[]`. That is not
 * tidiness: a JSON row is already heavier per block than the markdown line
 * it replaces (~60 chars against ~36 once the id is a field rather than an
 * `id::` line), and `"props":null,"childIds":[]` on 281 blocks is pure
 * context spent saying nothing.
 */
const blockOut = (graph: ScopedGraph, id: string, extra: Record<string, unknown> = {}) => {
  const row = nodeOf(graph, id)
  if (!row) return null
  const props = propsOf(graph, id)
  const childIds = childrenOf(graph, id)
  return {
    id: row.id,
    type: row.type,
    text: row.text,
    ...(props && Object.keys(props).length > 0 ? { props } : {}),
    ...(childIds.length > 0 ? { childIds } : {}),
    // The note the block was written in — where it shows if nothing links to
    // it any more. Absent for pages and for rows older than migration 0006.
    ...(row.notes_id === undefined ? {} : { writtenInNoteId: row.notes_id }),
    updatedAt: row.updated_at,
    ...extra,
  }
}

/**
 * A note's blocks in document order, each carrying its `depth`, down to
 * `maxDepth` levels (0 = unlimited).
 *
 * A block whose children were cut off is marked `hasMoreChildren`, so the
 * agent knows exactly where to call `list_children` and never has to guess
 * whether it has the whole picture. Depth-limiting is safe here only because
 * reads are rows: there is no partial *document* an agent could hand back to
 * a whole-note write and silently orphan the rest of the note with.
 *
 * A block reached twice (the same block under two parents, which the graph
 * allows) is listed once, at its first depth, and named again in the other
 * parent's `childIds`.
 */
function blocksOfNote(
  graph: ScopedGraph,
  rootIds: string[],
  maxDepth: number,
): { blocks: Record<string, unknown>[]; truncated: boolean } {
  const blocks: Record<string, unknown>[] = []
  const seen = new Set<string>()
  let truncated = false

  const walk = (ids: string[], depth: number) => {
    for (const id of ids) {
      if (seen.has(id)) continue
      seen.add(id)
      const children = childrenOf(graph, id)
      const cut = maxDepth > 0 && depth + 1 >= maxDepth && children.length > 0
      if (cut) truncated = true
      const block = blockOut(graph, id, {
        depth,
        ...(cut ? { hasMoreChildren: true } : {}),
      })
      if (!block) continue
      blocks.push(block)
      if (!cut) walk(children, depth + 1)
    }
  }
  walk(rootIds, 0)
  return { blocks, truncated }
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
      "A note and its blocks, as stored: every block's id, type, text, metadata " +
      "and children, in outline order with its depth. NOT markdown — this is the " +
      "row data, so to change a block you name it by id with `update_block` " +
      "rather than rewriting the note. Large notes are expensive to read whole: " +
      "`blockCount` tells you how big it is, and `depth` reads only the top " +
      "levels (a block whose children were cut off is marked `hasMoreChildren`, " +
      "so walk into it with `list_children`). Also returns the note's " +
      "`unassigned` blocks: ones written in it that nothing links to any more, " +
      "which the app shows in a section at the foot of the note.",
    permission: "read",
    annotations: readOnly,
    inputSchema: {
      type: "object",
      properties: {
        note_id: { type: "string", description: "From `list_notes` or `search`." },
        depth: {
          type: "integer",
          minimum: 1,
          description: "How many levels of the outline to return. Omit for the whole note.",
        },
      },
      required: ["note_id"],
      additionalProperties: false,
    },
    run(args, { graph }) {
      const noteId = requireString(args, "note_id")
      const note = noteOf(graph, noteId)
      if (!note) return { ok: false, message: OUT_OF_SCOPE }
      const depth = optionalDepth(args)

      const rootBlockIds = childrenOf(graph, noteId)
      const { blocks, truncated } = blocksOfNote(graph, rootBlockIds, depth)
      // The whole note's size, whatever `depth` returned — so an agent that
      // truncated knows how much it has not seen.
      const blockCount = blocksOfNote(graph, rootBlockIds, 0).blocks.length
      const basket = unassignedOf(graph, noteId)
      const unassigned = blocksOfNote(graph, basket?.roots ?? [], depth).blocks

      return {
        ok: true,
        data: {
          id: note.id,
          title: note.displayName,
          type: note.type,
          tags: note.tags,
          props: note.props,
          updatedAt: note.updatedAt,
          rootBlockIds,
          blocks,
          blockCount,
          truncated,
          unassigned,
        },
        text:
          `${note.displayName} — ${blockCount} block(s)` +
          (truncated ? ` (showing ${blocks.length} to depth ${depth})` : "") +
          (unassigned.length > 0 ? `, ${unassigned.length} unassigned` : ""),
      }
    },
  },

  {
    name: "get_block",
    title: "Get a block",
    description:
      "One block by id, as stored: type, text, metadata, its children, the " +
      "blocks that hold it, and the notes it appears in. A note id works too " +
      "(a note is a block whose type is `page`). The starting point for walking " +
      "the graph with `list_children` and `list_parents`.",
    permission: "read",
    annotations: readOnly,
    inputSchema: {
      type: "object",
      properties: { block_id: { type: "string", description: "A block id, or a note id." } },
      required: ["block_id"],
      additionalProperties: false,
    },
    run(args, { graph }) {
      const id = requireString(args, "block_id")
      const block = blockOut(graph, id)
      if (!block) return { ok: false, message: BLOCK_OUT_OF_SCOPE }

      const data = {
        ...block,
        parentIds: parentsOf(graph, id),
        noteIds: notesReaching(graph, id),
        isNote: block.type === PAGE_TYPE,
      }
      return {
        ok: true,
        data,
        text:
          `${data.id} (${data.type})\n${data.text}\n\n` +
          `children: ${block.childIds?.length ?? 0}, parents: ${data.parentIds.length}, ` +
          `in notes: ${data.noteIds.join(", ") || "none"}`,
      }
    },
  },

  {
    name: "list_children",
    title: "List a block's children",
    description:
      "The blocks directly beneath this one, in outline order, as stored. Pass " +
      "a note id for the note's top-level blocks. Walk down by calling this " +
      "again with a child's id, or pass `depth` to pull several levels at once " +
      "(each block carries its `depth`, and one whose children were cut off is " +
      "marked `hasMoreChildren`). Reading a big note a branch at a time this " +
      "way costs far less than `read_note` on the whole thing.",
    permission: "read",
    annotations: readOnly,
    inputSchema: {
      type: "object",
      properties: {
        block_id: { type: "string", description: "A block id, or a note id." },
        depth: {
          type: "integer",
          minimum: 1,
          description: "Levels to return. 1 (the default) is the direct children only.",
        },
        limit: { type: "integer", minimum: 1, maximum: MAX_LIMIT, description: "Default 50." },
      },
      required: ["block_id"],
      additionalProperties: false,
    },
    run(args, { graph }) {
      const id = requireString(args, "block_id")
      const limit = limitOf(args)
      const depth = optionalDepth(args) || 1
      if (nodeOf(graph, id) === null) return { ok: false, message: BLOCK_OUT_OF_SCOPE }

      const direct = childrenOf(graph, id)
      const walked = blocksOfNote(graph, direct, depth)
      const children = walked.blocks.slice(0, limit)

      return {
        ok: true,
        data: {
          blockId: id,
          children,
          total: walked.blocks.length,
          directChildCount: direct.length,
          truncated: walked.truncated || walked.blocks.length > limit,
        },
        text:
          children.length === 0
            ? "No children."
            : children
                .map(
                  (child) =>
                    `${"  ".repeat(Number(child.depth) || 0)}${child.id} (${child.type})  ` +
                    preview(String(child.text), 14),
                )
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
      properties: { block_id: { type: "string", description: "A block id or a note id." } },
      required: ["block_id"],
      additionalProperties: false,
    },
    run(args, { graph }) {
      const id = requireString(args, "block_id")
      if (nodeOf(graph, id) === null) return { ok: false, message: BLOCK_OUT_OF_SCOPE }

      const parents = parentsOf(graph, id)
        .map((parentId) => blockOut(graph, parentId))
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
      "REPLACE a note's whole body with fresh markdown, and optionally retitle " +
      "it. Every block currently in the note that this markdown does not " +
      "recreate stops being part of it and moves to the note's Unassigned " +
      "section (nothing is deleted, but the note is emptied of it). Reach for " +
      "this only to rewrite a note wholesale. To change a block, use " +
      "`update_block`; to restructure, `move_block`; to add, `append_to_note`. " +
      "Those name blocks by id and leave the rest of the note alone.",
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
    name: "update_block",
    title: "Edit a block",
    description:
      "Change one block's text, type or metadata, in place. The cheap way to " +
      "edit: name the block by id and send only what changes, instead of " +
      "rewriting the whole note. The block keeps its id and stays in every note " +
      "that holds it — which also means an edit shows up in all of them. " +
      "Types: text, h1, h2, h3, todo, done, ul, ol, quote, code, image.",
    permission: "write",
    annotations: writes,
    inputSchema: {
      type: "object",
      properties: {
        block_id: { type: "string" },
        text: { type: "string", description: "The block's new text, without any markdown marker." },
        type: {
          type: "string",
          enum: ["text", "h1", "h2", "h3", "todo", "done", "ul", "ol", "quote", "code", "image"],
          description: "Tick a to-do by setting `done`; untick it with `todo`.",
        },
        props: {
          type: "object",
          description: "Replaces the block's metadata object outright. Omit to leave it alone.",
        },
      },
      required: ["block_id"],
      additionalProperties: false,
    },
    async run(args, context) {
      const { graph } = context
      const id = requireString(args, "block_id")
      const text = optionalString(args, "text")
      const type = optionalString(args, "type")
      const props = optionalProps(args, "props")

      const row = nodeOf(graph, id)
      if (!row) return { ok: false, message: BLOCK_OUT_OF_SCOPE }
      if (row.type === PAGE_TYPE) {
        return {
          ok: false,
          message: `${id} is a note, not a block. Retitle it with \`update_note\`.`,
        }
      }
      if (text === undefined && type === undefined && props === undefined) {
        return { ok: false, message: "Give at least one of `text`, `type` or `props` to change." }
      }
      if (type !== undefined && !isBlockType(type)) {
        return { ok: false, message: `Unknown block type: ${type}.` }
      }
      const refusal = sharedOutsideScope(context, id)
      if (refusal) return refusal

      const ops: Op[] = []
      if (text !== undefined && text !== row.text) ops.push({ op: "setText", id, text })
      if (type !== undefined && type !== row.type) ops.push({ op: "setType", id, type })
      if (props !== undefined) {
        const next = propsJson(props)
        if (next !== row.props) ops.push({ op: "setProps", id, props: next })
      }
      const written = await applyOpsToReplica(context.tenant, graph.snapshot, ops, context.now)
      return {
        ok: true,
        data: { blockId: id, changed: ops.length, rowsWritten: written.nodes + written.links },
        text: ops.length === 0 ? `${id} already said that.` : `Updated ${id}.`,
      }
    },
  },

  {
    name: "link_block",
    title: "Put a block under another",
    description:
      "Link an existing block beneath a parent, at `index` (0-based; omit for " +
      "the end). Pass a note id as the parent for a top-level row. This does " +
      "not copy the block: it makes the SAME block appear in a second place, so " +
      "editing it either place changes both. That is how a block ends up in two " +
      "notes. Use `move_block` to relocate one rather than linking then unlinking.",
    permission: "write",
    annotations: writes,
    inputSchema: {
      type: "object",
      properties: {
        parent_id: { type: "string", description: "A block id, or a note id for a top-level row." },
        block_id: { type: "string", description: "The block to put there." },
        index: { type: "integer", minimum: 0, description: "0-based. Omit to append at the end." },
      },
      required: ["parent_id", "block_id"],
      additionalProperties: false,
    },
    async run(args, context) {
      const parentId = requireString(args, "parent_id")
      const blockId = requireString(args, "block_id")
      const index = optionalIndex(args)

      const refusal = linkable(context, parentId, blockId)
      if (refusal) return refusal

      const ops: Op[] = [
        {
          op: "link",
          source: parentId,
          destination: blockId,
          sortKey: keyAt(context.graph, parentId, index, blockId),
        },
      ]
      const written = await applyOpsToReplica(
        context.tenant,
        context.graph.snapshot,
        ops,
        context.now,
      )
      return {
        ok: true,
        data: { parentId, blockId, rowsWritten: written.nodes + written.links },
        text: `Linked ${blockId} under ${parentId}.`,
      }
    },
  },

  {
    name: "unlink_block",
    title: "Take a block out of one place",
    description:
      "Remove a block from under one parent. The block is NOT deleted: if that " +
      "was the only place it appeared, it goes to its note's Unassigned section " +
      "(see `read_note`), with everything beneath it, where it can be linked " +
      "back. If it also appears elsewhere, it simply stays there. To delete a " +
      "block for good, use `delete_block`.",
    permission: "write",
    annotations: writes,
    inputSchema: {
      type: "object",
      properties: {
        parent_id: { type: "string", description: "The block or note it is currently under." },
        block_id: { type: "string" },
      },
      required: ["parent_id", "block_id"],
      additionalProperties: false,
    },
    async run(args, context) {
      const parentId = requireString(args, "parent_id")
      const blockId = requireString(args, "block_id")

      if (nodeOf(context.graph, parentId) === null || nodeOf(context.graph, blockId) === null) {
        return { ok: false, message: BLOCK_OUT_OF_SCOPE }
      }
      if (!childrenOf(context.graph, parentId).includes(blockId)) {
        return { ok: false, message: `${blockId} is not directly under ${parentId}.` }
      }
      const refusal = sharedOutsideScope(context, blockId)
      if (refusal) return refusal

      const ops: Op[] = [{ op: "unlink", source: parentId, destination: blockId }]
      const written = await applyOpsToReplica(
        context.tenant,
        context.graph.snapshot,
        ops,
        context.now,
      )
      const orphaned = parentsOf(context.graph, blockId).length <= 1
      return {
        ok: true,
        data: { parentId, blockId, orphaned, rowsWritten: written.nodes + written.links },
        text: orphaned
          ? `Unlinked ${blockId}; it is now in its note's Unassigned section.`
          : `Unlinked ${blockId} from ${parentId}; it still appears elsewhere.`,
      }
    },
  },

  {
    name: "move_block",
    title: "Move a block",
    description:
      "Move a block from one parent to another, or to a different position " +
      "under the same parent, in one step. Give `from_parent_id` when the block " +
      "appears in more than one place, so it is clear which occurrence moves.",
    permission: "write",
    annotations: writes,
    inputSchema: {
      type: "object",
      properties: {
        block_id: { type: "string" },
        to_parent_id: { type: "string", description: "A block id, or a note id." },
        from_parent_id: {
          type: "string",
          description: "Required only when the block appears under more than one parent.",
        },
        index: { type: "integer", minimum: 0, description: "0-based. Omit to append at the end." },
      },
      required: ["block_id", "to_parent_id"],
      additionalProperties: false,
    },
    async run(args, context) {
      const blockId = requireString(args, "block_id")
      const toParent = requireString(args, "to_parent_id")
      const fromArg = optionalString(args, "from_parent_id")
      const index = optionalIndex(args)

      const refusal = linkable(context, toParent, blockId)
      if (refusal) return refusal

      const parents = parentsOf(context.graph, blockId)
      let fromParent = fromArg
      if (fromParent === undefined) {
        if (parents.length > 1) {
          return {
            ok: false,
            message:
              `${blockId} appears under ${parents.length} parents ` +
              `(${parents.join(", ")}). Say which one to move with \`from_parent_id\`.`,
          }
        }
        fromParent = parents[0]
      }
      if (fromParent !== undefined && !parents.includes(fromParent)) {
        return { ok: false, message: `${blockId} is not directly under ${fromParent}.` }
      }

      const ops: Op[] = []
      if (fromParent !== undefined && fromParent !== toParent) {
        ops.push({ op: "unlink", source: fromParent, destination: blockId })
      }
      ops.push({
        op: "link",
        source: toParent,
        destination: blockId,
        sortKey: keyAt(context.graph, toParent, index, blockId),
      })
      const written = await applyOpsToReplica(
        context.tenant,
        context.graph.snapshot,
        ops,
        context.now,
      )
      return {
        ok: true,
        data: {
          blockId,
          fromParentId: fromParent ?? null,
          toParentId: toParent,
          rowsWritten: written.nodes + written.links,
        },
        text: `Moved ${blockId} to ${toParent}.`,
      }
    },
  },

  {
    name: "delete_block",
    title: "Delete a block",
    description:
      "Delete a block from everywhere it appears. By default what it held " +
      "survives: its children keep their note and turn up in that note's " +
      "Unassigned section. Pass `with_contents: true` to delete the block and " +
      "everything beneath it that nothing else still holds. To take a block out " +
      "of one place without deleting it, use `unlink_block`.",
    permission: "delete",
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      properties: {
        block_id: { type: "string" },
        with_contents: {
          type: "boolean",
          description: "Also delete everything beneath it that nothing else holds.",
        },
      },
      required: ["block_id"],
      additionalProperties: false,
    },
    async run(args, context) {
      const blockId = requireString(args, "block_id")
      const withContents = args.with_contents === true

      const row = nodeOf(context.graph, blockId)
      if (!row) return { ok: false, message: BLOCK_OUT_OF_SCOPE }
      if (row.type === PAGE_TYPE) {
        return { ok: false, message: `${blockId} is a note. Delete it with \`delete_note\`.` }
      }
      const refusal = sharedOutsideScope(context, blockId)
      if (refusal) return refusal

      const ops = withContents
        ? deleteSubtreeOps(blockId, context.graph.snapshot)
        : deleteBlockOps(blockId, context.graph.snapshot)
      const deleted = ops.filter((op) => op.op === "delete").length
      const written = await applyOpsToReplica(
        context.tenant,
        context.graph.snapshot,
        ops,
        context.now,
      )
      return {
        ok: true,
        data: { blockId, deleted, rowsWritten: written.nodes + written.links },
        text:
          deleted <= 1
            ? `Deleted ${blockId}.`
            : `Deleted ${blockId} and ${deleted - 1} block(s) beneath it.`,
      }
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
