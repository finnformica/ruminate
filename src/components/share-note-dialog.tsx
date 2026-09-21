import { atom, useAtom, useAtomValue } from "jotai"
import React from "react"
import { toast } from "sonner"
import { NOTE_TYPE } from "../data/graph"
import { requestDatabasePull } from "../data/database-mode"
import { createShare, describeSharePermissions, type SharePermission } from "../data/shares"
import { sharedOriginAtom } from "../data/shared-mode"
import { githubUserAtom, graphSnapshotAtom, notesAtom } from "../global-state"
import { Button } from "./ui/button"
import { Checkbox } from "./ui/checkbox"
import { Dialog } from "./ui/dialog"
import { TextInput } from "./ui/text-input"

/**
 * "Share…" from a note's menu, or from a block's right-click menu
 * (docs/sharing.md): the root is already chosen — the note, or that block —
 * so the dialog asks for the address and the verbs. Read is always granted;
 * edit and delete are opted into, and the sentence above the button says
 * what is about to be granted. Mounted once by the app root; a
 * menu opens it by setting `shareDialogAtom` to the root's id.
 *
 * Only the user's own rows can be shared — a note someone shared with them
 * is that person's to share — and only signed in, so the dialog simply does
 * not open for anything else.
 */
export const shareDialogAtom = atom<string | null>(null)

const VERB_OPTIONS: { value: SharePermission; label: string; detail: string }[] = [
  { value: "write", label: "Edit", detail: "Change it, and add blocks beneath it" },
  { value: "delete", label: "Delete", detail: "Delete blocks, or the root itself" },
]

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
  const [verbs, setVerbs] = React.useState<SharePermission[]>([])
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const ready = email.trim() !== "" && !busy

  const toggleVerb = (verb: SharePermission) =>
    setVerbs((current) =>
      current.includes(verb) ? current.filter((entry) => entry !== verb) : [...current, verb],
    )

  async function submit() {
    if (!ready) return
    setBusy(true)
    setError(null)
    try {
      await createShare({ email: email.trim(), rootId, permissions: verbs })
      // The share is a view of the node, made for the owner where they had
      // none (docs/sharing.md): pull, so this device holds the row too.
      requestDatabasePull()
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
          <span className="text-sm leading-5 text-text-secondary">Their GitHub sign-in email.</span>
        </div>
        <fieldset className="flex flex-col gap-2 border-0 p-0">
          <legend className="text-sm leading-4 text-text-secondary">They can</legend>
          {VERB_OPTIONS.map((option) => (
            <div key={option.value} className="flex items-start gap-2 leading-4">
              <Checkbox
                id={`share-verb-${option.value}`}
                className="mt-0.5"
                checked={verbs.includes(option.value)}
                onCheckedChange={() => toggleVerb(option.value)}
              />
              <label
                htmlFor={`share-verb-${option.value}`}
                className="flex cursor-pointer flex-col gap-1"
              >
                <span>{option.label}</span>
                <span className="text-sm leading-4 text-text-secondary">{option.detail}</span>
              </label>
            </div>
          ))}
        </fieldset>
        {/* What is about to be granted, in a sentence — read before the
            button that grants it. */}
        <p className="leading-5 text-text-secondary">
          They can <span className="text-text">{describeSharePermissions(["read", ...verbs])}</span>{" "}
          this {isNote ? "note" : "block"} and what is beneath it.
        </p>
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
