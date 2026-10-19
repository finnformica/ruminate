import { useAtomValue, useStore } from "jotai"
import React from "react"
import { useEvent } from "react-use"
import { toast } from "sonner"
import { graphSnapshotAtom } from "../global-state"
import { databaseModeStatusAtom, requestDatabaseFlush } from "./database-mode"
import { drainUploads } from "./image-queue"
import { ImageUploadError, imagesEnabled } from "./images"
import { useApplyOps } from "./store"

/**
 * Sends the pictures added offline (`image-queue.ts`) once they can go:
 * when the notes have loaded (a start with some still waiting), when the
 * browser comes back online, and when the app comes back to the front (a
 * phone's network can return while the app is asleep, with no `online`
 * event to say so). Rendered once from the app root; inert with images
 * off or the database not open.
 */
export function useUploadQueue() {
  const status = useAtomValue(databaseModeStatusAtom)
  const store = useStore()
  const apply = useApplyOps()
  const ready = imagesEnabled && status.status === "ready"

  const drain = React.useCallback(() => {
    if (!ready) return
    void drainUploads({
      graph: () => store.get(graphSnapshotAtom),
      apply: (ops) => apply(ops),
      onRefused: (error) =>
        toast.error(error instanceof ImageUploadError ? error.message : "Image upload failed"),
    }).then(() => requestDatabaseFlush())
  }, [ready, store, apply])

  React.useEffect(drain, [drain])
  useEvent("online", drain)
  useEvent("visibilitychange", () => {
    if (document.visibilityState === "visible") drain()
  })
}
