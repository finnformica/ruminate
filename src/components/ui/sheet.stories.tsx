import React from "react"
import { Sheet } from "./sheet"
import { Button } from "./button"

export default {
  title: "Sheet",
  component: Sheet,
  parameters: {
    layout: "fullscreen",
  },
}

/** A phone's sheet: tap the button. */
export const Default = {
  render: () => {
    const [open, setOpen] = React.useState(false)
    return (
      <div className="grid h-screen place-items-center">
        <Sheet open={open} onOpenChange={setOpen}>
          <Sheet.Trigger asChild>
            <Button>Open sheet</Button>
          </Sheet.Trigger>
          <Sheet.Content title="Example">
            <div className="p-4">The sheet's content.</div>
          </Sheet.Content>
        </Sheet>
      </div>
    )
  },
}

/** Held open, with the handle and a visible title, sized to its content. */
export const Open = {
  render: () => (
    <div className="h-screen">
      <Sheet open>
        <Sheet.Content size="fit" handle titleVisible title="A block">
          <div className="flex flex-col gap-1 px-2 pb-2">
            <div className="px-3 py-2">Turn into…</div>
            <div className="px-3 py-2">Copy link</div>
            <div className="px-3 py-2 text-text-danger">Delete</div>
          </div>
        </Sheet.Content>
      </Sheet>
    </div>
  ),
}
