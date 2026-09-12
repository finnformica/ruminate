// The MCP endpoint — `POST /mcp` (docs/mcp-server.md).
//
// AUTH & TENANCY, the same shape the replica handler has, with a different
// credential. The replica is reached by a BROWSER, so it authenticates with
// the things a browser has: the `gh_refresh` cookie plus a GitHub access
// token. An agent has neither, so it presents an `rmn_mcp_…` token the user
// minted in Settings, and that token resolves to three things and no others:
//
//   whose corpus  → `grant.userId`, a verified GitHub id written under a real
//                   session at mint time, re-checked against `users.status`
//                   on every request (`tenantIsActive`) so blocking a user
//                   kills their agents too;
//   what verbs    → `grant.permissions`;
//   which notes   → `grant.noteIds`.
//
// TENANT-SCOPING INVARIANT: as in `replica.ts`, the only handle this file
// hands to corpus code is `forTenant(corpusDriver(env), …)`, minted from the
// token row's `user_id` and from nothing else. No path segment, query param,
// header, tool argument or body field reaches it. Under column-scoped tenancy
// that mint is backed by the runtime guard in `TenantDb`, and the second
// boundary — which of this tenant's notes — is `graph-access.ts`, derived
// from the grant. Both halves are pinned by the adversarial tests in
// `mcp.test.ts`.
//
// STATELESS: protocol revision 2026-07-28 has no sessions and no handshake
// (see `mcp/protocol.ts`), so this handler is a pure function of one request.
// There is no `Mcp-Session-Id` to mint, nothing to keep between calls, and no
// Durable Object — the one this project had was deleted in migration `v2` and
// this does not bring it back.

import { controlPlaneDriver, corpusDriver, forTenant, type TenantDb } from "../tenancy-db"
import type { Env } from "../types"
import { describeGrant, type Grant } from "../mcp/grant"
import {
  CACHE_HINT,
  ERROR,
  SUPPORTED_VERSIONS,
  discoverCacheHint,
  errorBody,
  parseMessage,
  result,
  validateRequest,
  type JsonRpcId,
  type ProtocolError,
} from "../mcp/protocol"
import { callTool, toolsFor } from "../mcp/tools"
import { findGrant, tenantIsActive, touchToken } from "../mcp/tokens"

/** The MCP endpoint's path. */
export const MCP_PATH = "/mcp"

/** Reject bodies larger than this. A tool call is arguments, not a corpus. */
const MAX_BODY_BYTES = 1024 * 1024

/** How an unauthenticated caller is told what to do about it. RFC 6750's
 * challenge, naming the page that mints a token — there is no OAuth
 * authorization server to point at, and saying so plainly beats advertising
 * a discovery document that leads nowhere. */
const challenge = (origin: string, error: string, description: string) =>
  `Bearer realm="ruminate", error="${error}", error_description="${description}", ` +
  `mint_uri="${origin}/settings"`

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  })
}

const protocolFailure = (error: ProtocolError, headers?: Record<string, string>): Response =>
  json(errorBody(error), error.status, headers)

/**
 * Route `/mcp`.
 *
 * `GET` and `DELETE` answer `405`: both were part of Streamable HTTP before
 * this revision (the standalone SSE stream, and session termination), and the
 * spec asks a server that implements only 2026-07-28 to refuse them that way
 * so an older client fails loudly instead of hanging.
 */
export async function mcp(request: Request, env: Env): Promise<Response> {
  const origin = new URL(request.url).origin

  if (request.method === "GET" || request.method === "DELETE") {
    return json(
      { error: "method_not_allowed", detail: "This MCP endpoint accepts POST only." },
      405,
      { Allow: "POST" },
    )
  }
  if (request.method !== "POST")
    return json({ error: "method_not_allowed" }, 405, { Allow: "POST" })

  // DNS-rebinding protection, as the transport spec requires. Agents are not
  // browsers and send no `Origin`; a browser page that does send one must be
  // this app's own, or a page on any site could drive a user's agent token
  // through their browser.
  const requestOrigin = request.headers.get("Origin")
  if (requestOrigin !== null && requestOrigin !== origin) {
    return json(
      { jsonrpc: "2.0", error: { code: ERROR.invalidRequest, message: "Forbidden origin" } },
      403,
    )
  }

  const contentLength = Number(request.headers.get("Content-Length") ?? "0")
  if (contentLength > MAX_BODY_BYTES) {
    return protocolFailure({
      status: 413,
      code: ERROR.invalidRequest,
      message: "Request body too large.",
      id: null,
    })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return protocolFailure({
      status: 400,
      code: ERROR.parse,
      message: "Body is not valid JSON.",
      id: null,
    })
  }

  const message = parseMessage(body)
  if ("status" in message) return protocolFailure(message)

  // Header/body agreement comes BEFORE auth: it is a transport-level
  // contradiction, the same answer for everyone, and answering it first means
  // a malformed request never costs a control-plane read.
  const invalid = validateRequest(request.headers, message)
  if (invalid) return protocolFailure(invalid)

  // A notification, per the transport: accepted, no body. This revision
  // defines no client-to-server notifications, so there is nothing to do with
  // one but acknowledge it.
  if (message.isNotification) return new Response(null, { status: 202 })

  // `server/discover` is the one method served without a token — it says
  // which protocol versions this build speaks and nothing about anybody's
  // notes. With a token it additionally describes the grant.
  const presented = bearerToken(request)
  if (message.method === "server/discover" && presented === null) {
    return json(discoverResult(message.id, null))
  }

  if (presented === null) {
    return json(
      errorBody({
        status: 401,
        code: ERROR.invalidRequest,
        message: "Authorization required.",
        id: message.id,
      }),
      401,
      {
        "WWW-Authenticate": challenge(origin, "invalid_request", "An MCP token is required."),
      },
    )
  }

  const control = controlPlaneDriver(env)
  const found = await findGrant(control, presented)
  if (!found.ok) {
    const description =
      found.refusal === "expired"
        ? "This MCP token has expired. Mint a new one in Ruminate's settings."
        : found.refusal === "revoked"
          ? "This MCP token has been revoked."
          : "This MCP token is not valid."
    return json(
      errorBody({ status: 401, code: ERROR.invalidRequest, message: description, id: message.id }),
      401,
      { "WWW-Authenticate": challenge(origin, "invalid_token", description) },
    )
  }

  const grant = found.grant
  if (!(await tenantIsActive(control, grant.userId))) {
    return json(
      errorBody({
        status: 403,
        code: ERROR.invalidRequest,
        message: "This account cannot be accessed.",
        id: message.id,
      }),
      403,
    )
  }

  // THE tenant-scoping invariant (see the header comment): the only input to
  // the tenant handle is the user id on the token row.
  const tenant = forTenant(corpusDriver(env), {
    id: grant.userId,
    login: String(grant.userId),
    name: null,
  })

  const response = await dispatch(message.method, message.id, message.params, grant, tenant)

  // After the answer, never before: `last_used_at` is bookkeeping, and a
  // failure to record it must not fail the call the user asked for.
  try {
    await touchToken(control, grant.tokenId)
  } catch {
    // Deliberately swallowed — see above.
  }
  return response
}

/** `Authorization: Bearer <token>`, or null. */
function bearerToken(request: Request): string | null {
  const match = /^Bearer\s+(\S+)$/.exec(request.headers.get("Authorization") ?? "")
  return match ? match[1] : null
}

function discoverResult(id: JsonRpcId, grant: Grant | null): Record<string, unknown> {
  return result(id, {
    supportedVersions: SUPPORTED_VERSIONS,
    capabilities: { tools: {} },
    instructions:
      "Ruminate is an outliner: a note is a tree of typed blocks, and the same " +
      "block can appear in more than one note. Start with `list_notes` or " +
      "`search`, then `read_note` for a note's markdown, or `get_node` / " +
      "`list_children` / `list_parents` to walk the graph a block at a time. " +
      "When writing a note back with `update_note`, keep the `id::` lines you " +
      "were given — they are what keeps a block the same block. " +
      (grant === null
        ? "Authenticate with an MCP token from Ruminate's settings page."
        : `This token has ${describeGrant(grant)}.`),
    ...discoverCacheHint(grant !== null),
  })
}

async function dispatch(
  method: string,
  id: JsonRpcId,
  params: Record<string, unknown>,
  grant: Grant,
  tenant: TenantDb,
): Promise<Response> {
  switch (method) {
    case "server/discover":
      return json(discoverResult(id, grant))

    case "tools/list": {
      const tools = toolsFor(grant).map((tool) => ({
        name: tool.name,
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: tool.annotations,
      }))
      // No `nextCursor`: eleven tools is one page, and paginating a list this
      // size would be a promise to keep rather than a feature.
      return json(result(id, { tools, ...CACHE_HINT }))
    }

    case "tools/call": {
      const name = params.name
      if (typeof name !== "string") {
        return protocolFailure({
          status: 400,
          code: ERROR.invalidParams,
          message: "`params.name` is required.",
          id,
        })
      }
      const args =
        typeof params.arguments === "object" &&
        params.arguments !== null &&
        !Array.isArray(params.arguments)
          ? (params.arguments as Record<string, unknown>)
          : {}

      // No `meta` seeding here, deliberately. The replica path seeds a new
      // tenant's `schema_version` / `replica_cursor` because its own protocol
      // reads them; nothing on this path does — the MCP write plan takes its
      // sequence from `nodes`/`link` and never moves the cursor — so seeding
      // would be two writes on every single tool call to no end. A tenant
      // whose corpus an agent wrote first is seeded by `readyTenant` the
      // moment a browser syncs it.
      const called = await callTool(grant, tenant, name, args)
      if (called.kind === "unknown_tool") {
        return protocolFailure({
          status: 200,
          code: ERROR.invalidParams,
          message: called.message,
          id,
        })
      }

      const outcome = called.outcome
      if (!outcome.ok) {
        return json(
          result(id, {
            content: [{ type: "text", text: outcome.message }],
            isError: true,
          }),
        )
      }
      return json(
        result(id, {
          content: [{ type: "text", text: outcome.text }],
          structuredContent: outcome.data,
          isError: false,
        }),
      )
    }

    default:
      // 404 with a JSON-RPC error body, which is how the spec has a client
      // tell "unknown method" from "not an MCP endpoint at all".
      return protocolFailure({
        status: 404,
        code: ERROR.methodNotFound,
        message: `Method not found: ${method}. This server implements server/discover, tools/list and tools/call.`,
        id,
      })
  }
}
