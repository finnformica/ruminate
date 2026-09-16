// tenant-guard: exempt — no SQL here; the route reads a session and fetches
// a page, and the tests are about what it will fetch and what it reads.
import { describe, expect, it } from "vitest"
import type { Env } from "../types"
import { MAX_BYTES, previewOf, publicWebUrl, unfurl } from "./unfurl"
import {
  applyControlPlane,
  asFakeD1,
  createTenantTestDriver,
  signInUser,
} from "./sqlite-test-driver"

async function testEnv(): Promise<Env> {
  const driver = await createTenantTestDriver()
  await applyControlPlane(driver)
  await signInUser(driver, 1001, "alice")
  return { DB: asFakeD1(driver), SIGNUP_MODE: "open" } as unknown as Env
}

type Stub = (url: string, init?: RequestInit) => Response | Promise<Response>

/** GitHub answers the session check; every other address goes to `pages`. */
function fetchStub(pages: Record<string, Stub>, log: string[] = []): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url === "https://api.github.com/user") {
      const auth = (init?.headers as Record<string, string> | undefined)?.["Authorization"] ?? ""
      return auth === "Bearer alice"
        ? new Response(JSON.stringify({ id: 1001, login: "alice" }), { status: 200 })
        : new Response("{}", { status: 401 })
    }
    log.push(url)
    const page = pages[url]
    if (!page) throw new TypeError(`fetch failed: ${url}`)
    return page(url, init)
  }) as typeof fetch
}

const html = (body: string, headers: Record<string, string> = {}) =>
  new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8", ...headers },
  })

const request = (address: string, token = "alice") =>
  new Request(`https://example.com/api/unfurl?url=${encodeURIComponent(address)}`, {
    headers: { Cookie: "gh_refresh=session", Authorization: `Bearer ${token}` },
  })

const PAGE = `<!doctype html><html><head>
  <title>Fallback &amp; title</title>
  <meta charset="utf-8">
  <meta property="og:title" content="Lisbon in three days &#8212; a guide">
  <meta content="A short guide   to the city." property="og:description">
  <meta property="og:image" content="/img/lisbon.jpg">
  <meta property="og:site_name" content="Travel Weekly">
  <link rel="stylesheet" href="/style.css">
  <link rel="shortcut icon" href="/favicon.png">
</head><body><p>Body</p></body></html>`

describe("publicWebUrl", () => {
  it("takes an http(s) address with a public host", () => {
    expect(publicWebUrl("https://example.com/a?b=c")?.toString()).toBe("https://example.com/a?b=c")
    expect(publicWebUrl("http://news.example.org")?.toString()).toBe("http://news.example.org/")
    expect(publicWebUrl("https://93.184.216.34/")?.hostname).toBe("93.184.216.34")
  })

  it("refuses anything that is not a public web address", () => {
    for (const address of [
      "not a url",
      "ftp://example.com/x",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "https://user:pass@example.com/",
      "http://localhost:8787/",
      "http://app.localhost/",
      "http://intranet/",
      "http://printer.local/",
      "http://db.internal/",
      "http://127.0.0.1/",
      "http://10.1.2.3/",
      "http://172.16.0.1/",
      "http://192.168.1.1/",
      "http://169.254.169.254/latest/meta-data/",
      "http://100.64.0.1/",
      "http://0.0.0.0/",
      "http://[::1]/",
      "http://[fd00::1]/",
      "http://[fe80::1]/",
      "http://[::ffff:10.0.0.1]/",
    ]) {
      expect(publicWebUrl(address), address).toBeNull()
    }
  })
})

describe("previewOf", () => {
  it("reads the Open Graph tags, in either attribute order, and resolves addresses", () => {
    const preview = previewOf("https://www.travel.example/lisbon", "text/html", PAGE)
    expect(preview).toEqual({
      url: "https://www.travel.example/lisbon",
      title: "Lisbon in three days — a guide",
      description: "A short guide to the city.",
      image: "https://www.travel.example/img/lisbon.jpg",
      favicon: "https://www.travel.example/favicon.png",
      site: "Travel Weekly",
    })
  })

  it("falls back to the title tag, the plain description and /favicon.ico", () => {
    const preview = previewOf(
      "https://www.plain.example/page",
      "text/html",
      `<html><head><title> Just a &lt;page&gt; </title><meta name="description" content="Plain."></head></html>`,
    )
    expect(preview).toEqual({
      url: "https://www.plain.example/page",
      title: "Just a <page>",
      description: "Plain.",
      favicon: "https://www.plain.example/favicon.ico",
      site: "plain.example",
    })
  })

  it("yields the address and its host for a page that is not HTML, or says nothing", () => {
    expect(previewOf("https://files.example/a.pdf", "application/pdf", "")).toEqual({
      url: "https://files.example/a.pdf",
      site: "files.example",
    })
    expect(previewOf("https://www.bare.example/", "text/html", "<html></html>")).toEqual({
      url: "https://www.bare.example/",
      favicon: "https://www.bare.example/favicon.ico",
      site: "bare.example",
    })
  })

  it("keeps an image only when it is a web address, and cuts a long description", () => {
    const long = "x".repeat(600)
    const preview = previewOf(
      "https://a.example/",
      "text/html",
      `<meta property="og:image" content="data:image/png;base64,AAAA"><meta property="og:description" content="${long}">`,
    )
    expect(preview.image).toBeUndefined()
    expect(preview.description).toHaveLength(500)
    expect(preview.description?.endsWith("…")).toBe(true)
  })
})

describe("/api/unfurl", () => {
  it("requires a session", async () => {
    const env = await testEnv()
    const response = await unfurl(request("https://example.org/", "nobody"), env, fetchStub({}))
    expect(response.status).toBe(401)
  })

  it("refuses an address it will not fetch, without fetching it", async () => {
    const env = await testEnv()
    const log: string[] = []
    const response = await unfurl(request("http://169.254.169.254/"), env, fetchStub({}, log))
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: "invalid_url" })
    expect(log).toEqual([])
  })

  it("answers the page's preview", async () => {
    const env = await testEnv()
    const fetchImpl = fetchStub({ "https://www.travel.example/lisbon": () => html(PAGE) })
    const response = await unfurl(request("https://www.travel.example/lisbon"), env, fetchImpl)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      url: "https://www.travel.example/lisbon",
      title: "Lisbon in three days — a guide",
      site: "Travel Weekly",
    })
  })

  it("follows a redirect, checking each hop, and answers the final address", async () => {
    const env = await testEnv()
    const log: string[] = []
    const fetchImpl = fetchStub(
      {
        "http://short.example/x": () =>
          new Response(null, { status: 301, headers: { Location: "/y" } }),
        "http://short.example/y": () =>
          new Response(null, { status: 302, headers: { Location: "https://long.example/page" } }),
        "https://long.example/page": () => html("<title>Landed</title>"),
      },
      log,
    )
    const response = await unfurl(request("http://short.example/x"), env, fetchImpl)
    expect(await response.json()).toMatchObject({
      url: "https://long.example/page",
      title: "Landed",
    })
    expect(log).toEqual([
      "http://short.example/x",
      "http://short.example/y",
      "https://long.example/page",
    ])
  })

  it("stops at a redirect to a private address", async () => {
    const env = await testEnv()
    const log: string[] = []
    const fetchImpl = fetchStub(
      {
        "https://evil.example/": () =>
          new Response(null, { status: 302, headers: { Location: "http://10.0.0.1/admin" } }),
      },
      log,
    )
    const response = await unfurl(request("https://evil.example/"), env, fetchImpl)
    expect(response.status).toBe(400)
    expect(log).toEqual(["https://evil.example/"])
  })

  it("says a page that fails or will not answer is unreachable", async () => {
    const env = await testEnv()
    const fetchImpl = fetchStub({
      "https://down.example/": () => new Response("nope", { status: 503 }),
    })
    expect((await unfurl(request("https://down.example/"), env, fetchImpl)).status).toBe(502)
    expect((await unfurl(request("https://gone.example/"), env, fetchImpl)).status).toBe(502)
  })

  it("reads no more than the first half megabyte of a page", async () => {
    const env = await testEnv()
    let pulled = 0
    const chunk = new TextEncoder().encode("<p>" + "x".repeat(64 * 1024 - 3))
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1
        if (pulled === 1) {
          controller.enqueue(new TextEncoder().encode("<title>Big</title>"))
          return
        }
        controller.enqueue(chunk)
      },
    })
    const fetchImpl = fetchStub({
      "https://big.example/": () =>
        new Response(body, { status: 200, headers: { "Content-Type": "text/html" } }),
    })
    const response = await unfurl(request("https://big.example/"), env, fetchImpl)
    expect(await response.json()).toMatchObject({ title: "Big" })
    // A few chunks past the cap at most: the read stopped rather than
    // draining a page that never ends.
    expect(pulled).toBeLessThan(MAX_BYTES / chunk.byteLength + 4)
  })

  it("reads a link to this app from its own assets, never by fetching itself", async () => {
    const log: string[] = []
    const shell = new Response("<title>Ruminate</title>", {
      status: 200,
      headers: { "Content-Type": "text/html" },
    })
    const env = {
      ...(await testEnv()),
      ASSETS: { fetch: async () => shell.clone() } as unknown as Fetcher,
    } as Env
    const response = await unfurl(
      request("https://example.com/notes/blk_abc"),
      env,
      fetchStub({}, log),
    )
    expect(await response.json()).toEqual({
      url: "https://example.com/notes/blk_abc",
      title: "Ruminate",
      favicon: "https://example.com/favicon.ico",
      site: "example.com",
    })
    expect(log).toEqual([])
    // Without the binding, the address and its host.
    const bare = await unfurl(
      request("https://example.com/notes/x"),
      await testEnv(),
      fetchStub({}, log),
    )
    expect(await bare.json()).toEqual({ url: "https://example.com/notes/x", site: "example.com" })
    expect(log).toEqual([])
  })

  it("answers the address and host for a page that is not HTML", async () => {
    const env = await testEnv()
    const fetchImpl = fetchStub({
      "https://files.example/report.pdf": () =>
        new Response("%PDF", { status: 200, headers: { "Content-Type": "application/pdf" } }),
    })
    const response = await unfurl(request("https://files.example/report.pdf"), env, fetchImpl)
    expect(await response.json()).toEqual({
      url: "https://files.example/report.pdf",
      site: "files.example",
    })
  })
})
