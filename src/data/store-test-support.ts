import type { EventContext, LoggedEvent, RuminateEvent } from "./events"
import { encodeHlc, tickHlc, type Hlc } from "./hlc"
import { expandLog, opsToKeyEvents, type KeyEvent, type LoggedKeyEvent } from "./key-events"
import type { NoteStore } from "./note-store"
import type { Op } from "./ops"

// What the runtime does to a batch of ops before the store sees it, for tests
// that drive a store directly: translate them against the store's own live
// graph (`opsToKeyEvents`) and apply the events. The envelope is a test's — one
// device, ids numbered — so an assertion can name an event.

let minted = 0
/** The test device's clock: each event stamps after the last, as the
 * runtime's do (`tickHlc`), so the cache resolves a later edit over an
 * earlier one even inside one ms. */
let lastStamp: Hlc | null = null

/** The envelope a test's events share. `at` defaults to the clock. */
export function testEventContext(over: Partial<EventContext> = {}): EventContext {
  return {
    batch: `bat_test_${(minted += 1)}`,
    device: "test.tab",
    at: Date.now(),
    tz: 0,
    mintId: () => `evt_test_${(minted += 1)}`,
    stamp: () => encodeHlc((lastStamp = tickHlc(lastStamp, Date.now(), "test.tab"))),
    ...over,
  }
}

/** Apply ops to a store as the runtime would, returning the events they
 * became (empty when the ops changed nothing the graph held). */
export async function applyOpsToStore(
  store: NoteStore,
  ops: readonly Op[],
  ctx: EventContext = testEventContext(),
): Promise<KeyEvent[]> {
  const events = opsToKeyEvents(await store.getGraph(), ops, ctx)
  await store.applyEvents(events)
  return events
}

/**
 * Old-shaped placed events as the per-key log serves them (`expandLog`):
 * each row numbered after its event — seq `<event seq> * 100 + <row>`, so
 * the rows keep the events' order and a cursor past an event's rows is past
 * the event — and carrying what the replica stamps on a pulled row. For
 * fixtures written in the old shape.
 */
export function keyed(events: readonly LoggedEvent[]): LoggedKeyEvent[] {
  const byId = new Map(events.map((event) => [event.id, event]))
  return expandLog(events as RuminateEvent[]).map((row) => {
    const source = byId.get(row.event as string) as LoggedEvent
    const ordinal = Number(row.id.split("#").pop())
    return {
      ...row,
      seq: (row.event_seq ?? 0) * 100 + ordinal,
      ...(source.origin !== undefined ? { origin: source.origin } : {}),
      ...(source.actor !== undefined ? { actor: source.actor } : {}),
      ...(source.received_at !== undefined ? { received_at: source.received_at } : {}),
    }
  })
}
