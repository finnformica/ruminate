// Test scaffolding for the MCP suites: a database in the exact shape
// production D1 is in, seeded through the exact code path production writes
// through.
//
// Nothing here hand-writes corpus DDL or corpus rows. The schema comes from
// the real migration files via the shared ladder (`createTenantTestDriver`),
// the control-plane tables from the real `0003` and `0007`, and a seeded note
// goes in through `docToGraph` → `corpusPut` → `planReplicaPut` — the same
// three steps a replica push takes. So a schema or write-path change that
// would break the deployed database breaks these tests first, which is the
// only way a fixture earns its keep.

import migration0003 from "../../migrations/0003_control_plane.sql?raw"
import migration0007 from "../../migrations/0007_mcp_tokens.sql?raw"
import { docToGraph } from "../../src/data/graph"
import type { SqlDriver } from "../../src/data/sql-driver"
import { corpusPut } from "../handlers/replica-corpus"
import { asFakeD1, createTenantTestDriver } from "../handlers/sqlite-test-driver"
import { forTenant, type TenantDb } from "../tenancy-db"
import type { Env } from "../types"

export interface McpTestEnv {
  env: Env
  /** The one database, behind the shared seam — for control-plane reads. */
  control: SqlDriver
  /** A tenant handle for a user, minted the way production mints one. */
  tenant(userId: number): TenantDb
  /** Add a user to the control plane so `tenantIsActive` finds them. */
  addUser(userId: number, status?: "active" | "blocked"): Promise<void>
  /** Write a note through the production push path. Returns its id. */
  seedNote(userId: number, note: SeedNote): Promise<string>
}

interface SeedNote {
  id: string
  title?: string
  markdown?: string
  updatedAt?: number
}

export async function createMcpTestEnv(): Promise<McpTestEnv> {
  const driver = await createTenantTestDriver()
  await driver.execScript(migration0003)
  await driver.execScript(migration0007)

  const db = asFakeD1(driver)
  const env = {
    DB: db,
    ASSETS: { fetch: () => Promise.resolve(new Response("asset")) } as unknown as Fetcher,
    VITE_GITHUB_CLIENT_ID: "client",
    GITHUB_CLIENT_SECRET: "secret",
    ALLOWED_GITHUB_ID: "42536816",
    SIGNUP_MODE: "allowlist",
  } satisfies Env

  const tenant = (userId: number) =>
    forTenant(
      {
        exec: driver.exec,
        batch: driver.batch,
        execScript: driver.execScript,
        close: driver.close,
      },
      { id: userId, login: `user-${userId}`, name: null },
    )

  return {
    env,
    control: driver,
    tenant,
    async addUser(userId, status = "active") {
      await driver.exec(
        "INSERT INTO users (github_id, login, status, created_at) VALUES (?1, ?2, ?3, ?4) " +
          "ON CONFLICT (github_id) DO UPDATE SET status = excluded.status",
        [userId, `user-${userId}`, status, 1000],
      )
    },
    async seedNote(userId, note) {
      const updatedAt = note.updatedAt ?? 1_700_000_000_000
      const { nodes, links } = docToGraph(
        note.id,
        note.markdown ?? "",
        updatedAt,
        note.title === undefined
          ? { updated_at: new Date(updatedAt).toISOString() }
          : { title: note.title, updated_at: new Date(updatedAt).toISOString() },
      )
      // `docToGraph` is the markdown IMPORT path and leaves `notes_id` unset;
      // the app's own saves set it on every block it creates (`docToOps` →
      // `create`, migrations/0006), and migration 0006 backfilled the rest. So
      // stamp it here, or the fixture would hold rows the app never produces —
      // blocks with no note, which is exactly the state the Unassigned basket
      // is defined against.
      const stamped = nodes.map((row) => (row.id === note.id ? row : { ...row, notes_id: note.id }))
      await corpusPut(tenant(userId), { nodes: stamped, links }, updatedAt)
      return note.id
    },
  }
}

/** A `tools/call`-shaped POST at `/mcp`, with the headers the spec requires. */
export function mcpRequest(
  method: string,
  params: Record<string, unknown> = {},
  options: {
    token?: string
    id?: string | number
    protocolVersion?: string
    headers?: Record<string, string>
    origin?: string
  } = {},
): Request {
  const version = options.protocolVersion ?? "2026-07-28"
  const name = method === "tools/call" && typeof params.name === "string" ? params.name : undefined

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "MCP-Protocol-Version": version,
    "Mcp-Method": method,
    ...(name === undefined ? {} : { "Mcp-Name": name }),
    ...(options.token === undefined ? {} : { Authorization: `Bearer ${options.token}` }),
    ...options.headers,
  }

  return new Request(`${options.origin ?? "https://ruminate.test"}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      ...(options.id === undefined ? { id: 1 } : { id: options.id }),
      method,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": version,
          "io.modelcontextprotocol/clientInfo": { name: "test-client", version: "1.0.0" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  })
}
