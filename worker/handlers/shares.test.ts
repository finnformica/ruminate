// tenant-guard: exempt — this suite reads raw storage (both users' rows,
// tombstones included) on purpose: that is how it proves the slice holds.
import { beforeEach, describe, expect, it } from "vitest"
import migration0012 from "../../migrations/0012_shares.sql?raw"
import { setFeatureAudience } from "../features"
import { createMcpTestEnv, type McpTestEnv } from "../mcp/test-support"
import type { SharesListBody, SliceBody } from "../shares/wire"
import { corpusPut } from "./replica-corpus"
import type { LinkRow, NodeRow } from "./replica-payload"
import { shares } from "./shares"

/**
 * Sharing, driven end to end through the handler: an owner shares notes with
 * an address, and the person GitHub reports that address for reads the slice
 * beneath them.
 *
 * The properties that matter most are the ones about what is NOT possible:
 * nothing outside the closure is ever serialized, nothing a grantee sends
 * reaches the owner's rows, and a share id names nothing to anyone but its
 * grantee.
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

async function share(rootIds: string[] = [NOTE_A], email = "u8@example.com"): Promise<string> {
  const response = await send(apiRequest("POST", "", { email, rootIds }))
  expect(response.status).toBe(201)
  return (await bodyOf(response)).share.id as string
}

const slice = async (id: string, session = "grantee") =>
  send(apiRequest("GET", `/${id}/notes`, undefined, session))

const sliceIds = (body: SliceBody) => body.nodes.map((row) => row.id).sort()

beforeEach(async () => {
  harness = await createMcpTestEnv()
  await harness.control.execScript(migration0012)
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
    // No write route: a grantee's PUT is refused before it names any row.
    const id = await share()
    expect(
      (await send(apiRequest("PUT", `/${id}/notes`, { nodes: [], links: [] }, "grantee"))).status,
    ).toBe(405)
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
        "INSERT INTO shares (id, owner_id, grantee_email, root_ids, permissions, created_at) " +
          "VALUES ('shr_x', ?1, ?2, '[]', 'read', 1)",
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
      apiRequest("POST", "", { email: " U8@Example.com ", rootIds: [NOTE_A] }),
    )
    expect(response.status).toBe(201)
    const { share: created } = await bodyOf(response)
    expect(created.id).toMatch(/^shr_/)
    expect(created.granteeEmail).toBe("u8@example.com")
    expect(created.rootIds).toEqual([NOTE_A])
    expect(created.revokedAt).toBeNull()
    // The same answer for an address nobody has signed in with.
    const unknown = await send(
      apiRequest("POST", "", { email: "nobody@example.com", rootIds: [NOTE_A] }),
    )
    expect(unknown.status).toBe(201)
  })

  it("needs an address that looks like one", async () => {
    for (const email of ["", "   ", "bob", "bob@", "@example.com", 7, null]) {
      const response = await send(apiRequest("POST", "", { email, rootIds: [NOTE_A] }))
      expect(response.status).toBe(400)
      expect((await bodyOf(response)).detail).toMatch(/email/)
    }
  })

  it("refuses an empty root list rather than reading it as 'every note'", async () => {
    const response = await send(apiRequest("POST", "", { email: "u8@example.com", rootIds: [] }))
    expect(response.status).toBe(400)
    expect((await bodyOf(response)).detail).toMatch(/at least one note/)
  })

  it("refuses roots that are not the caller's, without telling ghosts from others'", async () => {
    await harness.seedNote(GRANTEE, { id: "blk_theirs", title: "Theirs", markdown: "- x\n" })
    const ghost = await send(
      apiRequest("POST", "", { email: "u8@example.com", rootIds: ["blk_ghost"] }),
    )
    const theirs = await send(
      apiRequest("POST", "", { email: "u8@example.com", rootIds: ["blk_theirs"] }),
    )
    for (const response of [ghost, theirs]) {
      expect(response.status).toBe(400)
      expect((await bodyOf(response)).detail).toMatch(/not in your notes/)
    }
    // A block of the caller's own is a fine root.
    expect(
      (await send(apiRequest("POST", "", { email: "u8@example.com", rootIds: [A1] }))).status,
    ).toBe(201)
  })

  it("refuses sharing with yourself", async () => {
    const response = await send(
      apiRequest("POST", "", { email: "U7@example.com", rootIds: [NOTE_A] }),
    )
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
    const refused = await send(
      apiRequest("POST", "", { email: "u8@example.com", rootIds: [NOTE_A] }),
    )
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
    const id = await share()

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
        rootIds: [NOTE_A],
        createdAt: expect.any(Number),
      },
    ])
    // The grantee learns no address but their own.
    expect(JSON.stringify(theirs.received)).not.toContain("@")
    expect(theirs.me).toEqual({ email: "u8@example.com" })
  })

  it("resolves the grantee by address, case-insensitively, and only them", async () => {
    await share([NOTE_A], "U8@EXAMPLE.COM")
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
    const id = await share()
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
    const id = await share()
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
    expect(body).toEqual({ nodes: [], links: [] })
  })

  it("can be rooted at a block: that block and what is beneath it", async () => {
    const id = await share([A1])
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
