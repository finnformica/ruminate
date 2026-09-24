import React from "react"
import copy from "copy-to-clipboard"
import {
  inviteState,
  inviteUrl,
  listInvites,
  mintInvite,
  revokeInvite,
  type InviteSummary,
} from "../../data/admin"
import { AsyncButton } from "../ui/async-button"
import { Button } from "../ui/button"
import { CheckIcon16, CopyIcon16, PlusIcon16, TrashIcon16 } from "../icons"
import { TextInput } from "../ui/text-input"
import { cx } from "../../utils/cx"
import { SettingsSection } from "../settings-section"

const EXPIRY_OPTIONS: { value: number; label: string }[] = [
  { value: 1, label: "1 day" },
  { value: 7, label: "7 days" },
  { value: 30, label: "30 days" },
]

export function InvitesSection() {
  const [invites, setInvites] = React.useState<InviteSummary[] | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [composing, setComposing] = React.useState(false)
  const [minted, setMinted] = React.useState<{ token: string; note: string | null } | null>(null)

  const refresh = React.useCallback(async () => {
    try {
      setInvites(await listInvites())
      setError(null)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load invites.")
    }
  }, [])

  React.useEffect(() => {
    void refresh()
  }, [refresh])

  return (
    <SettingsSection title="Invites">
      {error ? <p className="text-text-danger">{error}</p> : null}

      {minted ? (
        <MintedInvite token={minted.token} note={minted.note} onDismiss={() => setMinted(null)} />
      ) : null}

      <InviteList
        invites={invites}
        onRevoke={async (id) => {
          try {
            await revokeInvite(id)
            await refresh()
          } catch (caught) {
            setError(caught instanceof Error ? caught.message : "Could not revoke that invite.")
          }
        }}
      />

      {composing ? (
        <MintInviteForm
          onCancel={() => setComposing(false)}
          onMinted={async (token, note) => {
            setComposing(false)
            setMinted({ token, note })
            await refresh()
          }}
        />
      ) : (
        <Button className="self-start" icon={<PlusIcon16 />} onClick={() => setComposing(true)}>
          New invite
        </Button>
      )}
    </SettingsSection>
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

/** The one showing of a link. Like a minted MCP token: loud, and it stays
 * until dismissed — losing it means minting another. */
function MintedInvite({
  token,
  note,
  onDismiss,
}: {
  token: string
  note: string | null
  onDismiss: () => void
}) {
  const url = inviteUrl(token)
  return (
    <div className="flex flex-col gap-2 rounded border border-border-focus p-3">
      <span className="font-bold leading-4">Copy the link{note ? ` for ${note}` : ""} now</span>
      <span className="leading-5 text-text-secondary">
        This is the only time this link is shown.
      </span>
      <code className="select-all break-all rounded bg-bg-secondary p-2 font-mono text-sm">
        {url}
      </code>
      <div className="flex gap-2">
        <CopyButton value={url} label="Copy the invite link" />
        <Button onClick={onDismiss}>Done</Button>
      </div>
    </div>
  )
}

const formatDate = (at: number): string => new Date(at).toLocaleDateString()

/**
 * An invite's state as a coloured dot and a word: the sync status's palette
 * (`sync-status.tsx`) — success for a link that let someone in, danger for
 * one that never will (expired, revoked), pending for one still out there.
 */
const STATE_BADGE: Record<ReturnType<typeof inviteState>, { label: string; className: string }> = {
  live: { label: "Live", className: "text-text-pending" },
  redeemed: { label: "Used", className: "text-text-success" },
  expired: { label: "Expired", className: "text-text-danger" },
  revoked: { label: "Revoked", className: "text-text-danger" },
}

function StateBadge({ state }: { state: ReturnType<typeof inviteState> }) {
  const badge = STATE_BADGE[state]
  return (
    <span className={cx("inline-flex items-center gap-1.5 text-sm leading-4", badge.className)}>
      <span aria-hidden="true" className="size-2 rounded-full bg-current" />
      {badge.label}
    </span>
  )
}

function InviteList({
  invites,
  onRevoke,
}: {
  invites: InviteSummary[] | null
  onRevoke: (id: string) => void | Promise<void>
}) {
  if (invites === null) return <span className="text-text-secondary">Loading…</span>
  if (invites.length === 0) return <span className="text-text-secondary">No invites yet.</span>

  return (
    <ul className="flex list-none flex-col gap-3 p-0">
      {invites.map((invite) => {
        const state = inviteState(invite)
        return (
          <li
            key={invite.id}
            className="flex items-start justify-between gap-4 border-t border-border-secondary pt-3 first:border-t-0 first:pt-0"
          >
            <div className="flex w-0 grow flex-col gap-1">
              <span className="flex items-center gap-3 leading-4">
                <span className="truncate">{invite.note ?? "Invite"}</span>
                <StateBadge state={state} />
              </span>
              <span className="text-sm leading-5 text-text-secondary">
                {state === "redeemed" && invite.redeemedAt !== null
                  ? `Joined ${formatDate(invite.redeemedAt)}` +
                    (invite.redeemedBy?.login ? ` as ${invite.redeemedBy.login}` : "")
                  : state === "revoked" && invite.revokedAt !== null
                    ? `Created ${formatDate(invite.createdAt)} · Revoked ${formatDate(invite.revokedAt)}`
                    : `Created ${formatDate(invite.createdAt)} · ${
                        state === "expired" ? "Expired" : "Expires"
                      } ${formatDate(invite.expiresAt)}`}
              </span>
            </div>
            {state === "live" ? (
              <AsyncButton
                className="shrink-0"
                aria-label={`Revoke ${invite.note ?? "invite"}`}
                icon={<TrashIcon16 />}
                onClick={() => onRevoke(invite.id)}
              >
                Revoke
              </AsyncButton>
            ) : null}
          </li>
        )
      })}
    </ul>
  )
}

function MintInviteForm({
  onCancel,
  onMinted,
}: {
  onCancel: () => void
  onMinted: (token: string, note: string | null) => void | Promise<void>
}) {
  const [note, setNote] = React.useState("")
  const [expiresInDays, setExpiresInDays] = React.useState(7)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  async function submit() {
    setBusy(true)
    setError(null)
    try {
      const trimmed = note.trim()
      const minted = await mintInvite({ note: trimmed === "" ? null : trimmed, expiresInDays })
      await onMinted(minted.token, minted.invite.note)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not mint that invite.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-5 border-t border-border-secondary pt-4">
      <div className="flex flex-col gap-2">
        <label htmlFor="invite-note" className="text-sm leading-4 text-text-secondary">
          Who it&rsquo;s for (optional)
        </label>
        <TextInput
          id="invite-note"
          value={note}
          placeholder="Ada"
          autoComplete="off"
          onChange={(event) => setNote(event.target.value)}
        />
      </div>

      <div className="flex flex-col gap-2">
        <span id="invite-expiry-label" className="text-sm leading-4 text-text-secondary">
          Expires in
        </span>
        <div role="group" aria-labelledby="invite-expiry-label" className="flex flex-wrap gap-1">
          {EXPIRY_OPTIONS.map((option) => {
            const selected = expiresInDays === option.value
            return (
              <Button
                key={option.value}
                size="small"
                aria-pressed={selected}
                onClick={() => setExpiresInDays(option.value)}
                selected={selected}
              >
                {option.label}
              </Button>
            )
          })}
        </div>
      </div>

      {error ? <p className="text-text-danger">{error}</p> : null}

      <div className="flex gap-2">
        <Button variant="primary" loading={busy} onClick={() => void submit()}>
          Create invite
        </Button>
        <Button onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  )
}

// -----------------------------------------------------------------------------
// Features
// -----------------------------------------------------------------------------
