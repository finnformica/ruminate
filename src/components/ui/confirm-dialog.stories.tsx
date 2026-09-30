import React from "react"
import { Button } from "./button"
import { ConfirmDialog, type ConfirmDialogVariant } from "./confirm-dialog"

export default {
  title: "ConfirmDialog",
  component: ConfirmDialog,
  parameters: {
    layout: "centered",
  },
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function Demo({
  variant,
  confirmLabel,
  onConfirm,
  children,
  title,
}: {
  variant: ConfirmDialogVariant
  confirmLabel: string
  onConfirm: () => Promise<unknown> | void
  children: React.ReactNode
  title: string
}) {
  const [open, setOpen] = React.useState(false)
  return (
    <>
      <Button onClick={() => setOpen(true)}>Open</Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={title}
        confirmLabel={confirmLabel}
        variant={variant}
        onConfirm={onConfirm}
      >
        {children}
      </ConfirmDialog>
    </>
  )
}

/** Something that cannot be taken back: a red confirm, and focus on Cancel. */
export const Danger = {
  render: () => (
    <Demo variant="danger" title="Delete “Ideas”?" confirmLabel="Delete" onConfirm={() => {}}>
      The note and everything only it holds will be deleted.
    </Demo>
  ),
}

/** A step worth a second look: the strongest ordinary button, focused. */
export const Primary = {
  render: () => (
    <Demo
      variant="primary"
      title="Push the full copy now?"
      confirmLabel="Push"
      onConfirm={() => {}}
    >
      Every note is sent again. Nothing is lost, but it takes a moment.
    </Demo>
  ),
}

/** Confirm it: busy for two seconds, then closed. */
export const Async = {
  render: () => (
    <Demo
      variant="danger"
      title="Revoke this token?"
      confirmLabel="Revoke"
      onConfirm={() => wait(2000)}
    >
      Anything using it stops working at once.
    </Demo>
  ),
}

/** Confirm it: busy for a second, then the failure, and the dialog stays. */
export const Failing = {
  render: () => (
    <Demo
      variant="danger"
      title="Revoke this token?"
      confirmLabel="Revoke"
      onConfirm={() =>
        wait(1000).then(() => Promise.reject(new Error("Could not reach the server.")))
      }
    >
      Anything using it stops working at once.
    </Demo>
  ),
}
