import React from "react"
import { Button } from "./button"
import { Dialog } from "./dialog"

export type ConfirmDialogVariant = "danger" | "primary"

export interface ConfirmDialogProps {
  open: boolean
  /** Called with `false` when the dialog is put away: Cancel, the close
   * control, <kbd>Esc</kbd>, a click on the scrim, or a confirm that has
   * finished. Not called while a confirm is in flight — the dialog holds
   * until it settles. */
  onOpenChange: (open: boolean) => void
  /** The question, as a question, naming what it is about: "Delete “Ideas”?". */
  title: React.ReactNode
  /** What confirming does, and what it cannot undo, read before the button
   * that does it. Plain text or inline markup; the dialog sets the type. */
  children?: React.ReactNode
  /**
   * The confirm button's label: the verb the title asks about ("Delete",
   * "Revoke", "Sign out"), never a bare "OK" or "Yes" — a label that repeats
   * the question is the one a reader in a hurry can still get right.
   */
  confirmLabel: string
  /** @default "Cancel" */
  cancelLabel?: string
  /**
   * What confirming is: `danger` for something that cannot be taken back,
   * or not easily — the confirm is drawn in the app's one solid red, and the
   * dialog opens with focus on Cancel so <kbd>Enter</kbd> is the safe
   * answer; `primary` for a step that is merely worth a second look, drawn
   * as the strongest ordinary button, with focus on it.
   * @default "primary"
   */
  variant?: ConfirmDialogVariant
  /**
   * The confirm's work. A promise holds the dialog open, its confirm busy
   * and its cancel disabled, until it settles: resolved, the dialog closes;
   * rejected, the error's message is shown beneath the buttons and the
   * dialog stays for another go. Returning nothing closes at once.
   */
  onConfirm: () => Promise<unknown> | void
  /** Called when the dialog is put away without confirming. */
  onCancel?: () => void
}

/**
 * The one confirmation dialog: a question, a sentence on what answering yes
 * does, and two buttons — the verb, and Cancel. Every "are you sure?" in the
 * app is this component, so they all read, focus and fail the same way
 * (docs/design-principles.md, "Confirmation").
 *
 * Controlled by `open`/`onOpenChange`, as `Dialog` is; the caller decides
 * what is being confirmed and holds it. An async `onConfirm` is the busy
 * pattern every request follows (docs/design-principles.md, "Busy
 * controls"): the button spins from the click until the promise settles.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  children,
  confirmLabel,
  cancelLabel = "Cancel",
  variant = "primary",
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const confirmRef = React.useRef<HTMLButtonElement>(null)
  const cancelRef = React.useRef<HTMLButtonElement>(null)
  // A settle after the dialog has gone (or reopened for something else)
  // must not touch it: the flight is tied to the open it started in.
  const flight = React.useRef(0)

  // Each opening starts clean: an error from last time is not this time's.
  React.useEffect(() => {
    if (!open) return
    setBusy(false)
    setError(null)
    flight.current += 1
  }, [open])

  const close = () => {
    if (busy) return
    onOpenChange(false)
  }

  const cancel = () => {
    if (busy) return
    onCancel?.()
    onOpenChange(false)
  }

  const confirm = () => {
    if (busy) return
    setError(null)
    let result: Promise<unknown> | void
    try {
      result = onConfirm()
    } catch (caught) {
      setError(messageOf(caught))
      return
    }
    if (!result) {
      onOpenChange(false)
      return
    }
    const id = flight.current
    setBusy(true)
    result.then(
      () => {
        if (id !== flight.current) return
        setBusy(false)
        onOpenChange(false)
      },
      (caught: unknown) => {
        if (id !== flight.current) return
        setBusy(false)
        setError(messageOf(caught))
      },
    )
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : close())}>
      <Dialog.Content
        title={title}
        role="alertdialog"
        // Danger opens on Cancel, so Enter is the safe answer to a dialog the
        // reader has not yet read; primary opens on the confirm, since going
        // ahead is the expected answer.
        initialFocus={variant === "danger" ? cancelRef : confirmRef}
      >
        <div className="flex flex-col gap-4">
          {children ? <p className="leading-5 text-text-secondary">{children}</p> : null}
          <div className="flex gap-2">
            <Button ref={confirmRef} variant={variant} loading={busy} onClick={confirm}>
              {confirmLabel}
            </Button>
            <Button ref={cancelRef} disabled={busy} onClick={cancel}>
              {cancelLabel}
            </Button>
          </div>
          {error ? (
            <p role="alert" className="text-sm leading-5 text-text-danger">
              {error}
            </p>
          ) : null}
        </div>
      </Dialog.Content>
    </Dialog>
  )
}

function messageOf(caught: unknown): string {
  return caught instanceof Error && caught.message ? caught.message : "Something went wrong."
}
