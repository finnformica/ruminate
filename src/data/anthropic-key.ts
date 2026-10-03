import { atom, getDefaultStore, useAtomValue } from "jotai"
import type { AnthropicKeyBody } from "./auto-tag"
import { sessionFetch } from "./session-fetch"

/**
 * The client half of the user's Anthropic API key (docs/boards.md,
 * "Tagging with Claude"): whether one is kept on the server, and its last
 * characters — never the key, which the server does not answer with. Read
 * from `GET /api/anthropic-key` when the board or the settings card first
 * needs it (the flag is admin-only, so it is not asked for at every
 * sign-in), kept in memory for the sign-in, and forgotten on sign-out.
 */

/** Null = not asked yet, or the request failed. */
const anthropicKeyAtom = atom<AnthropicKeyBody | null>(null)

export function useAnthropicKey(): AnthropicKeyBody | null {
  return useAtomValue(anthropicKeyAtom)
}

class AnthropicKeyError extends Error {}

const signedOut = () => new AnthropicKeyError("Sign in to keep an API key.")

async function request(init: RequestInit = {}): Promise<AnthropicKeyBody> {
  const response = await sessionFetch(
    "/api/anthropic-key",
    { ...init, headers: { "Content-Type": "application/json", ...(init.headers ?? {}) } },
    signedOut,
  )
  const body = (await response.json().catch(() => null)) as
    (Partial<AnthropicKeyBody> & { error?: string; detail?: string }) | null
  if (!response.ok) {
    throw new AnthropicKeyError(
      body?.detail ?? body?.error ?? `Request failed (${response.status}).`,
    )
  }
  const read: AnthropicKeyBody = {
    set: body?.set === true,
    last4: typeof body?.last4 === "string" ? body.last4 : null,
  }
  getDefaultStore().set(anthropicKeyAtom, read)
  return read
}

/** Ask whether a key is kept. Silent on failure: nothing known stands. */
export async function refreshAnthropicKey(): Promise<void> {
  try {
    await request({ method: "GET" })
  } catch {
    // Left as it was; the board shows no Suggest button until it is known.
  }
}

/** Keep a key. Rejects with what the server said when it is refused. */
export async function saveAnthropicKey(key: string): Promise<AnthropicKeyBody> {
  return request({ method: "PUT", body: JSON.stringify({ key }) })
}

export async function removeAnthropicKey(): Promise<AnthropicKeyBody> {
  return request({ method: "DELETE" })
}

/** Forget what is known — on sign-out. */
export function resetAnthropicKey(): void {
  getDefaultStore().set(anthropicKeyAtom, null)
}
