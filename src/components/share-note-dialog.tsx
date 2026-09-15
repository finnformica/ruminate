import { atom, useAtom, useAtomValue } from "jotai"
import React from "react"
import { toast } from "sonner"
import { NOTE_TYPE } from "../data/graph"
import { createShare } from "../data/shares"
import { sharedOriginAtom } from "../data/shared-mode"
import { githubUserAtom, graphSnapshotAtom, notesAtom } from "../global-state"
import { Button } from "./button"
import { Dialog } from "./dialog"
import { TextInput } from "./text-input"

/**
 * "Share…" from a note's menu, or from a block's right-click menu
 * (docs/sharing.md): the root is already chosen — the note, or that block —
 * so the dialog asks only for the address. Mounted once by the app root; a
 * menu opens it by setting `shareDialogAtom` to the root's id.
 *
 * Only the user's own rows can be shared — a note someone shared with them
 * is that person's to share — and only signed in, so the dialog simply does
 * not open for anything else.
 */
export const shareDialogAtom = atom<string | null>(null)

/** How much of a block's text names it in the dialog's title. */
const LABEL_LENGTH = 60

export function ShareDialog() {
  const [rootId, setRootId] = useAtom(shareDialogAtom)
  const githubUser = useAtomValue(githubUserAtom)
  const graph = useAtomValue(graphSnapshotAtom)
  const notes = useAtomValue(notesAtom)
  const origin = useAtomValue(sharedOriginAtom)

  const node = rootId === null ? undefined : graph.nodes.get(rootId)
  const open = githubUser !== null && node !== undefined && !origin.has(node.id)
  const close = () => setRootId(null)

  if (!open) return <Dialog open={false} />

  const isNote = node.type === NOTE_TYPE
  const text = isNote ? (notes.get(node.id)?.displayName ?? node.text) : node.text.trim()
  const label = text.length > LABEL_LENGTH ? `${text.slice(0, LABEL_LENGTH - 1)}…` : text

  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : close())}>
      <ShareForm rootId={node.id} label={label || "Untitled"} isNote={isNote} onDone={close} />
    </Dialog>
  )
}

function ShareForm({
  rootId,
  label,
  isNote,
  onDone,
}: {
  rootId: string
  label: string
  isNote: boolean
  onDone: () => void
}) {
  const [email, setEmail] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const ready = email.trim() !== "" && !busy

  async function submit() {
    if (!ready) return
    setBusy(true)
    setError(null)
    try {
      await createShare({ email: email.trim(), rootIds: [rootId] })
      toast(`Shared “${label}” with ${email.trim().toLowerCase()}.`)
      onDone()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not share this.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog.Content title={`Share “${label}”`}>
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
      >
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
            // eslint-disable-next-line jsx-a11y/no-autofocus
            autoFocus
            onChange={(event) => setEmail(event.target.value)}
          />
          <span className="text-sm leading-5 text-text-secondary">
            Their GitHub sign-in email; they can read this {isNote ? "note" : "block"} and what is
            beneath it.
          </span>
        </div>
        {error ? <p className="text-text-danger">{error}</p> : null}
        <div className="flex gap-2">
          <Button type="submit" variant="primary" disabled={!ready}>
            {busy ? "Sharing…" : "Share"}
          </Button>
          <Button type="button" onClick={onDone}>
            Cancel
          </Button>
        </div>
      </form>
    </Dialog.Content>
  )
}
