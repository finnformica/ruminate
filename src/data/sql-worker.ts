/// <reference lib="webworker" />
import sqlite3InitModule, { type Database, type Sqlite3Static } from "@sqlite.org/sqlite-wasm"
import type { SqlStatement, SqlValue } from "./sql-driver"

/**
 * The dedicated Web Worker hosting the browser SQLite engine (the official
 * `@sqlite.org/sqlite-wasm` build). It runs in a worker because the persistent
 * OPFS VFS (`opfs-sahpool`) needs synchronous OPFS access handles, which only
 * exist in dedicated workers — and unlike the plain `opfs` VFS it does NOT
 * require COOP/COEP headers, which this app cannot serve without breaking
 * cross-origin embeds. When OPFS is unavailable (private windows, old
 * browsers) it degrades to an in-memory database — still correct, just not
 * persistent across reloads, which the diagnostics panel surfaces.
 *
 * Protocol: `{ id, op, ... }` request → `{ id, ok, ... }` response. See
 * `sql-driver-browser.ts` for the client side.
 */

export interface SqlWorkerRequest {
  id: number
  op: "open" | "exec" | "batch" | "script" | "close"
  sql?: string
  params?: SqlValue[]
  statements?: SqlStatement[]
}

export interface SqlWorkerResponse {
  id: number
  ok: boolean
  rows?: Record<string, SqlValue>[]
  persistence?: "opfs" | "memory"
  error?: string
}

let db: Database | null = null

async function open(): Promise<"opfs" | "memory"> {
  const sqlite3: Sqlite3Static = await sqlite3InitModule()
  try {
    const pool = await sqlite3.installOpfsSAHPoolVfs({ directory: ".ruminate-sql" })
    db = new pool.OpfsSAHPoolDb("/ruminate.sqlite3")
    return "opfs"
  } catch (error) {
    console.warn("[ruminate-sql] OPFS unavailable, using in-memory database", error)
    db = new sqlite3.oo1.DB(":memory:")
    return "memory"
  }
}

function requireDb(): Database {
  if (!db) throw new Error("Database not open")
  return db
}

function exec(sql: string, params?: SqlValue[]): Record<string, SqlValue>[] {
  const rows: Record<string, SqlValue>[] = []
  requireDb().exec({
    sql,
    bind: params && params.length > 0 ? params : undefined,
    rowMode: "object",
    callback: (row) => {
      rows.push(row as Record<string, SqlValue>)
    },
  })
  return rows
}

function batch(statements: SqlStatement[]) {
  requireDb().transaction(() => {
    for (const { sql, params } of statements) {
      requireDb().exec({ sql, bind: params && params.length > 0 ? params : undefined })
    }
  })
}

self.onmessage = async (event: MessageEvent<SqlWorkerRequest>) => {
  const { id, op, sql, params, statements } = event.data
  try {
    let response: SqlWorkerResponse = { id, ok: true }
    switch (op) {
      case "open":
        response = { id, ok: true, persistence: await open() }
        break
      case "exec":
        response = { id, ok: true, rows: exec(sql ?? "", params) }
        break
      case "batch":
        batch(statements ?? [])
        break
      case "script":
        requireDb().exec(sql ?? "")
        break
      case "close":
        db?.close()
        db = null
        break
    }
    self.postMessage(response)
  } catch (error) {
    self.postMessage({
      id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    } satisfies SqlWorkerResponse)
  }
}
