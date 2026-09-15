import { createFileRoute } from "@tanstack/react-router"
import copy from "copy-to-clipboard"
import React from "react"
import {
  inviteState,
  inviteUrl,
  listFeatureAudiences,
  listInvites,
  mintInvite,
  revokeInvite,
  setFeatureAudience,
  type InviteSummary,
} from "../data/admin"
import {
  AUDIENCE_LABELS,
  AUDIENCES,
  FEATURES,
  type Audience,
  type FeatureAudiences,
  type FeatureKey,
} from "../data/feature-flags"
import { refreshFeatures, useIsAdmin } from "../data/features"
import { Button } from "../components/button"
import { DropdownMenu } from "../components/dropdown-menu"
import {
  CheckIcon16,
  ChevronDownIcon16,
  CopyIcon16,
  FlagIcon16,
  PlusIcon16,
  TrashIcon16,
} from "../components/icons"
import { PageLayout } from "../components/page-layout"
import { SettingsSection } from "../components/settings-section"
import { TextInput } from "../components/text-input"
import { cx } from "../utils/cx"

/**
 * The admin page: the bootstrap owner's controls, laid out like Settings.
 *
 * Two cards. **Feature flags** sets each flag's audience (Off, Admin,
 * Everyone; src/data/feature-flags.ts). **Invites** mints the links that
 * admit people — single use, expiring, shown once — and lists every invite
 * with who took it. Everything here is refused server-side for anyone but
 * the admin; the page only draws for them too.
 */
export const Route = createFileRoute("/_appRoot/admin")({
  component: RouteComponent,
  head: () => ({
    meta: [{ title: "Admin · Ruminate" }],
  }),
})

function RouteComponent() {
  const isAdmin = useIsAdmin()
  return (
    <PageLayout title="Admin" icon={<FlagIcon16 />} disableGuard>
      <div className="p-4 pb-6">
        <div className="mx-auto flex max-w-xl flex-col gap-6">
          {isAdmin ? (
            <>
              <FeaturesSection />
              <InvitesSection />
            </>
          ) : (
            <span className="text-text-secondary">Nothing here.</span>
          )}
        </div>
      </div>
    </PageLayout>
  )
}

// -----------------------------------------------------------------------------
// Invites
// -----------------------------------------------------------------------------

const EXPIRY_OPTIONS: { value: number; label: string }[] = [
  { value: 1, label: "1 day" },
  { value: 7, label: "7 days" },
  { value: 30, label: "30 days" },
]

function InvitesSection() {
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
      <p className="leading-5 text-text-secondary">
        Send someone a link; signing in with GitHub through it lets them in. Each link works once
        and expires.
      </p>

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
        <Button className="self-start" onClick={() => setComposing(true)}>
          <PlusIcon16 />
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
            className={cx(
              "flex items-start justify-between gap-4 border-t border-border-secondary pt-3 first:border-t-0 first:pt-0",
              state !== "live" && "opacity-50",
            )}
          >
            <div className="flex w-0 grow flex-col gap-1">
              <span className="truncate leading-4">
                {invite.note ?? "Invite"}
                {state !== "live" ? (
                  <span className="ml-2 text-sm text-text-secondary">({state})</span>
                ) : null}
              </span>
              <span className="text-sm leading-5 text-text-secondary">
                {state === "redeemed" && invite.redeemedAt !== null
                  ? `Joined ${formatDate(invite.redeemedAt)}` +
                    (invite.redeemedBy?.login ? ` as ${invite.redeemedBy.login}` : "")
                  : `Created ${formatDate(invite.createdAt)} · ${
                      state === "expired" ? "Expired" : "Expires"
                    } ${formatDate(invite.expiresAt)}`}
              </span>
            </div>
            {state === "live" ? (
              <Button
                className="shrink-0"
                aria-label={`Revoke ${invite.note ?? "invite"}`}
                onClick={() => void onRevoke(invite.id)}
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
        <Button variant="primary" disabled={busy} onClick={() => void submit()}>
          {busy ? "Creating…" : "Create invite"}
        </Button>
        <Button onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  )
}

// -----------------------------------------------------------------------------
// Features
// -----------------------------------------------------------------------------

function FeaturesSection() {
  const [audiences, setAudiences] = React.useState<FeatureAudiences | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    listFeatureAudiences()
      .then((loaded) => {
        setAudiences(loaded)
        setError(null)
      })
      .catch((caught: unknown) => {
        setError(caught instanceof Error ? caught.message : "Could not load the features.")
      })
  }, [])

  async function update(key: FeatureKey, audience: Audience) {
    try {
      setAudiences(await setFeatureAudience(key, audience))
      setError(null)
      // The admin's own panels follow the flags too.
      await refreshFeatures()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not change that feature.")
    }
  }

  return (
    <SettingsSection title="Feature flags">
      {error ? <p className="text-text-danger">{error}</p> : null}

      {audiences === null ? (
        <span className="text-text-secondary">Loading…</span>
      ) : (
        FEATURES.map((feature) => (
          <div key={feature.key} className="flex items-center justify-between gap-4">
            <span className="w-0 grow truncate leading-4">{feature.label}</span>
            <AudienceMenu
              label={feature.label}
              value={audiences[feature.key]}
              onChange={(audience) => void update(feature.key, audience)}
            />
          </div>
        ))
      )}
    </SettingsSection>
  )
}

/** The Off / Admin / Everyone pick, as a dropdown on a button. */
function AudienceMenu({
  label,
  value,
  onChange,
}: {
  label: string
  value: Audience
  onChange: (audience: Audience) => void
}) {
  return (
    <DropdownMenu modal={false}>
      <DropdownMenu.Trigger
        render={
          <Button className="shrink-0" aria-label={`${label}: ${AUDIENCE_LABELS[value]}`}>
            {AUDIENCE_LABELS[value]}
            <ChevronDownIcon16 />
          </Button>
        }
      />
      <DropdownMenu.Content align="end" width={160}>
        {AUDIENCES.map((audience) => (
          <DropdownMenu.Item
            key={audience}
            selected={audience === value}
            onClick={() => onChange(audience)}
          >
            {AUDIENCE_LABELS[audience]}
          </DropdownMenu.Item>
        ))}
      </DropdownMenu.Content>
    </DropdownMenu>
  )
}
