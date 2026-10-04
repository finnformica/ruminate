import React from "react"
import { toast } from "sonner"
import { Toaster } from "./toaster"

export default {
  title: "Toaster",
  component: Toaster,
}

/**
 * The three things a toast says, and the two kinds sonner adds, fanned out
 * so each is seen whole: a notice, a success, an error, a warning.
 */
export const Kinds = {
  render: () => {
    React.useEffect(() => {
      toast("That block is already here")
      toast.success("Restored “Reading list”.", { action: { label: "Open", onClick: () => {} } })
      toast.error("Image upload failed")
      toast.warning("Sign in soon")
      return () => {
        toast.dismiss()
      }
    }, [])
    return <Toaster expand visibleToasts={4} />
  },
}
