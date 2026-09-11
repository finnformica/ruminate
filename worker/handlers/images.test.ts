// tenant-guard: exempt — no SQL here; the fake bucket is keyed by tenant on
// purpose so the cross-tenant assertions below prove the prefix scoping.
import { describe, expect, it } from "vitest"
import migration0003 from "../../migrations/0003_control_plane.sql?raw"
import type { Env } from "../types"
import { imageIdOfUrl, imageUrlOf, isImageId, isImageMime, newImageId } from "./image-policy"
import { images } from "./images"
import { asFakeD1, createTenantTestDriver } from "./sqlite-test-driver"

/** Just enough of R2 for the handler: put/get by key, metadata kept. */
function fakeBucket() {
  const objects = new Map<string, { bytes: ArrayBuffer; contentType?: string }>()
  const bucket = {
    async put(
      key: string,
      value: ArrayBuffer,
      options?: { httpMetadata?: { contentType?: string } },
    ) {
      objects.set(key, { bytes: value, contentType: options?.httpMetadata?.contentType })
      return null
    },
    async get(key: string) {
      const found = objects.get(key)
      if (!found) return null
      return {
        body: found.bytes,
        size: found.bytes.byteLength,
        httpEtag: `"etag-${key}"`,
        httpMetadata: { contentType: found.contentType },
      }
    },
  }
  return { bucket: bucket as unknown as R2Bucket, objects }
}

function githubStub(users: Record<string, { id: number }>): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) !== "https://api.github.com/user") {
      throw new Error(`Unexpected outbound fetch: ${String(input)}`)
    }
    const auth = (init?.headers as Record<string, string> | undefined)?.["Authorization"] ?? ""
    const token = /^Bearer (.+)$/.exec(auth)?.[1] ?? ""
    const user = users[token]
    if (!user) return new Response("{}", { status: 401 })
    return new Response(JSON.stringify({ id: user.id, login: `u${user.id}` }), { status: 200 })
  }) as typeof fetch
}

async function testEnv(
  overrides: Partial<Env> = {},
): Promise<{ env: Env; objects: Map<string, unknown> }> {
  const driver = await createTenantTestDriver()
  await driver.execScript(migration0003)
  const { bucket, objects } = fakeBucket()
  const env = {
    DB: asFakeD1(driver),
    SIGNUP_MODE: "open",
    IMAGES: bucket,
    VITE_IMAGES_ENABLED: "true",
    ...overrides,
  } as unknown as Env
  return { env, objects }
}

const github = githubStub({ alice: { id: 1001 }, bob: { id: 1002 } })
const headers = (token: string, extra: Record<string, string> = {}) => ({
  Cookie: "gh_refresh=session",
  Authorization: `Bearer ${token}`,
  ...extra,
})
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4])

function upload(token: string, body: BodyInit, type = "image/png") {
  return new Request("https://example.com/api/images", {
    method: "POST",
    headers: headers(token, { "Content-Type": type }),
    body,
  })
}
const read = (token: string, id: string) =>
  new Request(`https://example.com/api/images/${id}`, { headers: headers(token) })

describe("image policy", () => {
  it("mints ids the reader accepts and the URL round-trips", () => {
    const id = newImageId(() => "6F9619FF-8B86-D011-B42D-00C04FC964FF")
    expect(id).toBe("img_6f9619ff8b86d011b42d00c0")
    expect(isImageId(id)).toBe(true)
    expect(imageIdOfUrl(imageUrlOf(id))).toBe(id)
  })

  it("rejects ids that could steer a key, and foreign URLs", () => {
    expect(isImageId("../1002/img_abcdefghijkl")).toBe(false)
    expect(isImageId("img_ABC")).toBe(false)
    expect(imageIdOfUrl("https://elsewhere.example/api/images/img_abcdefghijklmn")).toBeNull()
    expect(imageIdOfUrl("/api/images/nope")).toBeNull()
  })

  it("accepts the raster formats only", () => {
    expect(isImageMime("image/png")).toBe(true)
    expect(isImageMime("image/jpeg; charset=binary")).toBe(true)
    expect(isImageMime("image/svg+xml")).toBe(false)
    expect(isImageMime("text/html")).toBe(false)
  })
})

describe("/api/images", () => {
  it("requires a session", async () => {
    const { env } = await testEnv()
    const response = await images(
      new Request("https://example.com/api/images", { method: "POST", body: png }),
      env,
      github,
    )
    expect(response.status).toBe(401)
  })

  it("answers 501 when the feature is switched off, even for a valid session", async () => {
    const off = await testEnv({ VITE_IMAGES_ENABLED: undefined })
    expect((await images(upload("alice", png), off.env, github)).status).toBe(501)
    const unbound = await testEnv({ IMAGES: undefined })
    expect((await images(upload("alice", png), unbound.env, github)).status).toBe(501)
  })

  it("stores an upload under the tenant's prefix and serves it back, immutable", async () => {
    const { env, objects } = await testEnv()
    const created = await images(upload("alice", png), env, github)
    expect(created.status).toBe(201)
    const { id, size, type } = (await created.json()) as { id: string; size: number; type: string }
    expect(isImageId(id)).toBe(true)
    expect(size).toBe(png.byteLength)
    expect(type).toBe("image/png")
    expect([...objects.keys()]).toEqual([`1001/${id}`])

    const served = await images(read("alice", id), env, github)
    expect(served.status).toBe(200)
    expect(served.headers.get("Content-Type")).toBe("image/png")
    expect(served.headers.get("Cache-Control")).toContain("immutable")
    expect(served.headers.get("X-Content-Type-Options")).toBe("nosniff")
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(png)
  })

  it("never serves one tenant's picture to another", async () => {
    const { env } = await testEnv()
    const created = await images(upload("alice", png), env, github)
    const { id } = (await created.json()) as { id: string }
    expect((await images(read("bob", id), env, github)).status).toBe(404)
    expect((await images(read("alice", id), env, github)).status).toBe(200)
  })

  it("rejects what it will not store: wrong type, empty, too large, bad id", async () => {
    const { env } = await testEnv()
    expect((await images(upload("alice", png, "image/svg+xml"), env, github)).status).toBe(415)
    expect((await images(upload("alice", new Uint8Array(0)), env, github)).status).toBe(400)
    const huge = new Request("https://example.com/api/images", {
      method: "POST",
      headers: headers("alice", { "Content-Type": "image/png", "Content-Length": "99999999" }),
      body: png,
    })
    expect((await images(huge, env, github)).status).toBe(413)
    expect((await images(read("alice", "img_ABC"), env, github)).status).toBe(404)
    expect((await images(read("alice", "img_abcdefghijklmnop"), env, github)).status).toBe(404)
  })

  it("knows no other routes", async () => {
    const { env } = await testEnv()
    const response = await images(
      new Request("https://example.com/api/images/img_abcdefghijklmnop", {
        method: "DELETE",
        headers: headers("alice"),
      }),
      env,
      github,
    )
    expect(response.status).toBe(404)
  })
})
