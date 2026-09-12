import copy from "copy-to-clipboard"
import { useAtomValue } from "jotai"
import React from "react"
import {
  describePermissions,
  listMcpTokens,
  mcpEndpointUrl,
  mintMcpToken,
  revokeMcpToken,
  tokenState,
  type McpPermission,
  type McpTokenSummary,
} from "../data/mcp-tokens"
import { githubUserAtom, notesAtom } from "../global-state"
import { cx } from "../utils/cx"
import { Button } from "./button"
import { Checkbox } from "./checkbox"
import { CheckIcon16, CopyIcon16, PlusIcon16, TrashIcon16 } from "./icons"
import { TextInput } from "./text-input"

/**
 * MCP access, on the settings page (docs/mcp-server.md).
 *
 * The whole point of this panel is that the three questions it asks —
 * **what may this agent do**, **which notes may it touch**, **when does it
 * stop working** — are asked BEFORE a token exists, by a person, and cannot
 * be changed afterwards by the agent holding it. So the form leads with the
 * permissions rather than burying them, defaults to read-only, and shows a
 * plain-English sentence of what is about to be granted before the button
 * that grants it.
 *
 * The secret is displayed once, immediately after minting, because that is
 * the only moment it exists outside the agent it is for — the server keeps
 * only a hash.
 */

const PERMISSION_OPTIONS: { value: McpPermission; label: string; detail: string }[] = [
  { value: "read", label: "Read", detail: "List, search, read and traverse notes" },
  { value: "write", label: "Write", detail: "Create notes, and edit or add to them" },
  { value: "delete", label: "Delete", detail: "Delete whole notes" },
]

const EXPIRY_OPTIONS: { value: number | null; label: string }[] = [
  { value: 30, label: "30 days" },
  { value: 90, label: "90 days" },
  { value: 365, label: "1 year" },
  { value: null, label: "Never" },
]

export function McpTokensSection() {
  const githubUser = useAtomValue(githubUserAtom)
  const [tokens, setTokens] = React.useState<McpTokenSummary[] | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [composing, setComposing] = React.useState(false)
  const [minted, setMinted] = React.useState<{ token: string; name: string } | null>(null)

  const refresh = React.useCallback(async () => {
    if (!githubUser) return
    try {
      setTokens(await listMcpTokens(githubUser))
      setError(null)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load tokens.")
    }
  }, [githubUser])

  React.useEffect(() => {
    void refresh()
  }, [refresh])

  if (!githubUser) {
    return (
      <Section>
        <div className="text-text-secondary">Sign in to give an agent access to your notes.</div>
      </Section>
    )
  }

  return (
    <Section>
      <div className="flex flex-col gap-2">
        <p className="leading-5 text-text-secondary">
          Give an AI agent access to your notes over the{" "}
          <a
            className="link"
            href="https://modelcontextprotocol.io"
            target="_blank"
            rel="noopener noreferrer"
          >
            Model Context Protocol
          </a>
          . Each token decides for itself what an agent may do and which notes it may touch — an
          agent can never widen its own access, and revoking a token stops it at once.
        </p>
        <EndpointRow />
      </div>

      {error ? <p className="text-text-danger">{error}</p> : null}

      {minted ? (
        <MintedToken token={minted.token} name={minted.name} onDismiss={() => setMinted(null)} />
      ) : null}

      <TokenList
        tokens={tokens}
        onRevoke={async (id) => {
          try {
            await revokeMcpToken(githubUser, id)
            await refresh()
          } catch (caught) {
            setError(caught instanceof Error ? caught.message : "Could not revoke that token.")
          }
        }}
      />

      {composing ? (
        <MintForm
          onCancel={() => setComposing(false)}
          onMinted={async (token, name) => {
            setComposing(false)
            setMinted({ token, name })
            await refresh()
          }}
        />
      ) : (
        <Button className="self-start" onClick={() => setComposing(true)}>
          <PlusIcon16 />
          New token
        </Button>
      )}
    </Section>
  )
}

function Section({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-3">
      <h3 className="font-bold leading-4">MCP access</h3>
      <div className="card-1 flex flex-col gap-5 p-4">{children}</div>
    </div>
  )
}

/** The URL to paste into an MCP client, with a copy button. */
function EndpointRow() {
  const url = mcpEndpointUrl()
  return (
    <div className="flex items-center gap-2">
      <code className="min-w-0 flex-1 truncate rounded bg-bg-secondary px-2 py-1 font-mono text-sm">
        {url}
      </code>
      <CopyButton value={url} label="Copy the MCP endpoint URL" />
    </div>
  )
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = React.useState(false)
  return (
    <Button
      aria-label={label}
      className="shrink-0"
      onClick={() => {
        copy(value)
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
      }}
    >
      {copied ? <CheckIcon16 /> : <CopyIcon16 />}
      {copied ? "Copied" : "Copy"}
    </Button>
  )
}

/**
 * The one and only showing of a secret. Deliberately loud, and deliberately
 * does not disappear on its own — losing it means minting another.
 */
function MintedToken({
  token,
  name,
  onDismiss,
}: {
  token: string
  name: string
  onDismiss: () => void
}) {
  return (
    <div className="flex flex-col gap-2 rounded border border-border-focus p-3">
      <span className="font-bold leading-4">Copy “{name}” now</span>
      <span className="leading-5 text-text-secondary">
        This is the only time this token is shown. Ruminate stores only a hash of it, so it cannot
        be shown again — if you lose it, revoke it and mint another.
      </span>
      <code className="select-all break-all rounded bg-bg-secondary p-2 font-mono text-sm">
        {token}
      </code>
      <div className="flex gap-2">
        <CopyButton value={token} label="Copy the new token" />
        <Button onClick={onDismiss}>Done</Button>
      </div>
    </div>
  )
}

function TokenList({
  tokens,
  onRevoke,
}: {
  tokens: McpTokenSummary[] | null
  onRevoke: (id: string) => void | Promise<void>
}) {
  const notes = useAtomValue(notesAtom)

  if (tokens === null) return <span className="text-text-secondary">Loading…</span>
  if (tokens.length === 0) {
    return <span className="text-text-secondary">No tokens yet.</span>
  }

  return (
    <ul className="flex list-none flex-col gap-3 p-0">
      {tokens.map((token) => {
        const state = tokenState(token)
        const scope =
          token.noteIds === null
            ? "every note"
            : token.noteIds.map((id) => notes.get(id)?.displayName ?? id).join(", ")

        return (
          <li
            key={token.id}
            className={cx(
              "flex items-start justify-between gap-4 border-t border-border-secondary pt-3 first:border-t-0 first:pt-0",
              state !== "live" && "opacity-50",
            )}
          >
            <div className="flex w-0 grow flex-col gap-1">
              <span className="truncate leading-4">
                {token.name}
                {state !== "live" ? (
                  <span className="ml-2 text-sm text-text-secondary">({state})</span>
                ) : null}
              </span>
              <span className="text-sm leading-5 text-text-secondary">
                {describePermissions(token.permissions)} · {scope}
              </span>
              <span className="text-sm leading-5 text-text-tertiary">
                {token.lastUsedAt === null
                  ? "Never used"
                  : `Last used ${new Date(token.lastUsedAt).toLocaleDateString()}`}
                {token.expiresAt === null
                  ? ""
                  : ` · Expires ${new Date(token.expiresAt).toLocaleDateString()}`}
              </span>
            </div>
            {state === "live" ? (
              <Button
                className="shrink-0"
                aria-label={`Revoke ${token.name}`}
                onClick={() => void onRevoke(token.id)}
              >
                <TrashIcon16 />
                Revoke
              </Button>
            ) : null}
          </li>
        )
      })}
    </ul>
  )
}

function MintForm({
  onCancel,
  onMinted,
}: {
  onCancel: () => void
  onMinted: (token: string, name: string) => void | Promise<void>
}) {
  const githubUser = useAtomValue(githubUserAtom)
  const notes = useAtomValue(notesAtom)

  const [name, setName] = React.useState("")
  const [permissions, setPermissions] = React.useState<McpPermission[]>(["read"])
  const [allNotes, setAllNotes] = React.useState(true)
  const [noteIds, setNoteIds] = React.useState<string[]>([])
  const [expiresInDays, setExpiresInDays] = React.useState<number | null>(90)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const sortedNotes = React.useMemo(
    () => [...notes.values()].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)).slice(0, 200),
    [notes],
  )

  const toggle = (permission: McpPermission) =>
    setPermissions((current) =>
      current.includes(permission)
        ? current.filter((entry) => entry !== permission)
        : [...current, permission],
    )

  const ready = name.trim() !== "" && permissions.length > 0 && (allNotes || noteIds.length > 0)

  async function submit() {
    if (!githubUser || !ready) return
    setBusy(true)
    setError(null)
    try {
      const minted = await mintMcpToken(githubUser, {
        name: name.trim(),
        permissions,
        noteIds: allNotes ? null : noteIds,
        expiresInDays,
      })
      await onMinted(minted.token, minted.summary.name)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not mint that token.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-5 border-t border-border-secondary pt-4">
      <div className="flex flex-col gap-2">
        <label htmlFor="mcp-token-name" className="text-sm leading-4 text-text-secondary">
          Name
        </label>
        <TextInput
          id="mcp-token-name"
          value={name}
          placeholder="Claude Desktop"
          autoComplete="off"
          onChange={(event) => setName(event.target.value)}
        />
      </div>

      <fieldset className="flex flex-col gap-2 border-0 p-0">
        <legend className="text-sm leading-4 text-text-secondary">Permissions</legend>
        {/* `htmlFor` points at the Radix checkbox, which renders a <button> —
            a labelable element — so clicking the description toggles it. */}
        {PERMISSION_OPTIONS.map((option) => (
          <div key={option.value} className="flex items-start gap-2 leading-4">
            <Checkbox
              id={`mcp-permission-${option.value}`}
              className="mt-0.5"
              checked={permissions.includes(option.value)}
              onCheckedChange={() => toggle(option.value)}
            />
            <label
              htmlFor={`mcp-permission-${option.value}`}
              className="flex cursor-pointer flex-col gap-1"
            >
              <span>{option.label}</span>
              <span className="text-sm leading-4 text-text-secondary">{option.detail}</span>
            </label>
          </div>
        ))}
      </fieldset>

      <fieldset className="flex flex-col gap-2 border-0 p-0">
        <legend className="text-sm leading-4 text-text-secondary">Notes</legend>
        <div role="group" className="flex flex-wrap gap-1">
          <Button
            size="small"
            aria-pressed={allNotes}
            onClick={() => setAllNotes(true)}
            className={cx(allNotes && "ring-1 ring-inset ring-border-focus")}
          >
            Every note
          </Button>
          <Button
            size="small"
            aria-pressed={!allNotes}
            onClick={() => setAllNotes(false)}
            className={cx(!allNotes && "ring-1 ring-inset ring-border-focus")}
          >
            Only the notes I pick
          </Button>
        </div>
        {allNotes ? null : (
          <div className="flex max-h-56 flex-col gap-1 overflow-y-auto rounded border border-border-secondary p-2">
            {sortedNotes.length === 0 ? (
              <span className="text-text-secondary">You have no notes yet.</span>
            ) : (
              sortedNotes.map((note) => (
                <div key={note.id} className="flex items-center gap-2 leading-4">
                  <Checkbox
                    id={`mcp-note-${note.id}`}
                    checked={noteIds.includes(note.id)}
                    onCheckedChange={() =>
                      setNoteIds((current) =>
                        current.includes(note.id)
                          ? current.filter((id) => id !== note.id)
                          : [...current, note.id],
                      )
                    }
                  />
                  <label htmlFor={`mcp-note-${note.id}`} className="cursor-pointer truncate">
                    {note.displayName}
                  </label>
                </div>
              ))
            )}
          </div>
        )}
        {!allNotes && noteIds.length === 0 ? (
          <span className="text-sm leading-5 text-text-secondary">
            Pick at least one note, or choose “Every note”.
          </span>
        ) : null}
      </fieldset>

      <div className="flex flex-col gap-2">
        <span id="mcp-expiry-label" className="text-sm leading-4 text-text-secondary">
          Expires
        </span>
        <div role="group" aria-labelledby="mcp-expiry-label" className="flex flex-wrap gap-1">
          {EXPIRY_OPTIONS.map((option) => {
            const selected = expiresInDays === option.value
            return (
              <Button
                key={option.label}
                size="small"
                aria-pressed={selected}
                onClick={() => setExpiresInDays(option.value)}
                className={cx(selected && "ring-1 ring-inset ring-border-focus")}
              >
                {option.label}
              </Button>
            )
          })}
        </div>
      </div>

      {/* What is about to be granted, in a sentence — read before the button
          that grants it, not after. */}
      <p className="leading-5 text-text-secondary">
        This token will be able to{" "}
        <span className="text-text">{describePermissions(permissions)}</span>{" "}
        {allNotes ? (
          <span className="text-text">every note</span>
        ) : (
          <span className="text-text">
            {noteIds.length} {noteIds.length === 1 ? "note" : "notes"}
          </span>
        )}
        {permissions.includes("write") && !allNotes
          ? " — a token scoped to specific notes cannot create new ones"
          : ""}
        .
      </p>

      {error ? <p className="text-text-danger">{error}</p> : null}

      <div className="flex gap-2">
        <Button variant="primary" disabled={!ready || busy} onClick={() => void submit()}>
          {busy ? "Creating…" : "Create token"}
        </Button>
        <Button onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  )
}
