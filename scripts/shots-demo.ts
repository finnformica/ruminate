/**
 * The demo fixtures for shots mode (docs/screenshots.md).
 *
 *   npm run shots:demo
 *
 * Writes shots/demo/fixtures.json: a fake account with realistic content —
 * notes with nested blocks, a tracker with a year of daily entries across
 * four series, pins, a note shared by another user and one shared by this
 * one, an MCP token and a habit reminder. Every byte is made up here; no
 * real data goes in.
 *
 * The log is made the way the app makes it: each batch of ops goes through
 * `opsToKeyEvents` against the graph so far (`applyOps`), so the events are
 * the ones a device would push. The output is the same on every run: ids
 * come from a counter, the clock from ANCHOR_DAY, the randomness from a
 * seed. The mock API moves the dates to today when it serves them.
 *
 * To add content, add to NOTES or SERIES and run the command again.
 */
import { generateKeyBetween, generateNKeysBetween } from "fractional-indexing"
import type { NodeRow } from "../worker/handlers/replica-payload"
import type { BlockType } from "../src/blocks/types"
import {
  CHILD_KIND,
  CORPUS_ROOT_ID,
  NOTE_TYPE,
  ROOT_TYPE,
  TRACKER_TYPE,
  buildGraphSnapshot,
  propsJson,
  type GraphSnapshot,
} from "../src/data/graph"
import {
  KEY_EVENT_VERSION,
  keyEventProblem,
  opsToKeyEvents,
  type LoggedKeyEvent,
} from "../src/data/key-events"
import { applyOps, type Op } from "../src/data/ops"
import { PINNED_PROP } from "../src/data/pins"
import { entryText, type Series } from "../src/data/tracker"
import type { ShotsFixtures } from "../src/shots/fixtures"

// `node:fs` via `getBuiltinModule`, dodging the vite node-polyfills alias
// (same trick as scripts/check-changelog.ts).
const builtin = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process
  ?.getBuiltinModule as (id: string) => unknown
const { mkdirSync, writeFileSync } = builtin("node:fs") as {
  mkdirSync: (path: string, options: { recursive: true }) => void
  writeFileSync: (path: string, data: string) => void
}

const OUT_DIR = "shots/demo"
/** The day the content is written against: the tracker's last day. */
const ANCHOR_DAY = "2026-11-04"
const DAY_MS = 86_400_000
const USER = { id: 900001, login: "sam-demo", name: "Sam Rivera", email: "sam@example.com" }
const DEVICE = "shots-demo"

// -----------------------------------------------------------------------------
// Deterministic ids, clock and randomness
// -----------------------------------------------------------------------------

let idCounter = 0
const nextId = (): string => `blk_d${(idCounter++).toString(36).padStart(9, "0")}`

/** mulberry32: a small seeded generator, so a run is the same every time. */
let seed = 20261104
function random(): number {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

const dayOf = (offset: number): string =>
  new Date(Date.parse(`${ANCHOR_DAY}T00:00:00Z`) + offset * DAY_MS).toISOString().slice(0, 10)
/** A moment on the day `offset` days from the anchor (negative = before). */
const atOf = (offset: number, hour: number): number =>
  Date.parse(`${dayOf(offset)}T00:00:00Z`) + hour * 3_600_000

// -----------------------------------------------------------------------------
// The log
// -----------------------------------------------------------------------------

let graph: GraphSnapshot = buildGraphSnapshot([], [])
const events: LoggedKeyEvent[] = []
let batchCounter = 0
let eventCounter = 0

/** Apply one batch at `at`, and log its key events. */
function commit(ops: Op[], at: number) {
  if (ops.length === 0) return
  const batch = `bat_d${(batchCounter++).toString(36).padStart(7, "0")}`
  const keyEvents = opsToKeyEvents(graph, ops, {
    batch,
    device: DEVICE,
    at,
    tz: 0,
    mintId: () => `evt_d${(eventCounter++).toString(36).padStart(9, "0")}`,
  })
  for (const event of keyEvents) {
    const problem = keyEventProblem(event)
    if (problem !== null) throw new Error(`invalid event ${event.id}: ${problem}`)
    events.push({
      ...event,
      v: KEY_EVENT_VERSION,
      seq: events.length + 1,
      origin: "replica",
      actor: USER.id,
      received_at: at,
    })
  }
  graph = applyOps(graph, ops, at)
}

const lastChildKey = (parent: string): string | null =>
  (graph.childLinks.get(parent) ?? []).at(-1)?.sort_key ?? null

// -----------------------------------------------------------------------------
// Notes
// -----------------------------------------------------------------------------

interface DemoBlock {
  type: BlockType
  text: string
  props?: Record<string, unknown>
  children?: DemoBlock[]
}

const b = (type: BlockType, text: string, children: DemoBlock[] = []): DemoBlock => ({
  type,
  text,
  children,
})

interface DemoNote {
  title: string
  /** Days before the anchor the note was written. */
  daysAgo: number
  pinned?: boolean
  blocks: DemoBlock[]
}

const NOTES: DemoNote[] = [
  {
    title: "Garden plan 2027",
    daysAgo: 3,
    pinned: true,
    blocks: [
      b("text", "What goes where next spring, and what to order before **January**."),
      b("h2", "Beds"),
      b("ul", "North bed (full sun)", [
        b("ul", "Tomatoes: Sungold, Black Krim, San Marzano", [
          b("ul", "Stake at planting, not after"),
          b("ul", "Basil between the rows"),
        ]),
        b("ul", "Peppers: Padrón and a sweet one"),
      ]),
      b("ul", "South bed (half shade)", [
        b("ul", "Lettuce in three sowings, two weeks apart"),
        b("ul", "Chard and spinach under the fleece"),
      ]),
      b("h2", "To do"),
      b("done", "Order seed catalogue"),
      b("todo", "Mend the cold frame lid"),
      b("todo", "Ask the allotment about a second water butt"),
      b(
        "quote",
        "The best time to plant a tree was twenty years ago. The second best time is now.",
      ),
    ],
  },
  {
    title: "Reading list",
    daysAgo: 12,
    blocks: [
      b("h2", "Now"),
      b("ul", "_The Overstory_, Richard Powers", [b("ul", "Up to the chapter on the fig")]),
      b("h2", "Next"),
      b("ul", "_A Pattern Language_, Christopher Alexander"),
      b("ul", "[How to Take Smart Notes](https://example.com/smart-notes), Sönke Ahrens"),
      b("ul", "_Braiding Sweetgrass_, Robin Wall Kimmerer"),
      b("h2", "Done this year"),
      b("done", "_Piranesi_, Susanna Clarke"),
      b("done", "_The Dispossessed_, Ursula K. Le Guin"),
      b("done", "_Thinking in Systems_, Donella Meadows"),
    ],
  },
  {
    title: "Kitchen renovation",
    daysAgo: 20,
    blocks: [
      b("text", "Budget is **£14,000** all in. Builder starts in March if the quote holds."),
      b("h2", "Decisions"),
      b("ol", "Keep the window where it is", [b("ul", "Moving it adds £2,400 and six weeks")]),
      b("ol", "Oak worktops, oiled"),
      b("ol", "Induction hob, 4 zones"),
      b("h2", "Quotes"),
      b("ul", "Hart & Sons: £12,800, no electrics"),
      b("ul", "Mill Lane Kitchens: £13,650, with electrics", [
        b("todo", "Ask if the extractor is included"),
      ]),
    ],
  },
  {
    title: "Lisbon trip",
    daysAgo: 34,
    blocks: [
      b("h3", "Day 1: Alfama"),
      b("ul", "Tram 28 early, before the queues"),
      b("ul", "Lunch at the place by the Sé with the grilled sardines"),
      b("h3", "Day 2: Belém"),
      b("ul", "Pastéis de Belém, then the monastery"),
      b("ul", "MAAT if there is time"),
      b("h3", "Day 3: Sintra"),
      b("ul", "Train from Rossio", [b("ul", "Pena first, then Quinta da Regaleira")]),
      b("done", "Book flights"),
      b("todo", "Pick up euros"),
    ],
  },
  {
    title: "Q4 planning meeting",
    daysAgo: 6,
    blocks: [
      b("text", "Attendees: Priya, Tom, Jun, me."),
      b("h2", "Agenda"),
      b("ol", "Review of Q3 goals"),
      b("ol", "Hiring for the platform team"),
      b("ol", "Offsite dates"),
      b("h2", "Actions"),
      b("todo", "Priya: draft the job description by Friday"),
      b("todo", "Tom: book the venue for the offsite"),
      b("done", "Me: send round the notes"),
    ],
  },
  {
    title: "Sourdough",
    daysAgo: 48,
    blocks: [
      b("text", "Starter fed at 1:1:1. Ready when it doubles in about five hours."),
      b("h2", "Country loaf"),
      b("ul", "500 g flour (450 white, 50 rye)"),
      b("ul", "375 g water, 10 g salt, 100 g starter"),
      b("ol", "Autolyse 1 hour"),
      b("ol", "Four sets of stretch and folds, 30 minutes apart"),
      b("ol", "Shape, then overnight in the fridge"),
      b("ol", "Bake at 250 °C, 20 min lid on, 25 min lid off"),
    ],
  },
  {
    title: "Maths scratchpad",
    daysAgo: 9,
    blocks: [
      b("text", "Euler's identity: $$e^{i\\pi} + 1 = 0$$"),
      b("text", "Sum of the first n squares: $$\\sum_{k=1}^{n} k^2 = \\frac{n(n+1)(2n+1)}{6}$$"),
      b("code", "def squares(n):\n    return n * (n + 1) * (2 * n + 1) // 6"),
    ],
  },
]

function blockOps(noteId: string, parentId: string, blocks: DemoBlock[]): Op[] {
  const ops: Op[] = []
  const keys = generateNKeysBetween(null, null, blocks.length)
  blocks.forEach((block, at) => {
    const id = nextId()
    ops.push(
      {
        op: "create",
        id,
        type: block.type,
        text: block.text,
        props: propsJson(block.props ?? null),
        notesId: noteId,
      },
      { op: "link", source: parentId, destination: id, sortKey: keys[at] },
      ...blockOps(noteId, id, block.children ?? []),
    )
  })
  return ops
}

function writeNote(note: DemoNote, type: string = NOTE_TYPE): string {
  const id = nextId()
  const at = atOf(-note.daysAgo, 9)
  commit(
    [
      {
        op: "create",
        id,
        type,
        text: note.title,
        props: propsJson({
          updated_at: new Date(at).toISOString(),
          ...(note.pinned ? { [PINNED_PROP]: at } : {}),
        }),
      },
      {
        op: "link",
        source: CORPUS_ROOT_ID,
        destination: id,
        sortKey: generateKeyBetween(lastChildKey(CORPUS_ROOT_ID), null),
      },
      ...blockOps(id, id, note.blocks),
    ],
    at,
  )
  return id
}

// -----------------------------------------------------------------------------
// The tracker
// -----------------------------------------------------------------------------

interface DemoSeries {
  name: string
  props: Record<string, unknown>
  /** The entry of day `offset` (0 = the anchor), or null for none. */
  entry: (offset: number) => boolean | number | null
}

const weekday = (offset: number): number => new Date(atOf(offset, 12)).getUTCDay()

const SERIES: DemoSeries[] = [
  {
    name: "Read",
    props: { kind: "check", colour: "green", target: 20, period: "month" },
    entry: () => random() < 0.78,
  },
  {
    name: "Run",
    props: {
      kind: "number",
      colour: "blue",
      unit: "km",
      step: 0.5,
      target: 15,
      period: "week",
      rollup: "sum",
    },
    // Tuesday, Thursday and a long run on Sunday, with a few missed.
    entry: (offset) => {
      const day = weekday(offset)
      if (day === 0) return random() < 0.85 ? Math.round(8 + random() * 6) : null
      if (day === 2 || day === 4)
        return random() < 0.8 ? Math.round((4 + random() * 3) * 2) / 2 : null
      return null
    },
  },
  {
    name: "Meditate",
    props: { kind: "check", colour: "purple" },
    entry: (offset) => (offset > -60 ? random() < 0.9 : random() < 0.55),
  },
  {
    name: "Sleep",
    props: {
      kind: "number",
      colour: "violet",
      unit: "h",
      step: 0.5,
      rollup: "avg",
      min: 0,
      max: 12,
    },
    entry: () => (random() < 0.92 ? Math.round((6 + random() * 2.5) * 2) / 2 : null),
  },
]

function writeTracker(): string {
  const trackerId = nextId()
  const start = -364
  const at = atOf(start, 8)
  const seriesIds = SERIES.map(() => nextId())
  const keys = generateNKeysBetween(null, null, SERIES.length)
  commit(
    [
      {
        op: "create",
        id: trackerId,
        type: TRACKER_TYPE,
        text: "Habits",
        props: propsJson({ updated_at: new Date(at).toISOString() }),
      },
      {
        op: "link",
        source: CORPUS_ROOT_ID,
        destination: trackerId,
        sortKey: generateKeyBetween(
          null,
          (graph.childLinks.get(CORPUS_ROOT_ID) ?? [])[0]?.sort_key ?? null,
        ),
      },
      ...SERIES.flatMap((series, at): Op[] => [
        {
          op: "create",
          id: seriesIds[at],
          type: "ul",
          text: series.name,
          props: propsJson(series.props),
          notesId: trackerId,
        },
        { op: "link", source: trackerId, destination: seriesIds[at], sortKey: keys[at] },
      ]),
    ],
    at,
  )
  for (let offset = start; offset <= 0; offset += 1) {
    const ops: Op[] = []
    SERIES.forEach((series, at) => {
      const value = series.entry(offset)
      if (value === null || value === false) return
      const id = nextId()
      const date = dayOf(offset)
      const text =
        typeof value === "number"
          ? entryText({ unit: series.props.unit as string } as Pick<Series, "unit">, date, value)
          : date
      ops.push(
        {
          op: "create",
          id,
          type: typeof value === "number" ? "text" : "done",
          text,
          props: null,
          notesId: trackerId,
        },
        {
          op: "link",
          source: seriesIds[at],
          destination: id,
          sortKey: generateKeyBetween(lastChildKey(seriesIds[at]), null),
        },
      )
    })
    commit(ops, atOf(offset, 21))
  }
  return trackerId
}

// -----------------------------------------------------------------------------
// Shares
// -----------------------------------------------------------------------------

/** A note another user shared with this one: their rows, not in this log. */
function sharedSlice() {
  const at = atOf(-15, 10)
  const noteId = "blk_dshare00001"
  const blocks: [string, string, string][] = [
    ["blk_dshare00002", "text", "Picks for the winter meetings. Add yours under the month."],
    ["blk_dshare00003", "h3", "December"],
    ["blk_dshare00004", "ul", "_Small Things Like These_, Claire Keegan"],
    ["blk_dshare00005", "h3", "January"],
    ["blk_dshare00006", "ul", "_Tomorrow, and Tomorrow, and Tomorrow_, Gabrielle Zevin"],
    ["blk_dshare00007", "todo", "Vote on February by the 20th"],
  ]
  const keys = generateNKeysBetween(null, null, blocks.length)
  const nodes: NodeRow[] = [
    {
      id: noteId,
      type: NOTE_TYPE,
      text: "Book club: winter picks",
      props: propsJson({ updated_at: new Date(at).toISOString() }),
      updated_at: at,
    },
    ...blocks.map(([id, type, text]) => ({
      id,
      type,
      text,
      props: null,
      updated_at: at,
      notes_id: noteId,
    })),
  ]
  const links = blocks.map(([id], i) => ({
    source_id: noteId,
    destination_id: id,
    kind: CHILD_KIND,
    sort_key: keys[i],
    updated_at: at,
  }))
  return { noteId, at, slice: { nodes, links } }
}

// -----------------------------------------------------------------------------
// The account
// -----------------------------------------------------------------------------

commit(
  [{ op: "create", id: CORPUS_ROOT_ID, type: ROOT_TYPE, text: "", props: null }],
  atOf(-364, 7),
)
const trackerId = writeTracker()
const noteIds = [...NOTES]
  .sort((a, b) => b.daysAgo - a.daysAgo)
  .map((note) => [note.title, writeNote(note)] as const)
const kitchenId = noteIds.find(([title]) => title === "Kitchen renovation")?.[1] ?? trackerId

const shared = sharedSlice()

const fixtures: ShotsFixtures = {
  kind: "demo",
  anchorDay: ANCHOR_DAY,
  user: USER,
  events,
  features: { admin: false, features: { mcp: true, cloudflareAi: false } },
  preferences: { preferences: { whatsNewCard: false, useCloudflareAi: false } },
  shares: {
    me: { email: USER.email },
    given: [
      {
        id: "shr_demo_given1",
        granteeEmail: "alex@example.com",
        view: { id: "viw_demo_given1", rootId: kitchenId, filter: null, sort: null },
        permissions: ["read", "write"],
        createdAt: atOf(-18, 11),
        revokedAt: null,
        revokedBy: null,
      },
    ],
    received: [
      {
        id: "shr_demo_recv1",
        owner: { login: "ada-park", name: "Ada Park" },
        view: { id: "viw_demo_recv1", rootId: shared.noteId, filter: null, sort: null },
        permissions: ["read"],
        createdAt: shared.at,
      },
    ],
  },
  slices: {
    shr_demo_recv1: {
      ...shared.slice,
      view: { id: "viw_demo_recv1", rootId: shared.noteId, filter: null, sort: null },
    },
  },
  mcpTokens: [
    {
      id: "tok_demo_1",
      name: "Claude Desktop",
      permissions: ["read", "write"],
      noteIds: null,
      createdAt: atOf(-40, 10),
      expiresAt: null,
      lastUsedAt: atOf(-1, 18),
      revokedAt: null,
      callsToday: 12,
      dailyLimit: 2000,
    },
  ],
  anthropicKey: { set: false, last4: null },
  reminders: {
    publicKey: "BDemoPublicKeyForShotsOnly",
    reminder: { reminderTime: "20:30", timeZone: "Europe/London", lastSentDay: dayOf(-1) },
  },
}

mkdirSync(OUT_DIR, { recursive: true })
writeFileSync(`${OUT_DIR}/fixtures.json`, `${JSON.stringify(fixtures)}\n`)
console.log(
  `wrote ${OUT_DIR}/fixtures.json: ${events.length} events, ${NOTES.length + 1} notes, ` +
    `anchor ${ANCHOR_DAY}`,
)
