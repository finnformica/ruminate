import { Link } from "@tanstack/react-router"
import { useAtomValue } from "jotai"
import React from "react"
import {
  createShare,
  listShares,
  revokeShare,
  shareOwnerName,
  type GivenShare,
  type ReceivedShareSummary,
} from "../data/shares"
import { recordedEmailAtom } from "../data/shared-mode"
import { githubUserAtom, notesAtom, ownSortedNotesAtom } from "../global-state"
import { cx } from "../utils/cx"
import { pluralize } from "../utils/pluralize"
import { Button } from "./button"
import { Checkbox } from "./checkbox"
import { PlusIcon16, TrashIcon16 } from "./icons"
import { TextInput } from "./text-input"

/**
 * Sharing, on the settings page (docs/sharing.md).
 *
 * The form asks the two questions a share is made of — **who** (an email
 * address, typed; the app never lists other people or says whether an
 * address belongs to one) and **which notes** (the roots; everything beneath
 * them goes with them, now and as they grow) — and states what is about to
 * be granted in a sentence before the button that grants it. A share is
 * read-only.
 *
 * Below it: the shares this account has given (with the address as typed,
 * and a Revoke) and the shares it has received (who, what, which notes).
 */

export function SharingSection() {
  const githubUser = useAtomValue(githubUserAtom)
  const recordedEmail = useAtomValue(recordedEmailAtom)
  const [given, setGiven] = React.useState<GivenShare[] | null>(null)
  const [received, setReceived] = React.useState<ReceivedShareSummary[] | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [composing, setComposing] = React.useState(false)

  const refresh = React.useCallback(async () => {
    if (!githubUser) return
    try {
      const listed = await listShares()
      setGiven(listed.given)
      setReceived(listed.received)
      setError(null)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load shares.")
    }
  }, [githubUser])

  React.useEffect(() => {
    void refresh()
  }, [refresh])

  if (!githubUser) {
    return (
      <Section>
        <div className="text-text-secondary">Sign in to share notes with someone.</div>
      </Section>
    )
  }

  return (
    <Section>
      <p className="leading-5 text-text-secondary">
        Share notes with another Ruminate user by the email address they sign in to GitHub with.
        They see the notes you pick and everything beneath them — including blocks you add later —
        and cannot change them.
        {recordedEmail ? (
          <>
            {" "}
            Others can share with you at <span className="text-text">{recordedEmail}</span>.
          </>
        ) : null}
      </p>

      {error ? <p className="text-text-danger">{error}</p> : null}

      <GivenList
        shares={given}
        onRevoke={async (id) => {
          try {
            await revokeShare(id)
            await refresh()
          } catch (caught) {
            setError(caught instanceof Error ? caught.message : "Could not revoke that share.")
          }
        }}
      />

      {composing ? (
        <ShareForm
          onCancel={() => setComposing(false)}
          onCreated={async () => {
            setComposing(false)
            await refresh()
          }}
        />
      ) : (
        <Button className="self-start" onClick={() => setComposing(true)}>
          <PlusIcon16 />
          Share notes
        </Button>
      )}

      <ReceivedList shares={received} />
    </Section>
  )
}

function Section({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-3">
      <h3 className="font-bold leading-4">Sharing</h3>
      <div className="card-1 flex flex-col gap-5 p-4">{children}</div>
    </div>
  )
}

function GivenList({
  shares,
  onRevoke,
}: {
  shares: GivenShare[] | null
  onRevoke: (id: string) => void | Promise<void>
}) {
  const notes = useAtomValue(notesAtom)
  if (shares === null) return <span className="text-text-secondary">Loading…</span>
  if (shares.length === 0) {
    return <span className="text-text-secondary">You have not shared any notes yet.</span>
  }
  return (
    <ul className="flex list-none flex-col gap-3 p-0">
      {shares.map((share) => {
        const live = share.revokedAt === null
        const names = share.rootIds.map((id) => notes.get(id)?.displayName ?? id).join(", ")
        return (
          <li
            key={share.id}
            className={cx(
              "flex items-start justify-between gap-4 border-t border-border-secondary pt-3 first:border-t-0 first:pt-0",
              !live && "opacity-50",
            )}
          >
            <div className="flex w-0 grow flex-col gap-1">
              <span className="truncate leading-4">
                {share.granteeEmail}
                {!live ? <span className="ml-2 text-sm text-text-secondary">(revoked)</span> : null}
              </span>
              <span className="text-sm leading-5 text-text-secondary">{names}</span>
            </div>
            {live ? (
              <Button
                className="shrink-0"
                aria-label={`Revoke the share with ${share.granteeEmail}`}
                onClick={() => void onRevoke(share.id)}
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

function ReceivedList({ shares }: { shares: ReceivedShareSummary[] | null }) {
  const notes = useAtomValue(notesAtom)
  if (shares === null || shares.length === 0) return null
  return (
    <div className="flex flex-col gap-2 border-t border-border-secondary pt-4">
      <span className="text-sm leading-4 text-text-secondary">Shared with you</span>
      <ul className="flex list-none flex-col gap-3 p-0">
        {shares.map((share) => (
          <li key={share.id} className="flex flex-col gap-1">
            <span className="leading-4">{shareOwnerName(share)}</span>
            <span className="flex flex-wrap gap-x-2 text-sm leading-5 text-text-secondary">
              {share.rootIds.map((id) => {
                const note = notes.get(id)
                return note ? (
                  <Link
                    key={id}
                    to="/notes/$"
                    params={{ _splat: id }}
                    search={{ query: undefined }}
                    className="link"
                  >
                    {note.displayName}
                  </Link>
                ) : (
                  <span key={id}>{id}</span>
                )
              })}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function ShareForm({
  onCancel,
  onCreated,
}: {
  onCancel: () => void
  onCreated: () => void | Promise<void>
}) {
  const ownNotes = useAtomValue(ownSortedNotesAtom)
  const [email, setEmail] = React.useState("")
  const [rootIds, setRootIds] = React.useState<string[]>([])
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const candidates = React.useMemo(() => ownNotes.slice(0, 200), [ownNotes])

  const ready = email.trim() !== "" && rootIds.length > 0

  async function submit() {
    if (!ready) return
    setBusy(true)
    setError(null)
    try {
      await createShare({ email: email.trim(), rootIds })
      await onCreated()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not share those notes.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-5 border-t border-border-secondary pt-4">
      <div className="flex flex-col gap-2">
        <label htmlFor="share-email" className="text-sm leading-4 text-text-secondary">
          Email address
        </label>
        <TextInput
          id="share-email"
          type="email"
          value={email}
          placeholder="them@example.com"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          onChange={(event) => setEmail(event.target.value)}
        />
        <span className="text-sm leading-5 text-text-secondary">
          The address they sign in to GitHub with. Nothing is sent to it, and you will not be told
          whether it belongs to a Ruminate user.
        </span>
      </div>

      <fieldset className="flex flex-col gap-2 border-0 p-0">
        <legend className="text-sm leading-4 text-text-secondary">Notes</legend>
        <div className="flex max-h-56 flex-col gap-1 overflow-y-auto rounded border border-border-secondary p-2">
          {candidates.length === 0 ? (
            <span className="text-text-secondary">You have no notes yet.</span>
          ) : (
            candidates.map((note) => (
              <div key={note.id} className="flex items-center gap-2 leading-4">
                <Checkbox
                  id={`share-note-${note.id}`}
                  checked={rootIds.includes(note.id)}
                  onCheckedChange={() =>
                    setRootIds((current) =>
                      current.includes(note.id)
                        ? current.filter((id) => id !== note.id)
                        : [...current, note.id],
                    )
                  }
                />
                <label htmlFor={`share-note-${note.id}`} className="cursor-pointer truncate">
                  {note.displayName}
                </label>
              </div>
            ))
          )}
        </div>
        <span className="text-sm leading-5 text-text-secondary">
          Everything beneath a shared note is shared with it, including blocks added later.
        </span>
      </fieldset>

      <p className="leading-5 text-text-secondary">
        <span className="text-text">{email.trim() || "This person"}</span> will be able to read{" "}
        <span className="text-text">{pluralize(rootIds.length, "note")}</span> and everything
        beneath them.
      </p>

      {error ? <p className="text-text-danger">{error}</p> : null}

      <div className="flex gap-2">
        <Button variant="primary" disabled={!ready || busy} onClick={() => void submit()}>
          {busy ? "Sharing…" : "Share"}
        </Button>
        <Button onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  )
}
