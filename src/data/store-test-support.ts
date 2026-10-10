import { opsToEvents, type EventContext, type RuminateEvent } from "./events"
import type { NoteStore } from "./note-store"
import type { Op } from "./ops"

// What the runtime does to a batch of ops before the store sees it, for tests
// that drive a store directly: translate them against the store's own live
// graph (`opsToEvents`) and apply the events. The envelope is a test's — one
// device, ids numbered — so an assertion can name an event.

let minted = 0

/** The envelope a test's events share. `at` defaults to the clock. */
export function testEventContext(over: Partial<EventContext> = {}): EventContext {
  return {
    batch: `bat_test_${(minted += 1)}`,
    device: "test.tab",
    at: Date.now(),
    tz: 0,
    mintId: () => `evt_test_${(minted += 1)}`,
    ...over,
  }
}

/** Apply ops to a store as the runtime would, returning the events they
 * became (empty when the ops changed nothing the graph held). */
export async function applyOpsToStore(
  store: NoteStore,
  ops: readonly Op[],
  ctx: EventContext = testEventContext(),
): Promise<RuminateEvent[]> {
  const events = opsToEvents(await store.getGraph(), ops, ctx)
  await store.applyEvents(events)
  return events
}
