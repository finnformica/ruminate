// The MCP wire protocol, revision 2026-07-28 — pure, no Cloudflare types, no
// corpus, no grant. Parsing, validating and framing only; `handlers/mcp.ts`
// does the I/O and `tools.ts` does the work.
//
// ## Why this revision is a good fit
//
// 2026-07-28 removed protocol-level sessions and the `initialize` handshake:
// every request now carries its own protocol version, client identity and
// capabilities in `_meta`, and the server answers each one independently.
// That is the shape a Worker already is — a stateless function of a request —
// so there is nothing to keep between calls, no `Mcp-Session-Id` to mint, no
// Durable Object to hold a session in, and no SSE stream to resume. (Ruminate
// deleted its one Durable Object in migration `v2`; this feature does not
// bring it back.)
//
// Three methods are implemented, which is everything a tools-only server
// needs:
//
//   server/discover  — MUST, per the spec: supported versions + capabilities
//   tools/list       — the tools this caller's token permits
//   tools/call       — run one
//
// Anything else is `-32601` with HTTP 404, which the spec asks for precisely
// so a client can tell "this server does not do that" from "this URL is not
// an MCP endpoint".
//
// ## Header validation is not ceremony
//
// The spec mirrors `method` and `params.name` into `Mcp-Method` / `Mcp-Name`
// headers so intermediaries can route and rate-limit without parsing bodies —
// and then requires the server to REJECT any request where a header and the
// body disagree. That rule is the whole point: without it, a gateway allowing
// `Mcp-Name: read_note` could be made to forward a body calling
// `delete_note`. `validateRequest` enforces it, base64 sentinel decoding
// included.

/** The one protocol revision this server speaks. */
const PROTOCOL_VERSION = "2026-07-28"
export const SUPPORTED_VERSIONS = [PROTOCOL_VERSION]

const SERVER_INFO = { name: "ruminate", version: "1.0.0" } as const

/** `_meta` keys the spec defines. Spelled once. */
const META_PROTOCOL_VERSION = "io.modelcontextprotocol/protocolVersion"
const META_SERVER_INFO = "io.modelcontextprotocol/serverInfo"

/** JSON-RPC + MCP error codes (the spec's `-32020`+ range is reserved for
 * protocol-defined errors; `-32601`/`-32602` are plain JSON-RPC). */
export const ERROR = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  headerMismatch: -32020,
  unsupportedProtocolVersion: -32022,
} as const

export type JsonRpcId = string | number | null

export interface McpRequest {
  id: JsonRpcId
  method: string
  params: Record<string, unknown>
  /** Absent id = a JSON-RPC notification, which is answered `202` with no body. */
  isNotification: boolean
}

export interface ProtocolError {
  /** HTTP status to answer with. */
  status: number
  code: number
  message: string
  data?: unknown
  /** The id to echo, when the body parsed far enough to have one. */
  id: JsonRpcId
}

// -----------------------------------------------------------------------------
// Parsing
// -----------------------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * Parse one JSON-RPC message. Batches are refused: the transport says the
 * body "MUST be a single JSON-RPC request or notification", so an array is a
 * malformed request rather than something to loop over.
 */
export function parseMessage(body: unknown): McpRequest | ProtocolError {
  if (!isRecord(body)) {
    return {
      status: 400,
      code: ERROR.invalidRequest,
      message: "Body must be a JSON-RPC object.",
      id: null,
    }
  }
  const rawId = body.id
  const id: JsonRpcId = typeof rawId === "string" || typeof rawId === "number" ? rawId : null
  if (body.jsonrpc !== "2.0") {
    return { status: 400, code: ERROR.invalidRequest, message: '`jsonrpc` must be "2.0".', id }
  }
  if (typeof body.method !== "string" || body.method.length === 0) {
    return { status: 400, code: ERROR.invalidRequest, message: "`method` is required.", id }
  }
  const params = body.params
  if (params !== undefined && !isRecord(params)) {
    return { status: 400, code: ERROR.invalidRequest, message: "`params` must be an object.", id }
  }
  return {
    id,
    method: body.method,
    params: params ?? {},
    isNotification: rawId === undefined,
  }
}

// -----------------------------------------------------------------------------
// Header validation
// -----------------------------------------------------------------------------

/** The spec's sentinel for a header value that could not be sent as plain
 * ASCII: `=?base64?<base64 of the UTF-8 bytes>?=`. */
function decodeHeaderValue(raw: string): string | null {
  if (!(raw.startsWith("=?base64?") && raw.endsWith("?="))) return raw
  const encoded = raw.slice("=?base64?".length, -"?=".length)
  try {
    const binary = atob(encoded)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
    return new TextDecoder().decode(bytes)
  } catch {
    return null
  }
}

/** Which requests must carry `Mcp-Name`, and what it must equal. */
function expectedName(request: McpRequest): string | null {
  if (request.method === "tools/call" || request.method === "prompts/get") {
    return typeof request.params.name === "string" ? request.params.name : ""
  }
  if (request.method === "resources/read") {
    return typeof request.params.uri === "string" ? request.params.uri : ""
  }
  return null
}

const mismatch = (id: JsonRpcId, message: string): ProtocolError => ({
  status: 400,
  code: ERROR.headerMismatch,
  message: `Header mismatch: ${message}`,
  id,
})

/**
 * The spec's Server Validation rules, in order: the protocol version header
 * must be present, must agree with `_meta`, and must name a version this
 * server implements; `Mcp-Method` must agree with `method`; `Mcp-Name`, where
 * it applies, must agree with the body (after sentinel decoding).
 *
 * A missing `MCP-Protocol-Version` is rejected rather than assumed to mean
 * `2025-03-26`: that fallback exists for servers supporting pre-2025-06-18
 * clients, and this one supports exactly one revision.
 */
export function validateRequest(headers: Headers, request: McpRequest): ProtocolError | null {
  const headerVersion = headers.get("MCP-Protocol-Version")
  if (headerVersion === null) {
    return mismatch(request.id, "the MCP-Protocol-Version header is required.")
  }

  const meta = isRecord(request.params._meta) ? request.params._meta : {}
  const bodyVersion = meta[META_PROTOCOL_VERSION]
  if (typeof bodyVersion === "string" && bodyVersion !== headerVersion) {
    return mismatch(
      request.id,
      `MCP-Protocol-Version header '${headerVersion}' does not match the body's '${bodyVersion}'.`,
    )
  }

  if (!SUPPORTED_VERSIONS.includes(headerVersion)) {
    return {
      status: 400,
      code: ERROR.unsupportedProtocolVersion,
      message: "Unsupported protocol version",
      data: { supported: SUPPORTED_VERSIONS, requested: headerVersion },
      id: request.id,
    }
  }

  const headerMethod = headers.get("Mcp-Method")
  if (headerMethod === null) return mismatch(request.id, "the Mcp-Method header is required.")
  if (headerMethod !== request.method) {
    return mismatch(
      request.id,
      `Mcp-Method header '${headerMethod}' does not match the body's '${request.method}'.`,
    )
  }

  const wantedName = expectedName(request)
  if (wantedName !== null) {
    const rawName = headers.get("Mcp-Name")
    if (rawName === null) {
      return mismatch(request.id, `the Mcp-Name header is required for ${request.method}.`)
    }
    const decoded = decodeHeaderValue(rawName)
    if (decoded === null) return mismatch(request.id, "the Mcp-Name header is not valid base64.")
    if (decoded !== wantedName) {
      return mismatch(
        request.id,
        `Mcp-Name header '${decoded}' does not match the body value '${wantedName}'.`,
      )
    }
  }

  return null
}

// -----------------------------------------------------------------------------
// Framing
// -----------------------------------------------------------------------------

/**
 * A successful result. `resultType: "complete"` is required on every result
 * in this revision, and `serverInfo` rides in `_meta` where the spec puts it.
 */
export function result(id: JsonRpcId, body: Record<string, unknown>): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id,
    result: {
      resultType: "complete",
      ...body,
      _meta: { [META_SERVER_INFO]: SERVER_INFO },
    },
  }
}

export function errorBody(error: ProtocolError): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id: error.id,
    error: {
      code: error.code,
      message: error.message,
      ...(error.data === undefined ? {} : { data: error.data }),
    },
  }
}

/**
 * How long a client may cache a list result, and whether a shared
 * intermediary may.
 *
 * `private` throughout, and deliberately: `tools/list` varies with the
 * caller's token (a read-only grant is shown fewer tools), so a shared cache
 * keyed on the URL alone would hand one token's tool set to another. The TTL
 * is a minute — long enough to spare a chatty client a round trip per turn,
 * short enough that revoking or re-scoping a token takes effect while the
 * person who did it is still watching.
 */
export const CACHE_HINT = { ttlMs: 60_000, cacheScope: "private" } as const

/**
 * Discovery caches for an hour: it is metadata about the build, and the build
 * does not change under a running client.
 *
 * The scope depends on who asked. `server/discover` is the one method served
 * WITHOUT a token — it reveals nothing but which protocol versions this
 * server speaks, and refusing it would leave someone configuring a client with
 * no way to check the URL is right — and that answer is identical for
 * everyone, so it is `public`. Presented with a token it also describes the
 * grant, which is nobody else's business, so it is `private`.
 */
export const discoverCacheHint = (authenticated: boolean) =>
  ({ ttlMs: 3_600_000, cacheScope: authenticated ? "private" : "public" }) as const
