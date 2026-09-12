import { beforeEach, describe, expect, it } from "vitest"
import { mintToken } from "../mcp/tokens"
import { createMcpTestEnv, mcpRequest, type McpTestEnv } from "../mcp/test-support"
import { mcp } from "./mcp"

/**
 * The MCP endpoint over HTTP: the transport rules of protocol revision
 * 2026-07-28, and the authentication boundary in front of them.
 *
 * The header-validation tests are not pedantry. The spec mirrors `method` and
 * `params.name` into headers so gateways can route on them, and then requires
 * the server to reject any disagreement — precisely so a gateway that allows
 * `Mcp-Name: read_note` cannot be made to forward a body calling
 * `delete_note`. Each mismatch below is that attack.
 */

const USER = 7
let harness: McpTestEnv
const NOTE = "blk_note"

async function token(overrides: Parameters<typeof mintToken>[1] | null = null): Promise<string> {
  const minted = await mintToken(harness.control, {
    userId: USER,
    name: "Agent",
    permissions: ["read"],
    noteIds: null,
    expiresAt: null,
    ...(overrides ?? {}),
  })
  return minted.token
}

const send = (request: Request) => mcp(request, harness.env)

const bodyOf = async (response: Response) => (await response.json()) as any

beforeEach(async () => {
  harness = await createMcpTestEnv()
  await harness.addUser(USER)
  await harness.seedNote(USER, { id: NOTE, title: "A note", markdown: "- hello world\n" })
})

// -----------------------------------------------------------------------------
// Transport
// -----------------------------------------------------------------------------

describe("transport", () => {
  it("refuses GET and DELETE with 405 — both belong to the retired session transport", async () => {
    for (const method of ["GET", "DELETE"]) {
      const response = await send(new Request("https://ruminate.test/mcp", { method }))
      expect(response.status).toBe(405)
      expect(response.headers.get("Allow")).toBe("POST")
    }
  })

  it("answers a notification with 202 and no body", async () => {
    const request = mcpRequest("server/discover", {}, { id: undefined })
    // `mcpRequest` always sets an id; strip it to make a true notification.
    const body = JSON.parse(await request.text()) as Record<string, unknown>
    delete body.id
    const response = await send(
      new Request(request.url, {
        method: "POST",
        headers: request.headers,
        body: JSON.stringify(body),
      }),
    )

    expect(response.status).toBe(202)
    expect(await response.text()).toBe("")
  })

  it("rejects a cross-origin browser request (DNS rebinding)", async () => {
    const response = await send(
      mcpRequest("server/discover", {}, { headers: { Origin: "https://evil.example" } }),
    )
    expect(response.status).toBe(403)
  })

  it("accepts a same-origin browser request", async () => {
    const response = await send(
      mcpRequest("server/discover", {}, { headers: { Origin: "https://ruminate.test" } }),
    )
    expect(response.status).toBe(200)
  })

  it("rejects a body that is not JSON", async () => {
    const response = await send(
      new Request("https://ruminate.test/mcp", {
        method: "POST",
        headers: { "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "tools/list" },
        body: "{not json",
      }),
    )
    expect(response.status).toBe(400)
    expect((await bodyOf(response)).error.code).toBe(-32700)
  })

  it("answers an unknown method with 404 and a JSON-RPC error", async () => {
    const response = await send(mcpRequest("resources/list", {}, { token: await token() }))
    expect(response.status).toBe(404)
    expect((await bodyOf(response)).error.code).toBe(-32601)
  })
})

// -----------------------------------------------------------------------------
// Header validation
// -----------------------------------------------------------------------------

describe("header validation", () => {
  it("requires MCP-Protocol-Version", async () => {
    const request = mcpRequest("tools/list")
    const headers = new Headers(request.headers)
    headers.delete("MCP-Protocol-Version")
    const response = await send(
      new Request(request.url, { method: "POST", headers, body: await request.text() }),
    )

    expect(response.status).toBe(400)
    expect((await bodyOf(response)).error.code).toBe(-32020)
  })

  it("rejects a protocol version it does not implement, naming the ones it does", async () => {
    const response = await send(mcpRequest("tools/list", {}, { protocolVersion: "1999-01-01" }))
    expect(response.status).toBe(400)

    const body = await bodyOf(response)
    expect(body.error.code).toBe(-32022)
    expect(body.error.data.supported).toEqual(["2026-07-28"])
    expect(body.error.data.requested).toBe("1999-01-01")
  })

  it("rejects a MCP-Protocol-Version header that disagrees with the body", async () => {
    const response = await send(
      mcpRequest("tools/list", {}, { headers: { "MCP-Protocol-Version": "2025-11-25" } }),
    )
    expect(response.status).toBe(400)
    expect((await bodyOf(response)).error.code).toBe(-32020)
  })

  it("rejects an Mcp-Method header that disagrees with the body", async () => {
    const response = await send(
      mcpRequest("tools/list", {}, { headers: { "Mcp-Method": "server/discover" } }),
    )
    expect(response.status).toBe(400)
    expect((await bodyOf(response)).error.code).toBe(-32020)
  })

  it("rejects an Mcp-Name that disagrees with the tool being called", async () => {
    // The attack the rule exists for: a gateway waves through a read, the
    // body asks for a delete.
    const response = await send(
      mcpRequest(
        "tools/call",
        { name: "delete_note", arguments: { note_id: NOTE } },
        { token: await token(), headers: { "Mcp-Name": "read_note" } },
      ),
    )
    expect(response.status).toBe(400)

    const body = await bodyOf(response)
    expect(body.error.code).toBe(-32020)
    expect(body.error.message).toMatch(/read_note/)
  })

  it("requires Mcp-Name on tools/call", async () => {
    const request = mcpRequest("tools/call", { name: "list_notes" }, { token: await token() })
    const headers = new Headers(request.headers)
    headers.delete("Mcp-Name")
    const response = await send(
      new Request(request.url, { method: "POST", headers, body: await request.text() }),
    )

    expect(response.status).toBe(400)
    expect((await bodyOf(response)).error.code).toBe(-32020)
  })

  it("accepts an Mcp-Name carried in the base64 sentinel form", async () => {
    const encoded = `=?base64?${btoa("list_notes")}?=`
    const response = await send(
      mcpRequest(
        "tools/call",
        { name: "list_notes" },
        { token: await token(), headers: { "Mcp-Name": encoded } },
      ),
    )
    expect(response.status).toBe(200)
    expect((await bodyOf(response)).result.isError).toBe(false)
  })

  it("validates headers BEFORE authentication, so a malformed request costs no lookup", async () => {
    const response = await send(mcpRequest("tools/list", {}, { protocolVersion: "1999-01-01" }))
    // No token presented at all, and yet the answer is the version error
    // rather than a 401.
    expect((await bodyOf(response)).error.code).toBe(-32022)
  })
})

// -----------------------------------------------------------------------------
// Authentication
// -----------------------------------------------------------------------------

describe("authentication", () => {
  it("serves server/discover without a token", async () => {
    const response = await send(mcpRequest("server/discover"))
    expect(response.status).toBe(200)

    const body = await bodyOf(response)
    expect(body.result.supportedVersions).toEqual(["2026-07-28"])
    expect(body.result.capabilities.tools).toBeDefined()
    expect(body.result.resultType).toBe("complete")
    expect(body.result._meta["io.modelcontextprotocol/serverInfo"].name).toBe("ruminate")
    expect(body.result.cacheScope).toBe("public")
    // It must say nothing about anyone's notes.
    expect(JSON.stringify(body)).not.toContain(NOTE)
  })

  it("describes the grant on an authenticated server/discover, and caches it privately", async () => {
    const response = await send(mcpRequest("server/discover", {}, { token: await token() }))
    const body = await bodyOf(response)

    expect(body.result.instructions).toMatch(/read access to every note/)
    expect(body.result.cacheScope).toBe("private")
  })

  it("refuses every other method without a token, with a WWW-Authenticate challenge", async () => {
    for (const method of ["tools/list", "tools/call"]) {
      const response = await send(mcpRequest(method, { name: "list_notes" }))
      expect(response.status).toBe(401)
      expect(response.headers.get("WWW-Authenticate")).toMatch(/^Bearer realm="ruminate"/)
      expect(response.headers.get("WWW-Authenticate")).toMatch(/\/settings/)
    }
  })

  it("refuses a token that was never minted", async () => {
    const response = await send(mcpRequest("tools/list", {}, { token: "rmn_mcp_madeup" }))
    expect(response.status).toBe(401)
  })

  it("refuses a credential that is not an MCP token at all", async () => {
    // A GitHub access token, say — the MCP endpoint must not accept one.
    const response = await send(mcpRequest("tools/list", {}, { token: "gho_something" }))
    expect(response.status).toBe(401)
  })

  it("refuses a revoked token, and says so", async () => {
    const secret = await token()
    await harness.control.exec("UPDATE mcp_tokens SET revoked_at = 1 WHERE user_id = ?1", [USER])

    const response = await send(mcpRequest("tools/list", {}, { token: secret }))
    expect(response.status).toBe(401)
    expect(response.headers.get("WWW-Authenticate")).toMatch(/revoked/)
  })

  it("refuses an expired token, and says so", async () => {
    const secret = await token({
      userId: USER,
      name: "Agent",
      permissions: ["read"],
      noteIds: null,
      expiresAt: Date.now() - 1,
    })

    const response = await send(mcpRequest("tools/list", {}, { token: secret }))
    expect(response.status).toBe(401)
    expect(response.headers.get("WWW-Authenticate")).toMatch(/expired/)
  })

  it("refuses a live token whose USER has since been blocked", async () => {
    const secret = await token()
    await harness.addUser(USER, "blocked")

    const response = await send(mcpRequest("tools/list", {}, { token: secret }))
    expect(response.status).toBe(403)
  })

  it("refuses a token whose user has no control-plane row", async () => {
    const minted = await mintToken(harness.control, {
      userId: 999,
      name: "Ghost",
      permissions: ["read"],
      noteIds: null,
      expiresAt: null,
    })
    const response = await send(mcpRequest("tools/list", {}, { token: minted.token }))
    expect(response.status).toBe(403)
  })

  it("never stores the secret it hands out", async () => {
    const secret = await token()
    const rows = await harness.control.exec("SELECT * FROM mcp_tokens WHERE user_id = ?1", [USER])
    expect(JSON.stringify(rows)).not.toContain(secret)
    expect(JSON.stringify(rows)).not.toContain(secret.slice("rmn_mcp_".length))
  })
})

// -----------------------------------------------------------------------------
// tools/list and tools/call
// -----------------------------------------------------------------------------

describe("tools/list", () => {
  it("returns the tools this token permits, with cache hints", async () => {
    const response = await send(mcpRequest("tools/list", {}, { token: await token() }))
    const body = await bodyOf(response)

    const names = body.result.tools.map((tool: any) => tool.name)
    expect(names).toContain("read_note")
    expect(names).not.toContain("delete_note")
    expect(body.result.ttlMs).toBeGreaterThan(0)
    expect(body.result.cacheScope).toBe("private")
  })

  it("gives every tool a name, description, schema and annotations", async () => {
    const body = await bodyOf(await send(mcpRequest("tools/list", {}, { token: await token() })))

    for (const tool of body.result.tools) {
      expect(typeof tool.name).toBe("string")
      expect(tool.description.length).toBeGreaterThan(20)
      expect(tool.inputSchema.type).toBe("object")
      expect(typeof tool.annotations.readOnlyHint).toBe("boolean")
    }
  })

  it("marks every read tool readOnly and only delete_note destructive", async () => {
    const secret = await token({
      userId: USER,
      name: "Full",
      permissions: ["read", "write", "delete"],
      noteIds: null,
      expiresAt: null,
    })
    const body = await bodyOf(await send(mcpRequest("tools/list", {}, { token: secret })))

    const destructive = body.result.tools
      .filter((tool: any) => tool.annotations.destructiveHint)
      .map((tool: any) => tool.name)
    expect(destructive).toEqual(["delete_note"])
  })
})

describe("tools/call", () => {
  it("returns both a text rendering and structured content", async () => {
    const response = await send(
      mcpRequest("tools/call", { name: "list_notes" }, { token: await token() }),
    )
    const body = await bodyOf(response)

    expect(body.result.resultType).toBe("complete")
    expect(body.result.isError).toBe(false)
    expect(body.result.content[0].type).toBe("text")
    expect(body.result.structuredContent.notes[0].id).toBe(NOTE)
  })

  it("reports a business failure as a tool error, not a protocol error", async () => {
    const response = await send(
      mcpRequest(
        "tools/call",
        { name: "read_note", arguments: { note_id: "nope" } },
        { token: await token() },
      ),
    )

    expect(response.status).toBe(200)
    const body = await bodyOf(response)
    expect(body.result.isError).toBe(true)
    expect(body.result.content[0].text).toMatch(/No such note/)
  })

  it("reports a tool the token may not use as a protocol error", async () => {
    const response = await send(
      mcpRequest(
        "tools/call",
        { name: "delete_note", arguments: { note_id: NOTE } },
        { token: await token() },
      ),
    )

    const body = await bodyOf(response)
    expect(body.error.code).toBe(-32602)
    expect(body.error.message).toMatch(/'delete' permission/)
  })

  it("requires params.name", async () => {
    const request = mcpRequest("tools/call", {}, { token: await token() })
    const headers = new Headers(request.headers)
    headers.set("Mcp-Name", "")
    const response = await send(
      new Request(request.url, { method: "POST", headers, body: await request.text() }),
    )
    expect((await bodyOf(response)).error.code).toBe(-32602)
  })

  it("carries an agent's write through to the corpus", async () => {
    const secret = await token({
      userId: USER,
      name: "Writer",
      permissions: ["read", "write"],
      noteIds: null,
      expiresAt: null,
    })
    await send(
      mcpRequest(
        "tools/call",
        { name: "append_to_note", arguments: { note_id: NOTE, markdown: "- from an agent\n" } },
        { token: secret },
      ),
    )

    const read = await bodyOf(
      await send(
        mcpRequest(
          "tools/call",
          { name: "read_note", arguments: { note_id: NOTE } },
          { token: secret },
        ),
      ),
    )
    expect(read.result.structuredContent.markdown).toContain("from an agent")
  })

  it("stamps last_used_at after the call", async () => {
    const secret = await token()
    await send(mcpRequest("tools/call", { name: "list_notes" }, { token: secret }))

    const rows = await harness.control.exec(
      "SELECT last_used_at FROM mcp_tokens WHERE user_id = ?1",
      [USER],
    )
    expect(rows[0].last_used_at).not.toBeNull()
  })
})
