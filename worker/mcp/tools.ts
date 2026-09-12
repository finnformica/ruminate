// The tools: what an agent can do to a corpus, and the one place a grant is
// checked before it does it (docs/mcp-server.md).
//
// ## Shape
//
// Every tool is one `ToolDef`: its schema, the permission it needs, and a
// `run` that receives already-scoped, already-PARSED inputs. The schema is a
// zod schema and it is the only statement of the tool's contract: the JSON
// Schema an agent reads is derived from it (`z.toJSONSchema`), and the
// arguments a `run` receives are what that same schema returned. There is no
// second, hand-written copy of the shape to drift from the first.
//
// Dispatch (`callTool`) does the three refusals so no `run` can forget them:
//
//   1. the grant must hold the tool's `permission`;
//   2. every `note_id` / `block_id` argument must name something inside the
//      grant's view — enforced by the accessors in `graph-access.ts`, which
//      return null for anything outside it, so a `run` that forgets to check
//      gets null rather than another tenant's row;
//   3. a block a note outside the scope also holds may not be WRITTEN
//      (`sharedOutsideScope`), since the edit would land in that note too.
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
//   is outside the grant, an argument that does not fit the schema — is a
//   TOOL EXECUTION error (`isError: true` with a plain-language message),
//   because that is exactly the case the spec says to hand back to the model
//   so it can self-correct. An argument failure names the field's path
//   (`blocks[1].text`), so a model can fix the one field it got wrong and
//   call again rather than being told the whole call was malformed.
//
// ## Results
//
// Every result carries both `structuredContent` (the data) and a `text`
// block (a readable rendering of it). No tool declares an `outputSchema`:
// the field is optional, and declaring one makes the server responsible for
// conforming to it forever, which is not a promise worth making for shapes
// this young.

import * as z from "zod/mini"
import { BLOCK_TYPES } from "../../src/blocks/types"
import { generateNKeysBetween } from "fractional-indexing"
import { blockId } from "../../src/blocks/id"
import { NOTE_TYPE, propsJson, sortKeyBetween } from "../../src/data/graph"
import { deleteBlockOps, deleteNoteOps, deleteSubtreeOps, type Op } from "../../src/data/ops"
import type { TenantDb } from "../tenancy-db"
import { allows, type Grant, type Permission } from "./grant"
import {
  applyOpsToReplica,
  childLinksOf,
  childrenOf,
  nodeOf,
  noteOf,
  notesReaching,
  notesReachingUnscoped,
  noteNodeOf,
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

interface ToolAnnotations {
  readOnlyHint: boolean
  destructiveHint: boolean
  idempotentHint: boolean
  openWorldHint: boolean
}

export interface ToolDef {
  name: string
  title: string
  description: string
  permission: Permission
  /** Derived from the tool's zod schema — never written by hand. */
  inputSchema: Record<string, unknown>
  annotations: ToolAnnotations
  /** Parse the arguments against the tool's schema, then run it. A schema
   * failure is a tool-execution error, not a thrown one. */
  invoke(args: Record<string, unknown>, context: ToolContext): Promise<ToolOutcome>
}

// -----------------------------------------------------------------------------
// Arguments
// -----------------------------------------------------------------------------
//
// One zod schema per tool, and both halves of the contract come out of it:
// the JSON Schema an agent is shown (`jsonSchemaOf`) and the typed arguments
// a `run` receives (`tool`). `zod/mini` rather than `zod`: measured on this
// Worker, the same schemas cost +15 KiB gzipped against +30 KiB for full zod,
// on a bundle that is deliberately kept small
// (`worker/handlers/replica-payload.ts` parses the replica's hot path by hand
// for the same reason, and still does — this change is the tool layer only).

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200
/** Levels `read_note` returns when `depth` is not given — see `depthArg` for
 * why this is not "all of them". */
const DEFAULT_NOTE_DEPTH = 2

/** A required, non-empty string: an id, or `search`'s query. */
const requiredArg = (description: string) =>
  z
    .string("is required and must be a non-empty string.")
    .check(z.minLength(1, "is required and must be a non-empty string."))
    .register(z.globalRegistry, { description })

/** One optional string. */
const textArg = (description: string) =>
  z.optional(z.string("must be a string.").register(z.globalRegistry, { description }))

/**
 * A page size. Over-large values are CAPPED rather than refused — a model
 * that asks for everything gets `MAX_LIMIT` and a `nextCursor`, which is a
 * better answer than an error it has to guess its way out of. The cap is part
 * of the schema (the pipe clamps; the published `maximum` says so), not a
 * line in some tool's body.
 */
const limitArg = () =>
  z
    .pipe(
      z._default(
        z.int("must be a positive integer.").check(z.gte(1, "must be a positive integer.")),
        DEFAULT_LIMIT,
      ),
      z.transform((value) => Math.min(value, MAX_LIMIT)),
    )
    .register(z.globalRegistry, {
      description: `Default ${DEFAULT_LIMIT}; a larger value is capped at ${MAX_LIMIT}.`,
      maximum: MAX_LIMIT,
    })

/** The cursor is the offset into the deterministic order the list is in — an
 * opaque digit string, refused rather than guessed at if it is anything else. */
const cursorArg = () =>
  z.optional(
    z
      .string("must be a cursor returned by a previous call.")
      .check(z.regex(/^\d{1,9}$/, "must be a cursor returned by a previous call."))
      .register(z.globalRegistry, { description: "`nextCursor` from a previous call." }),
  )

/** The offset a cursor names, or the start of the list. */
const offsetOf = (cursor: string | undefined): number => (cursor === undefined ? 0 : Number(cursor))

/**
 * How many outline levels to return, with `fallback` when it is not given
 * (and, where `least` is 0, `0` meaning unlimited).
 *
 * `read_note` defaults to `DEFAULT_NOTE_DEPTH` rather than the whole note,
 * and that default is the difference between this API being cheap and being
 * expensive. Measured against a real 281-block note: the whole thing is
 * ~13,000 tokens (a row is heavier than the markdown line it replaced — ~60
 * characters against ~36), two levels is ~1,100, and one is ~390. An agent
 * that wanted to know what is in a note pays 3% of the corpus it used to.
 *
 * Truncating is safe to do by default only because reads are rows: there is
 * no partial *document* to hand back to a whole-note write. And it is never
 * silent — `blockCount` is always the note's true size, `truncated` says it
 * happened, and every block whose children were cut carries
 * `hasMoreChildren`, so the agent knows precisely what it has not seen and
 * where to ask. `depth: 0` still reads everything.
 */
const depthArg = (least: 0 | 1, fallback: number, description: string) => {
  const wrong = `must be a whole number, ${least} or more.`
  return z
    ._default(z.int(wrong).check(z.gte(least, wrong)), fallback)
    .register(z.globalRegistry, { description })
}

/** A 0-based position among a parent's children. Omitted = the end. */
const indexArg = () =>
  z.optional(
    z
      .int("must be a whole number, 0 or more.")
      .check(z.gte(0, "must be a whole number, 0 or more."))
      .register(z.globalRegistry, {
        description: "0-based. Omit to append at the end.",
      }),
  )

/** A metadata object argument: whatever keys the caller wants, kept as given
 * (this is the block's own `props`, not something this layer interprets). */
const propsArg = (description: string) =>
  z.optional(
    z.looseObject({}, { error: "must be an object." }).register(z.globalRegistry, { description }),
  )

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

/** The block types a tool may write. `note` is not one of them: a note is
 * made by a person, never by an agent (docs/mcp-server.md), so no tool can
 * mint one by naming the type. */
const WRITABLE_TYPES = BLOCK_TYPES.filter((type) => type !== NOTE_TYPE)

const blockTypeArg = (description: string) =>
  z.optional(
    z
      .enum(WRITABLE_TYPES, {
        error: (issue) => `has an unknown block type ${JSON.stringify(issue.input)}.`,
      })
      .register(z.globalRegistry, { description }),
  )

/**
 * One block to create, as `create_blocks` takes it: `{ text, type?, props?,
 * children? }`, where `children` is the same shape again.
 *
 * The recursion is the getter — zod resolves `children` lazily, so the schema
 * can name itself — and it survives into the JSON Schema an agent reads as a
 * `$ref` back to this `$defs` entry, which is exactly what the hand-written
 * schema said before.
 */
interface NewBlock {
  text: string
  type?: (typeof WRITABLE_TYPES)[number]
  props?: Record<string, unknown>
  children?: NewBlock[]
}

const NewBlockSchema: z.ZodMiniType<NewBlock, NewBlock> = z
  .object(
    {
      text: z
        .string("is required and must be a string.")
        .register(z.globalRegistry, { description: "The block's text, with no markdown marker." }),
      type: blockTypeArg("Defaults to `text`."),
      props: propsArg("Optional metadata for the block."),
      get children() {
        return z.optional(
          z
            .array(NewBlockSchema, "must be an array of blocks.")
            .register(z.globalRegistry, { description: "Blocks nested beneath this one." }),
        )
      },
    },
    { error: "must be an object." },
  )
  .register(z.globalRegistry, { id: "newBlock" })

/** How many blocks one `create_blocks` call may add, counting nested ones. A
 * note is written, not generated; a thousand blocks in one call is a runaway
 * loop rather than an intention. */
const MAX_NEW_BLOCKS = 200

const countBlocks = (blocks: NewBlock[]): number =>
  blocks.reduce((total, block) => total + 1 + countBlocks(block.children ?? []), 0)

// -----------------------------------------------------------------------------
// From one schema to both halves of the contract
// -----------------------------------------------------------------------------

/**
 * The JSON Schema an agent reads, from the schema the tool parses with.
 *
 * `io: "input"` because `inputSchema` describes what a client SENDS: the
 * unclamped `limit` it may pass, not the clamped number a `run` sees.
 */
const jsonSchemaOf = (schema: z.ZodMiniType): Record<string, unknown> => {
  const json = z.toJSONSchema(schema, {
    io: "input",
    override: ({ jsonSchema }) => {
      // `z.int()` carries JavaScript's safe-integer bound. True, and noise in
      // every integer argument of every tool, on every `tools/list`.
      if (jsonSchema.maximum === Number.MAX_SAFE_INTEGER) delete jsonSchema.maximum
      // Input-mode objects say nothing about extra properties, because
      // parsing STRIPS them rather than refusing. Telling an agent not to
      // invent arguments is still right — and is what these schemas have
      // always said — so put it back; the leniency is the server's, not the
      // contract's.
      if (jsonSchema.type === "object" && jsonSchema.additionalProperties === undefined) {
        jsonSchema.additionalProperties = false
      }
    },
  }) as Record<string, unknown>
  // The dialect is fixed by the spec; every tool repeating it is bytes on the
  // wire an agent pays for.
  delete json.$schema
  return json
}

/**
 * A validation failure as a model will read it: the path of the field that is
 * wrong, then what is wrong with it — `` `blocks[1].text` is required and
 * must be a string. `` — so it can fix the one field and call again rather
 * than be told the whole call was malformed.
 *
 * Only the first issue is reported: the messages are written to fit after a
 * path, and a model repairs one field at a time anyway. An issue with no path
 * is a rule about the whole call (the block budget), and speaks for itself.
 */
const messageOf = (error: z.core.$ZodError): string => {
  const issue = error.issues[0]
  const path = issue.path.reduce<string>(
    (out, segment) =>
      typeof segment === "number"
        ? `${out}[${segment}]`
        : out === ""
          ? String(segment)
          : `${out}.${String(segment)}`,
    "",
  )
  return path === "" ? issue.message : `\`${path}\` ${issue.message}`
}

/**
 * JSON-RPC clients routinely send `null` for an argument they mean to omit,
 * and every reader this schema layer replaces read the two the same way. So
 * drop null-valued keys before parsing — except inside `props`, which is the
 * caller's own metadata object, where a null is a value rather than an
 * absence.
 */
const withoutNulls = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(withoutNulls)
  if (typeof value !== "object" || value === null) return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== null)
      .map(([key, entry]) => [key, key === "props" ? entry : withoutNulls(entry)]),
  )
}

/**
 * One tool, from one schema: the JSON Schema is generated from it, and `run`
 * is handed what it parsed. A schema failure never reaches `run` — it comes
 * back as a tool-execution error, which is what lets an agent call, read the
 * refusal, and retry with the field fixed.
 */
function tool<S extends z.ZodMiniType>(def: {
  name: string
  title: string
  description: string
  permission: Permission
  annotations: ToolAnnotations
  schema: S
  run(args: z.infer<S>, context: ToolContext): Promise<ToolOutcome> | ToolOutcome
}): ToolDef {
  return {
    name: def.name,
    title: def.title,
    description: def.description,
    permission: def.permission,
    annotations: def.annotations,
    inputSchema: jsonSchemaOf(def.schema),
    async invoke(args, context) {
      const parsed = def.schema.safeParse(withoutNulls(args))
      if (!parsed.success) return { ok: false, message: messageOf(parsed.error) }
      return def.run(parsed.data, context)
    },
  }
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
  if (nodeOf(graph, blockId)?.type === NOTE_TYPE) {
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
 * `append_to_note` and `update_note` parse it — and never an output one. A
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
    // it any more. Absent for notes and for rows older than migration 0006.
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

// -----------------------------------------------------------------------------
// The tools
// -----------------------------------------------------------------------------

const readOnly = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const

/** A write whose repeat is a DIFFERENT outcome: calling it twice adds a
 * second note, or a second copy of the appended blocks. */
const writes = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const

/**
 * A write whose repeat is the SAME outcome: setting a block's text to X
 * twice leaves it saying X, linking a block where it already sits moves
 * nothing, unlinking an absent link is refused.
 *
 * Worth distinguishing because clients read `idempotentHint` to decide
 * whether a call that failed mid-flight is safe to retry — and for these it
 * is, which is exactly the guarantee an agent needs on a flaky connection.
 */
const edits = { ...writes, idempotentHint: true } as const

export const TOOLS: ToolDef[] = [
  tool({
    name: "list_notes",
    title: "List notes",
    description:
      "List the notes this token can reach, most recently updated first, with " +
      "each note's tags and task counts. Filter by `tag` or by `type` " +
      "(`note`, `daily`, `weekly`); page with `cursor` when `nextCursor` comes " +
      "back. This ENUMERATES notes — to find notes by their content, use " +
      "`search`, which looks at every block rather than a note's opening lines.",
    permission: "read",
    annotations: readOnly,
    schema: z.object({
      tag: textArg("Only notes carrying this tag. Without the leading '#'. Matches sub-tags."),
      type: z.optional(
        z
          .enum(["note", "daily", "weekly"], {
            error: (issue) =>
              `must be one of note, daily or weekly (got ${JSON.stringify(issue.input)}).`,
          })
          .register(z.globalRegistry, { description: "Only notes of this kind." }),
      ),
      limit: limitArg(),
      cursor: cursorArg(),
    }),
    run(args, { graph }) {
      const tag = args.tag?.replace(/^#/, "").toLowerCase()
      const type = args.type
      const limit = args.limit
      const offset = offsetOf(args.cursor)

      const matches = graph
        .notes()
        .map((id) => noteSummary(graph, id))
        .filter((note): note is NonNullable<typeof note> => note !== null)
        .filter((note) => type === undefined || note.type === type)
        .filter((note) => tag === undefined || note.tags.some((t) => t.toLowerCase() === tag))
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
  }),

  tool({
    name: "search",
    title: "Search blocks",
    description:
      "Find blocks whose text contains `query` (case-insensitive substring, not " +
      "the app's query language). Each hit names the block and the notes it " +
      "appears in, so it is the way to get from a phrase to a note or a block id.",
    permission: "read",
    annotations: readOnly,
    schema: z.object({
      query: requiredArg("The text to look for."),
      limit: limitArg(),
    }),
    run(args, { graph }) {
      const query = args.query.toLowerCase()
      const limit = args.limit

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
        if (!row || row.type === NOTE_TYPE) continue
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
  }),

  tool({
    name: "read_note",
    title: "Read a note",
    description:
      "A note and its blocks, as stored: every block's id, type, text, metadata " +
      "and children, in outline order with its depth. NOT markdown — this is the " +
      "row data, so to change a block you name it by id with `update_block` " +
      "rather than rewriting the note. Returns the top " +
      `${DEFAULT_NOTE_DEPTH} levels by default, because a large note is expensive ` +
      "to read whole: `blockCount` is always the note's true size, `truncated` " +
      "says whether you got all of it, and a block whose children were cut off " +
      "is marked `hasMoreChildren` so you know where to walk in with " +
      "`list_children`. Pass `depth: 0` for the whole note. Also returns the note's " +
      "`unassigned` blocks: ones written in it that nothing links to any more, " +
      "which the app shows in a section at the foot of the note.",
    permission: "read",
    annotations: readOnly,
    schema: z.object({
      note_id: requiredArg("From `list_notes` or `search`."),
      depth: depthArg(
        0,
        DEFAULT_NOTE_DEPTH,
        `How many levels of the outline to return. Defaults to ${DEFAULT_NOTE_DEPTH}; ` +
          "use 0 for the whole note, which on a large one is expensive.",
      ),
    }),
    run(args, { graph }) {
      const noteId = args.note_id
      const note = noteOf(graph, noteId)
      if (!note) return { ok: false, message: OUT_OF_SCOPE }
      const depth = args.depth

      const rootBlockIds = childrenOf(graph, noteId)
      const { blocks, truncated } = blocksOfNote(graph, rootBlockIds, depth)
      // The whole note's size, whatever `depth` returned — so an agent that
      // truncated knows how much it has not seen.
      const blockCount = blocksOfNote(graph, rootBlockIds, 0).blocks.length
      const unassigned = blocksOfNote(graph, unassignedOf(graph, noteId) ?? [], depth).blocks

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
  }),

  tool({
    name: "get_block",
    title: "Get a block",
    description:
      "One block by id, as stored: type, text, metadata, its children, the " +
      "blocks that hold it, and the notes it appears in. A note id works too " +
      "(a note is a block whose type is `note`). The starting point for walking " +
      "the graph with `list_children` and `list_parents`.",
    permission: "read",
    annotations: readOnly,
    schema: z.object({ block_id: requiredArg("A block id, or a note id.") }),
    run(args, { graph }) {
      const id = args.block_id
      const block = blockOut(graph, id)
      if (!block) return { ok: false, message: BLOCK_OUT_OF_SCOPE }

      const data = {
        ...block,
        parentIds: parentsOf(graph, id),
        // Which notes this block appears in. A block that IS a note lists
        // itself; `type` already says which it is, so there is no separate
        // flag saying the same thing twice.
        noteIds: notesReaching(graph, id),
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
  }),

  tool({
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
    schema: z.object({
      block_id: requiredArg("A block id, or a note id."),
      depth: depthArg(1, 1, "Levels to return. 1 (the default) is the direct children only."),
      limit: limitArg(),
    }),
    run(args, { graph }) {
      const id = args.block_id
      const limit = args.limit
      const depth = args.depth
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
  }),

  tool({
    name: "list_parents",
    title: "List a block's parents",
    description:
      "The blocks that hold this one, and the notes it appears in. A block can " +
      "sit under several parents at once — that is how the same block shows in " +
      "more than one note. Walk up by calling this again with a parent's id.",
    permission: "read",
    annotations: readOnly,
    schema: z.object({ block_id: requiredArg("A block id or a note id.") }),
    run(args, { graph }) {
      const id = args.block_id
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
  }),

  tool({
    name: "list_tags",
    title: "List tags",
    description:
      "Every tag across the notes this token can reach, with how many notes " +
      "carry it. Pass one to `list_notes` as `tag` to see them.",
    permission: "read",
    annotations: readOnly,
    schema: z.object({}),
    run(_args, { graph }) {
      const counts = new Map<string, number>()
      for (const noteId of graph.notes()) {
        for (const tag of noteOf(graph, noteId)?.tags ?? []) {
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
  }),

  tool({
    name: "create_blocks",
    title: "Add blocks to a note",
    description:
      "Add new blocks under a parent, at `index` (0-based; omit for the end). " +
      "Pass a note id as the parent for top-level rows. Each block is " +
      "`{ text, type?, props?, children? }`, and `children` nests — so a " +
      "heading with bullets under it is one call. At most " +
      `${MAX_NEW_BLOCKS} blocks in one call, counting nested ones. Purely ` +
      "additive: nothing already in the note is touched.",
    permission: "write",
    annotations: writes,
    schema: z
      .object({
        parent_id: requiredArg("A block id, or a note id for top-level rows."),
        blocks: z
          .array(NewBlockSchema, "must be a non-empty array of blocks.")
          .check(z.minLength(1, "must be a non-empty array of blocks."))
          .register(z.globalRegistry, { description: "The blocks to add, in order." }),
        index: indexArg(),
      })
      // The budget is a rule about the whole call, not about one field: it
      // counts nested blocks too, so `blocks[3].children[9]` is what puts the
      // call over. JSON Schema cannot say "200 nodes in this tree" — `maxItems`
      // would only bound the top level — so it is a check here, and the
      // description says it.
      .check(
        z.refine((args) => countBlocks(args.blocks) <= MAX_NEW_BLOCKS, {
          error: `More than ${MAX_NEW_BLOCKS} blocks in one call.`,
          abort: true,
        }),
      ),
    async run(args, context) {
      const { graph } = context
      const parentId = args.parent_id
      const index = args.index
      const specs = args.blocks

      const parent = nodeOf(graph, parentId)
      if (!parent) return { ok: false, message: BLOCK_OUT_OF_SCOPE }
      if (parent.type !== NOTE_TYPE) {
        const refusal = sharedOutsideScope(context, parentId)
        if (refusal) return refusal
      }

      // The note a new block is "written in" (`notes_id`, migration 0006) —
      // where it shows if it ever falls out of the outline. A block added
      // under a note belongs to that note; one added under a block inherits
      // the note that block was written in, which is what the editor does
      // when you press Enter.
      const notesId = parent.type === NOTE_TYPE ? parent.id : parent.notes_id
      if (notesId === undefined) {
        return {
          ok: false,
          message:
            `${parentId} does not belong to a note, so a block added under it ` +
            `would have nowhere to live.`,
        }
      }

      const ops: Op[] = []
      const created: string[] = []

      const emit = (into: string, blocks: NewBlock[], at: number | undefined) => {
        // Fractional keys for the whole run at once, strictly between the two
        // siblings it lands between — so the existing rows either side keep
        // the keys they have and nothing else is written.
        const siblings = childLinksOf(graph, into).map((link) => link.sort_key)
        const position = at === undefined ? siblings.length : Math.min(at, siblings.length)
        const keys = generateNKeysBetween(
          position > 0 ? siblings[position - 1] : null,
          position < siblings.length ? siblings[position] : null,
          blocks.length,
        )
        blocks.forEach((block, i) => {
          const id = blockId()
          created.push(id)
          ops.push({
            op: "create",
            id,
            type: block.type ?? "text",
            text: block.text,
            props: propsJson(block.props ?? null),
            notesId,
          })
          ops.push({ op: "link", source: into, destination: id, sortKey: keys[i] })
          const children = block.children ?? []
          if (children.length > 0) emit(id, children, undefined)
        })
      }
      emit(parentId, specs, index)

      const written = await applyOpsToReplica(context.tenant, graph.snapshot, ops, context.now)
      return {
        ok: true,
        data: {
          parentId,
          blockIds: created,
          created: created.length,
          rowsWritten: written.nodes + written.links,
        },
        text: `Added ${created.length} block(s) under ${parentId}.`,
      }
    },
  }),

  tool({
    name: "set_note_title",
    title: "Retitle a note",
    description:
      "Set a note's title. Pass an empty string to clear it, leaving the note " +
      "untitled — the app then shows its first words instead.",
    permission: "write",
    annotations: edits,
    schema: z.object({
      note_id: requiredArg("The note to retitle."),
      // Required, and allowed to be empty: '' is how a title is CLEARED, so
      // the empty string is a value here rather than a missing argument.
      title: z
        .string("is required and must be a string.")
        .register(z.globalRegistry, { description: "The new title; '' to clear it." }),
    }),
    async run(args, context) {
      const noteId = args.note_id
      const title = args.title

      const note = noteNodeOf(context.graph, noteId)
      if (!note) return { ok: false, message: OUT_OF_SCOPE }

      // A note's title IS its node's text, and an untitled note's text is its
      // own id (`emittedNoteTitle`) — so clearing a title is not writing an
      // empty string, it is putting the id back.
      const text = title.trim() === "" ? noteId : title
      const ops: Op[] = text === note.text ? [] : [{ op: "setText", id: noteId, text }]
      const written = await applyOpsToReplica(
        context.tenant,
        context.graph.snapshot,
        ops,
        context.now,
      )
      return {
        ok: true,
        data: {
          noteId,
          title: text === noteId ? null : text,
          changed: ops.length,
          rowsWritten: written.nodes + written.links,
        },
        text: ops.length === 0 ? "Already titled that." : `Retitled ${noteId}.`,
      }
    },
  }),

  tool({
    name: "update_block",
    title: "Edit a block",
    description:
      "Change one block's text, type or metadata, in place. The cheap way to " +
      "edit: name the block by id and send only what changes, instead of " +
      "rewriting the whole note. The block keeps its id and stays in every note " +
      "that holds it — which also means an edit shows up in all of them. " +
      "Types: text, h1, h2, h3, todo, done, ul, ol, quote, code, image.",
    permission: "write",
    annotations: edits,
    schema: z.object({
      block_id: requiredArg("The block to change."),
      text: textArg("The block's new text, without any markdown marker."),
      type: blockTypeArg("Tick a to-do by setting `done`; untick it with `todo`."),
      props: propsArg("Replaces the block's metadata object outright. Omit to leave it alone."),
    }),
    async run(args, context) {
      const { graph } = context
      const id = args.block_id
      const { text, type, props } = args

      const row = nodeOf(graph, id)
      if (!row) return { ok: false, message: BLOCK_OUT_OF_SCOPE }
      if (row.type === NOTE_TYPE) {
        return {
          ok: false,
          message: `${id} is a note, not a block. Retitle it with \`update_note\`.`,
        }
      }
      // "Something to change" is a rule about the call, and could live in the
      // schema — but it is kept here so that a call naming a block this token
      // cannot reach is refused for THAT reason first, rather than being told
      // about its empty field list.
      if (text === undefined && type === undefined && props === undefined) {
        return { ok: false, message: "Give at least one of `text`, `type` or `props` to change." }
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
  }),

  tool({
    name: "link_block",
    title: "Put a block under another",
    description:
      "Link an existing block beneath a parent, at `index` (0-based; omit for " +
      "the end). Pass a note id as the parent for a top-level row. This does " +
      "not copy the block: it makes the SAME block appear in a second place, so " +
      "editing it either place changes both. That is how a block ends up in two " +
      "notes. Use `move_block` to relocate one rather than linking then unlinking.",
    permission: "write",
    annotations: edits,
    schema: z.object({
      parent_id: requiredArg("A block id, or a note id for a top-level row."),
      block_id: requiredArg("The block to put there."),
      index: indexArg(),
    }),
    async run(args, context) {
      const parentId = args.parent_id
      const blockId = args.block_id
      const index = args.index

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
  }),

  tool({
    name: "unlink_block",
    title: "Take a block out of one place",
    description:
      "Remove a block from under one parent. The block is NOT deleted: if that " +
      "was the only place it appeared, it goes to its note's Unassigned section " +
      "(see `read_note`), with everything beneath it, where it can be linked " +
      "back. If it also appears elsewhere, it simply stays there. To delete a " +
      "block for good, use `delete_block`.",
    permission: "write",
    annotations: edits,
    schema: z.object({
      parent_id: requiredArg("The block or note it is currently under."),
      block_id: requiredArg("The block to take out of that place."),
    }),
    async run(args, context) {
      const parentId = args.parent_id
      const blockId = args.block_id

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
  }),

  tool({
    name: "move_block",
    title: "Move a block",
    description:
      "Move a block from one parent to another, or to a different position " +
      "under the same parent, in one step. Give `from_parent_id` when the block " +
      "appears in more than one place, so it is clear which occurrence moves.",
    permission: "write",
    annotations: edits,
    schema: z.object({
      block_id: requiredArg("The block to move."),
      to_parent_id: requiredArg("A block id, or a note id."),
      from_parent_id: textArg("Required only when the block appears under more than one parent."),
      index: indexArg(),
    }),
    async run(args, context) {
      const blockId = args.block_id
      const toParent = args.to_parent_id
      const fromArg = args.from_parent_id
      const index = args.index

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
  }),

  tool({
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
    schema: z.object({
      block_id: requiredArg("The block to delete."),
      with_contents: z
        ._default(z.boolean("must be true or false."), false)
        .register(z.globalRegistry, {
          description: "Also delete everything beneath it that nothing else holds.",
        }),
    }),
    async run(args, context) {
      const blockId = args.block_id
      const withContents = args.with_contents

      const row = nodeOf(context.graph, blockId)
      if (!row) return { ok: false, message: BLOCK_OUT_OF_SCOPE }
      if (row.type === NOTE_TYPE) {
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
  }),

  tool({
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
    schema: z.object({ note_id: requiredArg("The note to delete.") }),
    async run(args, context) {
      const noteId = args.note_id
      if (noteNodeOf(context.graph, noteId) === null) return { ok: false, message: OUT_OF_SCOPE }

      const title = noteOf(context.graph, noteId)?.displayName ?? noteId
      const ops = deleteNoteOps(noteId, context.graph.snapshot)
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
  }),
]

// -----------------------------------------------------------------------------
// Dispatch
// -----------------------------------------------------------------------------

/** Can this grant use this tool at all? The single predicate behind both
 * `toolsFor` (what is listed) and `callTool` (what runs), so the two can
 * never disagree about which tools exist. */
const grantHasTool = (grant: Grant, tool: ToolDef): boolean => allows(grant, tool.permission)

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
    return {
      kind: "unknown_tool",
      message:
        `Tool '${name}' is not available: this token does not have the ` +
        `'${tool.permission}' permission.`,
    }
  }

  const graph = await scopedGraph(tenant, grant)
  return { kind: "result", outcome: await tool.invoke(args, { grant, tenant, graph, now }) }
}
