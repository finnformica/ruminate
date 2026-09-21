import { Link } from "@tanstack/react-router"
import { useAtomValue } from "jotai"
import React from "react"
import { NOTE_TYPE } from "../data/graph"
import {
  describeSharePermissions,
  listShares,
  revokeShare,
  shareOwnerName,
  type GivenShare,
  type ReceivedShareSummary,
} from "../data/shares"
import { recordedEmailAtom } from "../data/shared-mode"
import type { ShareView } from "../data/shares"
import { describeFilter, describeSort } from "../utils/view-filter"
import { githubUserAtom, graphSnapshotAtom, notesAtom } from "../global-state"
import { cx } from "../utils/cx"
import { Button } from "./ui/button"
import { TrashIcon16 } from "./icons"

/**
 * Sharing, on the settings page (docs/sharing.md): the overview. The shares
 * this account has given (the address as typed, the verbs, what was shared,
 * and a Revoke) and the shares it has received (who, the verbs, and what).
 * Sharing itself
 * happens where the note or block is — its menu — because the root is
 * chosen there (`share-note-dialog.tsx`).
 */
export function SharingSection() {
  const githubUser = useAtomValue(githubUserAtom)
  const recordedEmail = useAtomValue(recordedEmailAtom)
  const [given, setGiven] = React.useState<GivenShare[] | null>(null)
  const [received, setReceived] = React.useState<ReceivedShareSummary[] | null>(null)
  const [error, setError] = React.useState<string | null>(null)

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
      <div className="flex flex-col gap-1">
        <p className="leading-5 text-text-secondary">
          Share a note or block from its menu, by their GitHub sign-in email.
        </p>
        {recordedEmail ? (
          <p className="leading-5 text-text-secondary">
            Others can share with you at <span className="text-text">{recordedEmail}</span>.
          </p>
        ) : null}
      </div>

      {error ? (
        <p className="text-text-danger">{error}</p>
      ) : (
        <>
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
          <ReceivedList shares={received} />
        </>
      )}
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

/** How much of a block's text names it in a list. */
const LABEL_LENGTH = 60

/**
 * What a share's roots are called: a note by its name; a block by the note
 * it was written in and its text, `Note › text`, since a block's text alone
 * rarely says where it lives. A root the graph does not hold yet (a shared
 * slice still loading) shows its id.
 */
function useRootLabel() {
  const notes = useAtomValue(notesAtom)
  const graph = useAtomValue(graphSnapshotAtom)
  return React.useCallback(
    (id: string): string => {
      const node = graph.nodes.get(id)
      if (!node) return id
      const noteName = (noteId: string) =>
        notes.get(noteId)?.displayName || graph.nodes.get(noteId)?.text || ""
      if (node.type === NOTE_TYPE) return noteName(id) || "Untitled note"
      const text = node.text.trim() || "Untitled block"
      const clipped = text.length > LABEL_LENGTH ? `${text.slice(0, LABEL_LENGTH - 1)}…` : text
      const home = node.notes_id ? noteName(node.notes_id) : ""
      return home ? `${home} › ${clipped}` : clipped
    },
    [graph, notes],
  )
}

/** How a share opens, in words — its view's filter and sort, when it has
 * either: "Todo, sorted by Text". Nothing for the whole subtree in document
 * order, which needs no saying. */
function describeShareView(view: ShareView): string {
  const filter = describeFilter(view.filter ?? "")
  const sort = describeSort(view.sort ?? "")
  return [filter, sort ? `sorted by ${sort}` : ""].filter(Boolean).join(", ")
}

function GivenList({
  shares,
  onRevoke,
}: {
  shares: GivenShare[] | null
  onRevoke: (id: string) => void | Promise<void>
}) {
  const labelOf = useRootLabel()
  if (shares === null) return <span className="text-text-secondary">Loading…</span>
  if (shares.length === 0) {
    return <span className="text-text-secondary">You have not shared anything yet.</span>
  }
  return (
    <ul className="flex list-none flex-col gap-3 p-0">
      {shares.map((share) => {
        const live = share.revokedAt === null
        const names = labelOf(share.view.rootId)
        const opensAs = describeShareView(share.view)
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
                {names}
                {!live ? <span className="ml-2 text-sm text-text-secondary">(revoked)</span> : null}
              </span>
              <span className="truncate text-sm leading-5 text-text-secondary">
                {share.granteeEmail} · {describeSharePermissions(share.permissions)}
                {opensAs ? ` · ${opensAs}` : ""}
              </span>
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
  const labelOf = useRootLabel()
  if (shares === null || shares.length === 0) return null
  return (
    <div className="flex flex-col gap-2 border-t border-border-secondary pt-4">
      <span className="text-sm leading-4 text-text-secondary">Shared with you</span>
      <ul className="flex list-none flex-col gap-3 p-0">
        {shares.map((share) => (
          <li key={share.id} className="flex flex-col gap-1">
            <span className="flex flex-wrap gap-x-2 leading-4">
              {/* A shared block opens as a note of its own (shared-mode.ts). */}
              <Link
                to="/notes/$"
                params={{ _splat: share.view.rootId }}
                search={{ query: undefined }}
                className="link"
              >
                {labelOf(share.view.rootId)}
              </Link>
            </span>
            <span className="text-sm leading-5 text-text-secondary">
              Shared by {shareOwnerName(share)} · {describeSharePermissions(share.permissions)}
              {describeShareView(share.view) ? ` · ${describeShareView(share.view)}` : ""}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}
