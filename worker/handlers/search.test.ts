// tenant-guard: exempt — no SQL here; the fixture goes in through `seedNote`.
//
// The HTTP half of search: the same ranker as the MCP tool, behind a browser
// session rather than a minted token (docs/semantic-search.md).

import { describe, expect, it } from "vitest"
import { createMcpTestEnv, type McpTestEnv } from "../mcp/test-support"
import { search } from "./search"

const USER = 42536816
const OTHER = 99

const md = (...lines: string[]) => lines.join("\n") + "\n"

const NOTE = md(
  "- # Bake",
  "  id:: blk_bake",
  "  - Cold retard overnight gives the open crumb #food",
  "    id:: blk_retard",
  "  - [ ] Try a longer bulk",
  "    id:: blk_bulk",
)

/** GitHub `/user`, stubbed — the one outbound call this path makes. */
const github: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  if (String(input) !== "https://api.github.com/user") {
    throw new Error(`Unexpected outbound fetch: ${String(input)}`)
  }
  const auth = (init?.headers as Record<string, string> | undefined)?.["Authorization"] ?? ""
  const token = /^Bearer (.+)$/.exec(auth)?.[1] ?? ""
  const ids: Record<string, number> = { owner: USER, other: OTHER }
  if (!(token in ids)) return new Response("{}", { status: 401 })
  return new Response(JSON.stringify({ id: ids[token], login: token }), { status: 200 })
}) as typeof fetch

const get = (url: string, token = "owner") =>
  new Request(`https://ruminate.test${url}`, {
    headers: { Cookie: "gh_refresh=session", Authorization: `Bearer ${token}` },
  })

async function fixture(): Promise<McpTestEnv> {
  const env = await createMcpTestEnv()
  await env.addUser(USER)
  await env.addUser(OTHER)
  await env.seedNote(USER, { id: "note_dough", title: "Sourdough", markdown: NOTE })
  await env.seedNote(OTHER, { id: "note_theirs", title: "Theirs", markdown: NOTE })
  return env
}

describe("GET /api/search", () => {
  it("searches the caller's own corpus", async () => {
    const harness = await fixture()

    const response = await search(get("/api/search?q=overnight"), harness.env, github)
    const body = (await response.json()) as {
      hits: { id: string; noteId: string; noteTitle: string; section: string }[]
      semanticUsed: boolean
    }

    expect(response.status).toBe(200)
    expect(body.hits.map((hit) => hit.id)).toContain("blk_retard")
    expect(body.hits[0].noteTitle).toBe("Sourdough")
    // No bindings in the test env: lexical only, and it says so.
    expect(body.semanticUsed).toBe(false)
  })

  it("takes the app's query language, qualifiers and all", async () => {
    const harness = await fixture()

    const response = await search(get("/api/search?q=type%3Atodo"), harness.env, github)
    const body = (await response.json()) as { hits: { text: string }[] }

    expect(body.hits.map((hit) => hit.text)).toEqual(["Try a longer bulk"])
  })

  it("never reaches another tenant's corpus", async () => {
    const harness = await fixture()

    const response = await search(get("/api/search?q=overnight", "other"), harness.env, github)
    const body = (await response.json()) as { hits: { noteId: string }[] }

    expect(body.hits.length).toBeGreaterThan(0)
    expect(body.hits.every((hit) => hit.noteId === "note_theirs")).toBe(true)
  })

  it("pages with an offset cursor", async () => {
    const harness = await fixture()

    const first = (await (
      await search(get("/api/search?q=type%3Aheading&limit=1"), harness.env, github)
    ).json()) as { hits: unknown[]; nextCursor: string | null }

    expect(first.hits).toHaveLength(1)
    expect(first.nextCursor).toBeNull()
  })

  it("refuses an unauthenticated call before it reads anything", async () => {
    const harness = await fixture()

    const noCookie = new Request("https://ruminate.test/api/search?q=x", {
      headers: { Authorization: "Bearer owner" },
    })
    expect((await search(noCookie, harness.env, github)).status).toBe(401)
    expect((await search(get("/api/search?q=x", "nobody"), harness.env, github)).status).toBe(401)
  })

  it("refuses an empty query and a cursor it did not issue", async () => {
    const harness = await fixture()

    expect((await search(get("/api/search?q=%20"), harness.env, github)).status).toBe(400)
    expect((await search(get("/api/search?q=x&cursor=abc"), harness.env, github)).status).toBe(400)
  })
})

describe("POST /api/search/index", () => {
  it("says so, rather than failing, when the bindings are not configured", async () => {
    const harness = await fixture()

    const response = await search(
      new Request("https://ruminate.test/api/search/index", {
        method: "POST",
        headers: { Cookie: "gh_refresh=session", Authorization: "Bearer owner" },
      }),
      harness.env,
      github,
    )

    expect(response.status).toBe(501)
    expect(await response.json()).toEqual({ error: "semantic_search_not_configured" })
  })

  it("is a POST — a GET on it is not a search", async () => {
    const harness = await fixture()

    const response = await search(get("/api/search/index"), harness.env, github)

    expect(response.status).toBe(405)
  })
})
