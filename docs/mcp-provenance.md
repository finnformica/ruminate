# Agent provenance, and accepting or discarding agent edits — planned

**Status: not built.** This is the design for a follow-up PR. Today an agent's write is
indistinguishable from a person's once it lands: same rows, same `updated_at`, no record
of which token did it.

## The goal

An agent writes to a note. The person should be able to see **that it was an agent**, and
**accept or discard** the change. Discarding should put things back as they were.

## The decision that has to be made first

Everything else follows from one question: **does "discard" mean revert?**

If yes, the previous value must be stored **at write time**. `update_block` currently
overwrites `nodes.text` in place, and the old text is gone the moment it commits — there
is no undo log and D1 keeps no history. Adding provenance later is easy; recovering a
value nobody stored is impossible.

So this decision has to be made _before_ agents start writing in earnest, not after. That
is the reason this doc exists now rather than when the feature is built.

Two shapes:

**A. Mark and revert.** The write lands immediately (the agent sees success, the app shows
it), and enough is recorded to undo it. Simple to build, keeps every existing tool working
unchanged, and matches how the app already thinks — the graph is truth, edits are ops.

**B. Propose and apply.** The agent's write does not touch the live graph; it lands in a
pending queue the person approves. Safer, but a much larger change: every write tool needs
a second code path, and an agent that cannot see its own writes take effect cannot chain
operations — read-after-write stops working, which breaks most useful multi-step tasks.

**Recommendation: A.** B is tempting for safety, but an agent that cannot observe the
result of its own edit is close to useless for the workflows this is for, and the safety
it buys is already largely provided by the grant (a token can only touch notes it was
scoped to) and by the never-lose-work rule (nothing is deleted; it goes to Unassigned).

## What to record

### Provenance on the row

Blocks already carry a `props` JSON object, so no migration is needed to mark one:
`props.mcp = { tokenId, at }`. The token id — never the secret — is already the audit
handle `mcp_tokens` was designed around.

Two things to be careful of:

- `update_block` lets an agent set `props` wholesale, so an agent could **erase its own
  provenance mark**. The write path has to merge the mark rather than let it be
  overwritten, and `update_block` must not accept an `mcp` key from the caller.
- A person editing an agent-written block should clear the mark: once a human has touched
  it, it is theirs. The browser's own write path would need to do that.

### A change log

`props` marks the current state; it cannot answer "what did this change?" or "what was
there before?". That needs a table:

```
mcp_changes
  id            TEXT PRIMARY KEY
  user_id       INTEGER NOT NULL     -- the tenant, as every corpus table has
  token_id      TEXT NOT NULL        -- which grant did it
  tool          TEXT NOT NULL        -- 'update_block', 'delete_block', …
  node_id       TEXT                 -- what it touched
  before        TEXT                 -- JSON of the prior row, for revert
  after         TEXT                 -- JSON of the new row
  at            INTEGER NOT NULL
  status        TEXT NOT NULL        -- 'pending' | 'accepted' | 'discarded'
```

Scoped by `user_id` like the corpus, so the tenancy guard covers it. `before` is what
makes discard mean revert.

Retention matters: this grows with every agent write and nothing prunes it. Decide up
front — accepted changes older than N days can drop their `before` payload, which is the
bulky part.

## Surfacing it

- **In the note**: an agent-written block marked in the editor (a tint, a small icon),
  with accept/discard on the block and on the batch.
- **In Settings**: a list of recent agent changes per token, which is also the audit trail
  the rate-limiting doc wants for a different reason.
- **Discard** re-applies `before` through the ordinary op path, so it replicates like any
  other edit and needs no special sync handling.

## Interaction with what already exists

- **Tombstones.** `delete_block` does not erase anything — rows keep `deleted_at`. So
  discarding a delete is already possible in principle: clear the stamp. Worth using
  rather than reinventing.
- **Unassigned.** A block an agent unlinked is already visible to the person, in the
  note's Unassigned section. That is a partial version of this feature working today.
- **Replication.** A discard is an ordinary op batch, so it takes a fresh `seq` and
  reaches other devices with no new machinery.
