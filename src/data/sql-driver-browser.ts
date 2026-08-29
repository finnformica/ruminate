import type { SqlDriver, SqlStatement, SqlValue } from "./sql-driver"
import type { SqlWorkerRequest, SqlWorkerResponse } from "./sql-worker"

/**
 * The browser `SqlDriver`: a thin promise-RPC client for the dedicated SQLite
 * worker (`sql-worker.ts`). This module — and, through it, the worker chunk
 * and the ~850 KB sqlite3 wasm — is only ever loaded via dynamic import from
 * the storage mirror, so the flag-off path never pays for it.
 */
export interface BrowserSqlDriver extends SqlDriver {
  /** "opfs" when the database persists across reloads, "memory" otherwise. */
  persistence: "opfs" | "memory"
}

export async function createBrowserSqlDriver(): Promise<BrowserSqlDriver> {
  const worker = new Worker(new URL("./sql-worker.ts", import.meta.url), {
    type: "module",
    name: "ruminate-sql",
  })

  let nextId = 1
  const pending = new Map<
    number,
    { resolve: (r: SqlWorkerResponse) => void; reject: (e: Error) => void }
  >()

  const failAll = (message: string) => {
    for (const { reject } of pending.values()) reject(new Error(message))
    pending.clear()
  }

  worker.onmessage = (event: MessageEvent<SqlWorkerResponse>) => {
    const message = event.data
    const entry = pending.get(message.id)
    if (!entry) return
    pending.delete(message.id)
    if (message.ok) entry.resolve(message)
    else entry.reject(new Error(message.error ?? "SQL worker error"))
  }
  worker.onerror = (event) => failAll(event.message || "SQL worker crashed")
  worker.onmessageerror = () => failAll("SQL worker message error")

  const call = (request: Omit<SqlWorkerRequest, "id">): Promise<SqlWorkerResponse> =>
    new Promise((resolve, reject) => {
      const id = nextId++
      pending.set(id, { resolve, reject })
      worker.postMessage({ id, ...request })
    })

  const opened = await call({ op: "open" })

  return {
    persistence: opened.persistence ?? "memory",
    exec: async (sql: string, params?: SqlValue[]) =>
      (await call({ op: "exec", sql, params })).rows ?? [],
    batch: async (statements: SqlStatement[]) => {
      await call({ op: "batch", statements })
    },
    execScript: async (sql: string) => {
      await call({ op: "script", sql })
    },
    close: async () => {
      try {
        await call({ op: "close" })
      } finally {
        worker.terminate()
      }
    },
  }
}
