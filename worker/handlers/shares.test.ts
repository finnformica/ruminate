// tenant-guard: exempt — this suite reads raw storage (both users' rows,
// tombstones included) on purpose: that is how it proves the slice holds.
import { beforeEach, describe, expect, it } from "vitest"
import migration0012 from "../../migrations/0012_shares.sql?raw"
import migration0017 from "../../migrations/0017_share_views.sql?raw"
import { setFeatureAudience } from "../features"
import { createMcpTestEnv, type McpTestEnv } from "../mcp/test-support"
import type { SharesListBody, SliceBody } from "../shares/wire"
import { buildGraphSnapshot, noteDoc } from "../../src/data/graph"
import { deleteBlockOps, docToOps } from "../../src/data/ops"
import { opsToRows } from "../../src/data/ops-rows"
import { corpusPut } from "./replica-corpus"
import type { LinkRow, NodeRow } from "./replica-payload"
import { shares } from "./shares"

/**
 * Sharing, driven end to end through the handler: an owner shares notes with
 * an address, the person GitHub reports that address for reads the slice
 * beneath them, and — with the verbs the owner ticked — writes into it.
 *
 * The properties that matter most are the ones about what is NOT possible:
 * nothing outside the closure is ever serialized, no write can reach past
 * it, and a share id names nothing to anyone but its grantee.
 */

const OWNER = 7
const GRANTEE = 8
const STRANGER = 9

const NOTE_A = "blk_note_a"
const NOTE_B = "blk_note_b"
const A1 = "blk_a1"
const A2 = "blk_a2" // child of A1
const A3 = "blk_a3"
const B1 = "blk_b1"
const SHARED_TWICE = "blk_both" // under NOTE_A and NOTE_B

const T0 = 1_700_000_000_000

let harness: McpTestEnv

/** A GitHub stub: each token names a user. Nothing here serves `/user/emails`:
 * the address is recorded at sign-in, never fetched by these routes. */
const github = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const auth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? ""
  const token = /^Bearer (.+)$/.exec(auth)?.[1] ?? ""
  const ids: Record<string, number> = { owner: OWNER, grantee: GRANTEE, stranger: STRANGER }
  if (!(token in ids)) return new Response("{}", { status: 401 })
  const id = ids[token]
  if (String(input) === "https://api.github.com/user") {
    return new Response(JSON.stringify({ id, login: `u${id}`, name: `User ${id}` }), {
      status: 200,
    })
  }
  throw new Error(`Unexpected outbound fetch: ${String(input)}`)
}) as typeof fetch

function apiRequest(
  method: string,
  path = "",
  body?: unknown,
  session: string | null = "owner",
): Request {
  return new Request(`https://ruminate.test/api/shares${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(session === null
        ? {}
        : { Cookie: "gh_refresh=session", Authorization: `Bearer ${session}` }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

const send = (request: Request) => shares(request, harness.env, github)
const bodyOf = async (response: Response) => (await response.json()) as any

const node = (id: string, text: string, type = "ul", notesId?: string): NodeRow => ({
  id,
  type,
  text,
  props: null,
  updated_at: T0,
  ...(notesId ? { notes_id: notesId } : {}),
})
const link = (source: string, destination: string, sortKey: string): LinkRow => ({
  source_id: source,
  destination_id: destination,
  kind: "child",
  sort_key: sortKey,
  updated_at: T0,
})

/** The owner's corpus: NOTE_A → A1 → A2, NOTE_A → A3, NOTE_A → SHARED_TWICE;
 * NOTE_B → B1, NOTE_B → SHARED_TWICE. */
async function seedOwner() {
  await corpusPut(
    harness.tenant(OWNER),
    {
      nodes: [
        node(NOTE_A, "Plan", "note"),
        node(NOTE_B, "Private", "note"),
        node(A1, "one", "ul", NOTE_A),
        node(A2, "two", "ul", NOTE_A),
        node(A3, "three", "ul", NOTE_A),
        node(B1, "secret", "ul", NOTE_B),
        node(SHARED_TWICE, "both", "ul", NOTE_B),
      ],
      links: [
        link(NOTE_A, A1, "a0"),
        link(A1, A2, "a0"),
        link(NOTE_A, A3, "a1"),
        link(NOTE_A, SHARED_TWICE, "a2"),
        link(NOTE_B, B1, "a0"),
        link(NOTE_B, SHARED_TWICE, "a1"),
      ],
    },
    T0,
  )
}

async function share(
  permissions: string[] = ["read"],
  rootId: string = NOTE_A,
  email = "u8@example.com",
): Promise<string> {
  const response = await send(apiRequest("POST", "", { email, rootId, permissions }))
  expect(response.status).toBe(201)
  return (await bodyOf(response)).share.id as string
}

const slice = async (id: string, session = "grantee") =>
  send(apiRequest("GET", `/${id}/notes`, undefined, session))

const push = async (id: string, body: unknown, session = "grantee") =>
  send(apiRequest("PUT", `/${id}/notes`, body, session))

const sliceIds = (body: SliceBody) => body.nodes.map((row) => row.id).sort()

async function ownerNode(id: string): Promise<Record<string, unknown> | undefined> {
  const rows = await harness.control.exec(
    "SELECT id, type, text, props, notes_id, updated_at, deleted_at FROM nodes WHERE user_id = ?1 AND id = ?2",
    [OWNER, id],
  )
  return rows[0]
}

beforeEach(async () => {
  harness = await createMcpTestEnv()
  await harness.control.execScript(migration0012)
  await harness.control.execScript(migration0017)
  // `addUser` records `u<id>@example.com` — what the sign-in callback would.
  await harness.addUser(OWNER)
  await harness.addUser(GRANTEE)
  await harness.addUser(STRANGER)
  await seedOwner()
})

// -----------------------------------------------------------------------------
// Session and shape
// -----------------------------------------------------------------------------

describe("session", () => {
  it("refuses an unauthenticated caller", async () => {
    expect((await send(apiRequest("GET", "", undefined, null))).status).toBe(401)
    expect((await send(apiRequest("POST", "", {}, null))).status).toBe(401)
    expect((await send(apiRequest("GET", "/shr_x/notes", undefined, null))).status).toBe(401)
  })

  it("refuses a bearer token GitHub does not accept", async () => {
    expect((await send(apiRequest("GET", "", undefined, "bogus"))).status).toBe(401)
  })

  it("refuses unknown methods and paths", async () => {
    expect((await send(apiRequest("PUT", "", {}))).status).toBe(405)
    expect((await send(apiRequest("GET", "/shr_x"))).status).toBe(405)
    expect((await send(apiRequest("GET", "/shr_x/other"))).status).toBe(404)
  })
})

// -----------------------------------------------------------------------------
// Creating
// -----------------------------------------------------------------------------

describe("the address column", () => {
  it("is checked by the database: lowercased, one @, a dot after it, no spaces", async () => {
    // `async`: the test driver throws synchronously, and a rejection is what
    // the assertion below reads.
    const insert = async (email: string) =>
      harness.control.exec(
        "INSERT INTO shares (id, owner_id, grantee_email, view_id, permissions, created_at) " +
          "VALUES ('shr_x', ?1, ?2, 'blk_x', 'read', 1)",
        [OWNER, email],
      )
    for (const bad of ["Bob@Example.com", "bob", "bob@x", "bob @example.com", " bob@example.com"]) {
      await expect(insert(bad)).rejects.toThrow(/CHECK/)
    }
    await expect(insert("bob@example.com")).resolves.toBeDefined()
  })
})

describe("create", () => {
  it("stores the share and answers with it, and nothing about the address", async () => {
    const response = await send(
      apiRequest("POST", "", { email: " U8@Example.com ", rootId: NOTE_A, permissions: [] }),
    )
    expect(response.status).toBe(201)
    const { share: created } = await bodyOf(response)
    expect(created.id).toMatch(/^shr_/)
    expect(created.granteeEmail).toBe("u8@example.com")
    // The view the share is of: made for the owner on the spot, empty.
    expect(created.view).toEqual({ id: NOTE_A, rootId: NOTE_A, filter: null, sort: null })
    expect(created.permissions).toEqual(["read"])
    expect(created.revokedAt).toBeNull()
    // The same answer for an address nobody has signed in with.
    const unknown = await send(
      apiRequest("POST", "", { email: "nobody@example.com", rootId: NOTE_A }),
    )
    expect(unknown.status).toBe(201)
  })

  it("always includes read, and keeps the verbs it was given", async () => {
    const id = await share(["delete"])
    const listed: SharesListBody = await bodyOf(await send(apiRequest("GET")))
    expect(listed.given.find((entry) => entry.id === id)?.permissions).toEqual(["read", "delete"])
  })

  it("needs an address that looks like one", async () => {
    for (const email of ["", "   ", "bob", "bob@", "@example.com", 7, null]) {
      const response = await send(apiRequest("POST", "", { email, rootId: NOTE_A }))
      expect(response.status).toBe(400)
      expect((await bodyOf(response)).detail).toMatch(/email/)
    }
  })

  it("refuses a missing root rather than reading it as 'every note'", async () => {
    for (const rootId of [undefined, "", ["x"]]) {
      const response = await send(apiRequest("POST", "", { email: "u8@example.com", rootId }))
      expect(response.status).toBe(400)
      expect((await bodyOf(response)).detail).toMatch(/note or block/)
    }
  })

  it("refuses roots that are not the caller's, without telling ghosts from others'", async () => {
    await harness.seedNote(GRANTEE, { id: "blk_theirs", title: "Theirs", markdown: "- x\n" })
    const ghost = await send(
      apiRequest("POST", "", { email: "u8@example.com", rootId: "blk_ghost" }),
    )
    const theirs = await send(
      apiRequest("POST", "", { email: "u8@example.com", rootId: "blk_theirs" }),
    )
    for (const response of [ghost, theirs]) {
      expect(response.status).toBe(400)
      expect((await bodyOf(response)).detail).toMatch(/not in your notes/)
    }
    // A block of the caller's own is a fine root.
    expect(
      (await send(apiRequest("POST", "", { email: "u8@example.com", rootId: A1 }))).status,
    ).toBe(201)
  })

  it("refuses a permission it does not know", async () => {
    const response = await send(
      apiRequest("POST", "", { email: "u8@example.com", rootId: NOTE_A, permissions: ["sudo"] }),
    )
    expect(response.status).toBe(400)
  })

  it("refuses sharing with yourself", async () => {
    const response = await send(apiRequest("POST", "", { email: "U7@example.com", rootId: NOTE_A }))
    expect(response.status).toBe(400)
    expect((await bodyOf(response)).detail).toMatch(/your own address/)
  })

  it("refuses a body that is not JSON", async () => {
    const response = await send(
      new Request("https://ruminate.test/api/shares", {
        method: "POST",
        headers: { Cookie: "gh_refresh=session", Authorization: "Bearer owner" },
        body: "{",
      }),
    )
    expect(response.status).toBe(400)
  })
})

// -----------------------------------------------------------------------------
// Listing and revoking
// -----------------------------------------------------------------------------

describe("the sharing feature flag", () => {
  it("refuses to give a share when the feature is off for the caller; what was given still reads", async () => {
    const id = await share()
    await setFeatureAudience(harness.control, "sharing", "off", 1)
    const refused = await send(apiRequest("POST", "", { email: "u8@example.com", rootId: NOTE_A }))
    expect(refused.status).toBe(403)
    expect((await bodyOf(refused)).error).toBe("feature_off")
    // The grantee still reads the share, and the owner still sees and can revoke it.
    expect((await slice(id)).status).toBe(200)
    const listed = (await bodyOf(await send(apiRequest("GET")))) as SharesListBody
    expect(listed.given.map((given) => given.id)).toEqual([id])
    expect((await send(apiRequest("DELETE", `/${id}`))).status).toBe(200)
  })
})

describe("list", () => {
  it("says so when sharing is not set up on the server yet", async () => {
    // A deploy ahead of migration 0012: the table is missing.
    await harness.control.execScript("DROP TABLE shares")
    const response = await send(apiRequest("GET"))
    expect(response.status).toBe(503)
    expect((await bodyOf(response)).error).toBe("sharing_unavailable")
  })

  it("shows the owner what they gave and the grantee what they received", async () => {
    const id = await share(["read", "write"])

    const mine: SharesListBody = await bodyOf(await send(apiRequest("GET")))
    expect(mine.me).toEqual({ email: "u7@example.com" })
    expect(mine.given.map((entry) => entry.id)).toEqual([id])
    expect(mine.received).toEqual([])

    const theirs: SharesListBody = await bodyOf(
      await send(apiRequest("GET", "", undefined, "grantee")),
    )
    expect(theirs.given).toEqual([])
    expect(theirs.received).toEqual([
      {
        id,
        owner: { login: "user-7", name: null },
        view: { id: NOTE_A, rootId: NOTE_A, filter: null, sort: null },
        permissions: ["read", "write"],
        createdAt: expect.any(Number),
      },
    ])
    // The grantee learns no address but their own.
    expect(JSON.stringify(theirs.received)).not.toContain("@")
    expect(theirs.me).toEqual({ email: "u8@example.com" })
  })

  it("resolves the grantee by address, case-insensitively, and only them", async () => {
    await share(["read"], NOTE_A, "U8@EXAMPLE.COM")
    const grantee: SharesListBody = await bodyOf(
      await send(apiRequest("GET", "", undefined, "grantee")),
    )
    expect(grantee.received).toHaveLength(1)
    // The stranger's address is a different one.
    const stranger: SharesListBody = await bodyOf(
      await send(apiRequest("GET", "", undefined, "stranger")),
    )
    expect(stranger.received).toEqual([])
  })

  it("revokes for the owner only, and a revoked share is gone for the grantee", async () => {
    const id = await share(["read"])
    expect((await send(apiRequest("DELETE", `/${id}`, undefined, "grantee"))).status).toBe(404)
    expect((await slice(id)).status).toBe(200)

    expect((await send(apiRequest("DELETE", `/${id}`))).status).toBe(200)
    expect((await send(apiRequest("DELETE", `/${id}`))).status).toBe(404)

    const owner: SharesListBody = await bodyOf(await send(apiRequest("GET")))
    expect(owner.given[0].revokedAt).toEqual(expect.any(Number))
    const grantee: SharesListBody = await bodyOf(
      await send(apiRequest("GET", "", undefined, "grantee")),
    )
    expect(grantee.received).toEqual([])
    expect((await slice(id)).status).toBe(404)
  })

  it("ends with the owner: a blocked owner's shares vanish", async () => {
    const id = await share(["read"])
    await harness.addUser(OWNER, "blocked")
    const grantee: SharesListBody = await bodyOf(
      await send(apiRequest("GET", "", undefined, "grantee")),
    )
    expect(grantee.received).toEqual([])
    expect((await slice(id)).status).toBe(404)
  })
})

// -----------------------------------------------------------------------------
// The slice
// -----------------------------------------------------------------------------

describe("slice", () => {
  it("is exactly the closure beneath the roots, and nothing else", async () => {
    const id = await share()
    const response = await slice(id)
    expect(response.status).toBe(200)
    const body: SliceBody = await bodyOf(response)
    expect(sliceIds(body)).toEqual([A1, A2, A3, SHARED_TWICE, NOTE_A].sort())
    // The mirrored block was born in the private note: its `notes_id` would
    // name an id outside the closure, so it is blanked.
    expect(body.nodes.find((row) => row.id === SHARED_TWICE)?.notes_id).toBeUndefined()
    expect(body.nodes.find((row) => row.id === A1)?.notes_id).toBe(NOTE_A)
    // Links with both ends inside — never NOTE_B's link into the shared block.
    expect(body.links.map((row) => `${row.source_id}>${row.destination_id}`).sort()).toEqual(
      [`${A1}>${A2}`, `${NOTE_A}>${A1}`, `${NOTE_A}>${A3}`, `${NOTE_A}>${SHARED_TWICE}`].sort(),
    )
    expect(JSON.stringify(body)).not.toContain(NOTE_B)
    expect(JSON.stringify(body)).not.toContain(B1)
    expect(JSON.stringify(body)).not.toContain("user_id")
    expect(JSON.stringify(body)).not.toContain("seq")
  })

  it("is live: a block linked under the note later is in it, one unlinked is not", async () => {
    const id = await share()
    await corpusPut(
      harness.tenant(OWNER),
      {
        nodes: [node("blk_a4", "four", "ul", NOTE_A)],
        links: [link(NOTE_A, "blk_a4", "a3"), { ...link(NOTE_A, A3, "a1"), deleted_at: T0 + 1 }],
      },
      T0 + 1,
    )
    const body: SliceBody = await bodyOf(await slice(id))
    expect(sliceIds(body)).toContain("blk_a4")
    expect(sliceIds(body)).not.toContain(A3)
  })

  it("is the owner's view of the root: their filter and sort ride along, and follow their edits", async () => {
    // The owner saved a view of NOTE_A before sharing it.
    await corpusPut(
      harness.tenant(OWNER),
      {
        nodes: [],
        links: [],
        views: [
          {
            id: NOTE_A,
            root_id: NOTE_A,
            filter: "type:todo",
            sort: null,
            pinned: true,
            sort_key: null,
            updated_at: T0 + 1,
          },
        ],
      },
      T0 + 1,
    )
    const id = await share()
    // Creating the share kept the view the owner had, and answers with it.
    const listed: SharesListBody = await bodyOf(await send(apiRequest("GET")))
    expect(listed.given[0].view).toEqual({
      id: NOTE_A,
      rootId: NOTE_A,
      filter: "type:todo",
      sort: null,
    })
    // The grantee sees the same view, on the listing and on the slice —
    // and the whole subtree beneath it: the filter is how it opens, not
    // what it holds.
    const theirs: SharesListBody = await bodyOf(
      await send(apiRequest("GET", "", undefined, "grantee")),
    )
    expect(theirs.received[0].view.filter).toBe("type:todo")
    let body: SliceBody = await bodyOf(await slice(id))
    expect(body.view).toEqual({ id: NOTE_A, rootId: NOTE_A, filter: "type:todo", sort: null })
    expect(sliceIds(body)).toEqual([A1, A2, A3, SHARED_TWICE, NOTE_A].sort())

    // The owner changes their view: the share follows, with no write to it.
    await corpusPut(
      harness.tenant(OWNER),
      {
        nodes: [],
        links: [],
        views: [
          {
            id: NOTE_A,
            root_id: NOTE_A,
            filter: null,
            sort: "text:desc",
            pinned: true,
            sort_key: null,
            updated_at: T0 + 2,
          },
        ],
      },
      T0 + 2,
    )
    body = await bodyOf(await slice(id))
    expect(body.view).toEqual({ id: NOTE_A, rootId: NOTE_A, filter: null, sort: "text:desc" })
  })

  it("makes the owner's view where they had none, with a seq their devices will pull", async () => {
    const before = await harness.control.exec(
      "SELECT id FROM views WHERE user_id = ?1 AND id = ?2",
      [OWNER, NOTE_A],
    )
    expect(before).toEqual([])
    await share()
    const after = await harness.control.exec(
      "SELECT id, root_id, filter, sort, pinned, seq, deleted_at FROM views WHERE user_id = ?1 AND id = ?2",
      [OWNER, NOTE_A],
    )
    expect(after).toEqual([
      {
        id: NOTE_A,
        root_id: NOTE_A,
        filter: null,
        sort: null,
        pinned: 0,
        // Past every row the corpus holds, so a since-pull steps onto it.
        seq: expect.any(Number),
        deleted_at: null,
      },
    ])
    const [{ top }] = await harness.control.exec(
      "SELECT MAX(seq) AS top FROM nodes WHERE user_id = ?1",
      [OWNER],
    )
    expect(Number(after[0].seq)).toBeGreaterThan(Number(top))
    // Sharing the same node again writes nothing over it.
    await share(["read"], NOTE_A, "u9@example.com")
    expect(
      await harness.control.exec("SELECT COUNT(*) AS n FROM views WHERE user_id = ?1", [OWNER]),
    ).toEqual([{ n: 1 }])
  })

  it("keeps serving the subtree when the owner clears their view (a tombstone still names the root)", async () => {
    const id = await share()
    await corpusPut(
      harness.tenant(OWNER),
      {
        nodes: [],
        links: [],
        views: [
          {
            id: NOTE_A,
            root_id: NOTE_A,
            filter: "type:todo",
            sort: null,
            pinned: false,
            sort_key: null,
            updated_at: T0 + 3,
            deleted_at: T0 + 3,
          },
        ],
      },
      T0 + 3,
    )
    const body: SliceBody = await bodyOf(await slice(id))
    expect(sliceIds(body)).toEqual([A1, A2, A3, SHARED_TWICE, NOTE_A].sort())
    // ...in document order: a cleared view lends no filter.
    expect(body.view).toEqual({ id: NOTE_A, rootId: NOTE_A, filter: null, sort: null })
  })

  it("skips tombstoned nodes and the links through them", async () => {
    const id = await share()
    await corpusPut(
      harness.tenant(OWNER),
      { nodes: [{ ...node(A1, "one", "ul", NOTE_A), deleted_at: T0 + 1 }], links: [] },
      T0 + 1,
    )
    const body: SliceBody = await bodyOf(await slice(id))
    // A2 was only reachable through A1.
    expect(sliceIds(body)).toEqual([A3, SHARED_TWICE, NOTE_A].sort())
  })

  it("is empty when the root is no longer a live note", async () => {
    const id = await share()
    await corpusPut(
      harness.tenant(OWNER),
      { nodes: [{ ...node(NOTE_A, "Plan", "note"), deleted_at: T0 + 1 }], links: [] },
      T0 + 1,
    )
    const body: SliceBody = await bodyOf(await slice(id))
    // The view is still answered — it is the share's, whatever the root's fate.
    expect(body).toEqual({
      nodes: [],
      links: [],
      view: { id: NOTE_A, rootId: NOTE_A, filter: null, sort: null },
    })
  })

  it("can be rooted at a block: that block and what is beneath it", async () => {
    const id = await share(["read"], A1)
    const body: SliceBody = await bodyOf(await slice(id))
    expect(sliceIds(body)).toEqual([A1, A2].sort())
    expect(body.links.map((row) => `${row.source_id}>${row.destination_id}`)).toEqual([
      `${A1}>${A2}`,
    ])
    // The root keeps its own type; the client presents it as a note.
    expect(body.nodes.find((row) => row.id === A1)?.type).toBe("ul")
  })

  it("names nothing to anyone but the grantee", async () => {
    const id = await share()
    expect((await slice(id, "owner")).status).toBe(404)
    expect((await slice(id, "stranger")).status).toBe(404)
    expect((await slice("shr_missing")).status).toBe(404)
  })
})

// -----------------------------------------------------------------------------
// Writes
// -----------------------------------------------------------------------------

describe("write", () => {
  const edit = (id: string, text: string, at = T0 + 10): NodeRow => ({
    ...node(id, text, "ul", NOTE_A),
    updated_at: at,
  })

  it("is refused on a read-only share", async () => {
    const id = await share(["read"])
    const response = await push(id, { nodes: [edit(A1, "changed")], links: [] })
    expect(response.status).toBe(403)
    expect((await bodyOf(response)).error).toBe("permission_denied")
    expect((await ownerNode(A1))?.text).toBe("one")
  })

  it("lands an edit inside the slice in the owner's partition", async () => {
    const id = await share(["read", "write"])
    const response = await push(id, { nodes: [edit(A2, "changed")], links: [] })
    expect(response.status).toBe(200)
    expect(await bodyOf(response)).toEqual({ ok: true, nodes: 1, links: 0 })
    expect((await ownerNode(A2))?.text).toBe("changed")
    // And it is the owner's row, not a copy in the grantee's partition.
    const theirs = await harness.control.exec(
      "SELECT COUNT(*) AS n FROM nodes WHERE user_id = ?1",
      [GRANTEE],
    )
    expect(Number(theirs[0].n)).toBe(0)
  })

  it("cannot reach a row outside the slice, even one the owner tombstoned", async () => {
    const id = await share(["read", "write", "delete"])
    for (const target of [B1, NOTE_B]) {
      const response = await push(id, { nodes: [edit(target, "pwned")], links: [] })
      expect(response.status).toBe(403)
      expect((await bodyOf(response)).error).toBe("outside_share")
    }
    expect((await ownerNode(B1))?.text).toBe("secret")

    // A3 tombstoned by the owner: reviving it is a write outside the slice.
    await corpusPut(
      harness.tenant(OWNER),
      { nodes: [{ ...node(A3, "three", "ul", NOTE_A), deleted_at: T0 + 1 }], links: [] },
      T0 + 1,
    )
    const revive = await push(id, { nodes: [edit(A3, "back")], links: [] })
    expect(revive.status).toBe(403)
    expect((await ownerNode(A3))?.deleted_at).toBe(T0 + 1)
  })

  it("cannot link the slice to anything outside it", async () => {
    const id = await share(["read", "write"])
    const out = await push(id, {
      nodes: [],
      links: [{ ...link(A1, B1, "a5"), updated_at: T0 + 10 }],
    })
    expect(out.status).toBe(403)
    const into = await push(id, {
      nodes: [],
      links: [{ ...link(NOTE_B, A1, "a5"), updated_at: T0 + 10 }],
    })
    expect(into.status).toBe(403)
  })

  it("accepts a new block anchored to the slice, and refuses an orphan", async () => {
    const id = await share(["read", "write"])
    const linked = await push(id, {
      nodes: [{ ...node("blk_new", "new", "ul"), updated_at: T0 + 10 }],
      links: [{ ...link(A3, "blk_new", "a0"), updated_at: T0 + 10 }],
    })
    expect(linked.status).toBe(200)
    const born = await push(id, {
      nodes: [{ ...node("blk_born", "born", "ul", NOTE_A), updated_at: T0 + 10 }],
      links: [],
    })
    expect(born.status).toBe(200)
    const orphan = await push(id, {
      nodes: [{ ...node("blk_orphan", "orphan", "ul"), updated_at: T0 + 10 }],
      links: [],
    })
    expect(orphan.status).toBe(403)
    const bornElsewhere = await push(id, {
      nodes: [{ ...node("blk_elsewhere", "x", "ul", NOTE_B), updated_at: T0 + 10 }],
      links: [],
    })
    expect(bornElsewhere.status).toBe(403)

    const body: SliceBody = await bodyOf(await slice(id))
    expect(sliceIds(body)).toContain("blk_new")
    expect(await ownerNode("blk_orphan")).toBeUndefined()
  })

  it("needs delete to tombstone a block, and write to unlink one", async () => {
    const writer = await share(["read", "write"])
    const tombstone = await push(writer, {
      nodes: [{ ...edit(A2, "two"), deleted_at: T0 + 10 }],
      links: [],
    })
    expect(tombstone.status).toBe(403)
    expect((await bodyOf(tombstone)).error).toBe("permission_denied")
    expect((await ownerNode(A2))?.deleted_at).toBeNull()

    const unlink = await push(writer, {
      nodes: [],
      links: [{ ...link(A1, A2, "a0"), updated_at: T0 + 10, deleted_at: T0 + 10 }],
    })
    expect(unlink.status).toBe(200)

    const deleter = await share(["read", "write", "delete"])
    const deleted = await push(deleter, {
      nodes: [{ ...edit(A3, "three"), deleted_at: T0 + 20 }],
      links: [],
    })
    expect(deleted.status).toBe(200)
    expect((await ownerNode(A3))?.deleted_at).toBe(T0 + 20)
  })

  it("leaves the owner's cursor alone and refuses the purge channel", async () => {
    const id = await share(["read", "write"])
    const before = await harness.control.exec(
      "SELECT value FROM meta WHERE user_id = ?1 AND key = 'replica_cursor'",
      [OWNER],
    )
    const response = await push(id, { nodes: [edit(A1, "x")], links: [], cursor: "999" })
    expect(response.status).toBe(200)
    const after = await harness.control.exec(
      "SELECT value FROM meta WHERE user_id = ?1 AND key = 'replica_cursor'",
      [OWNER],
    )
    expect(after).toEqual(before)

    const purge = await push(id, { nodes: [], links: [], deleteNodes: [A1] })
    expect(purge.status).toBe(400)
    expect((await ownerNode(A1))?.deleted_at).toBeNull()
  })

  it("is per-row last-writer-wins, like any other device", async () => {
    const id = await share(["read", "write"])
    const stale = await push(id, { nodes: [edit(A1, "stale", T0 - 1)], links: [] })
    expect(stale.status).toBe(200)
    expect((await ownerNode(A1))?.text).toBe("one")
  })

  it("refuses a malformed payload", async () => {
    const id = await share(["read", "write"])
    expect((await push(id, { nodes: "no" })).status).toBe(400)
  })

  it("keeps a row's type and the owner's props, and never makes a note", async () => {
    const id = await share(["read", "write", "delete"])
    const retyped = await push(id, { nodes: [{ ...edit(A1, "one"), type: "note" }], links: [] })
    expect(retyped.status).toBe(403)
    expect((await ownerNode(A1))?.type).toBe("ul")

    const widened = await push(id, {
      nodes: [{ ...edit(A1, "one"), props: '{"width":"wide"}' }],
      links: [],
    })
    expect(widened.status).toBe(403)
    expect((await bodyOf(widened)).detail).toContain("width")
    expect((await ownerNode(A1))?.props).toBeNull()

    const madeNote = await push(id, {
      nodes: [{ ...node("blk_page", "a note of theirs", "note"), updated_at: T0 + 10 }],
      links: [{ ...link(A1, "blk_page", "a9"), updated_at: T0 + 10 }],
    })
    expect(madeNote.status).toBe(403)
    expect(await ownerNode("blk_page")).toBeUndefined()
  })

  it("keeps a row's home note, and its clocks never run ahead of the server", async () => {
    const id = await share(["read", "write"])
    const before = Date.now()
    const response = await push(id, {
      nodes: [{ ...edit(A1, "rehomed"), notes_id: NOTE_B, updated_at: before + 86_400_000 }],
      links: [],
    })
    expect(response.status).toBe(200)
    const row = await ownerNode(A1)
    expect(row?.text).toBe("rehomed")
    expect(row?.notes_id).toBe(NOTE_A)
    expect(Number(row?.updated_at)).toBeLessThanOrEqual(Date.now())
    expect(Number(row?.updated_at)).toBeGreaterThanOrEqual(before)
  })
})

// -----------------------------------------------------------------------------
// End to end: the client's own diff path against the handler
// -----------------------------------------------------------------------------

describe("the client's push", () => {
  /** What the grantee's runtime does: walk the slice, edit the doc, diff it
   * into ops (`docToOps`), turn the ops into rows (`opsToRows`), push. */
  async function editShared(
    id: string,
    change: (doc: ReturnType<typeof noteDoc>) => ReturnType<typeof noteDoc>,
  ) {
    const body: SliceBody = await bodyOf(await slice(id))
    const snapshot = buildGraphSnapshot(body.nodes, body.links)
    const before = noteDoc(NOTE_A, snapshot)
    const after = change(before)
    if (!before || !after) throw new Error("no doc")
    const ops = docToOps(NOTE_A, after, snapshot)
    const diff = opsToRows(snapshot, ops, T0 + 100)
    return push(id, { nodes: diff.nodes, links: diff.links })
  }

  it("lands a typed edit and a new block exactly as the app produces them", async () => {
    const id = await share(["read", "write"])
    const typed = await editShared(
      id,
      (doc) =>
        doc && {
          ...doc,
          blocks: { ...doc.blocks, [A2]: { ...doc.blocks[A2], text: "two, edited" } },
        },
    )
    expect(typed.status).toBe(200)
    expect((await ownerNode(A2))?.text).toBe("two, edited")

    const added = await editShared(
      id,
      (doc) =>
        doc && {
          ...doc,
          blocks: {
            ...doc.blocks,
            blk_added: { id: "blk_added", type: "ul", text: "added", children: [] },
          },
          rootBlockIds: [...doc.rootBlockIds, "blk_added"],
        },
    )
    expect(added.status).toBe(200)
    expect((await ownerNode("blk_added"))?.text).toBe("added")
    const body: SliceBody = await bodyOf(await slice(id))
    expect(sliceIds(body)).toContain("blk_added")
  })

  it("removes a block from the outline with write, but deletes it only with delete", async () => {
    const writer = await share(["read", "write"])
    // Removing a row is an unlink (the block keeps its note and goes to the
    // owner's Unassigned basket) — a write, so it lands.
    const removed = await editShared(
      writer,
      (doc) => doc && { ...doc, rootBlockIds: doc.rootBlockIds.filter((root) => root !== A3) },
    )
    expect(removed.status).toBe(200)
    expect((await ownerNode(A3))?.deleted_at).toBeNull()
    expect(sliceIds(await bodyOf(await slice(writer)))).not.toContain(A3)

    // The context menu's Delete tombstones the node: refused without `delete`.
    const body: SliceBody = await bodyOf(await slice(writer))
    const snapshot = buildGraphSnapshot(body.nodes, body.links)
    const diff = opsToRows(snapshot, deleteBlockOps(A1, snapshot), T0 + 200)
    const refused = await push(writer, { nodes: diff.nodes, links: diff.links })
    expect(refused.status).toBe(403)
    expect((await ownerNode(A1))?.deleted_at).toBeNull()

    const deleter = await share(["read", "write", "delete"])
    const deleted = await push(deleter, { nodes: diff.nodes, links: diff.links })
    expect(deleted.status).toBe(200)
    expect((await ownerNode(A1))?.deleted_at).toBe(T0 + 200)
  })
})
