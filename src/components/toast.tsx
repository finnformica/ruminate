import { Toast } from "@base-ui/react/toast"
import { cx } from "../utils/cx"
import { Button } from "./button"
import { ErrorIcon16 } from "./icons"

/**
 * The app's toasts — see "Toasts" in docs/design-principles.md.
 *
 * A toast is the one message that floats: it tells the reader that something
 * they have just done has failed (a picture that would not upload), then
 * leaves on its own. It is drawn as a Notice card — same surface, same icon
 * slot, same Dismiss — so the two read as one family; only its placement (the
 * bottom corner, above the phone nav bar) and its exit (a timer) differ.
 *
 * The manager is module-level so anything can raise a toast without a hook —
 * the editor's upload path, say — and so a toast raised while no `Toaster` is
 * mounted (a unit test) is simply nobody's business.
 */
const manager = Toast.createToastManager()

/** Say that something the reader just did has failed. */
export function toastError(message: string): void {
  manager.add({ type: "error", title: message, priority: "high" })
}

/** The viewport toasts land in. Mounted once, at the app root. */
export function Toaster() {
  return (
    <Toast.Provider toastManager={manager} timeout={6000} limit={3}>
      <Toast.Portal>
        <Toast.Viewport
          className={cx(
            "pointer-events-none fixed bottom-0 right-0 z-30 flex w-full max-w-sm flex-col gap-2 p-4 print:hidden",
            "pb-[calc(env(safe-area-inset-bottom)+1rem)]",
            // Above the phone nav bar (app-layout.tsx shows it below `sm`).
            "max-sm:pb-[calc(var(--height-nav-bar)+env(safe-area-inset-bottom)+1rem)]",
          )}
        >
          <ToastList />
        </Toast.Viewport>
      </Toast.Portal>
    </Toast.Provider>
  )
}

function ToastList() {
  const { toasts } = Toast.useToastManager()
  return toasts.map((toast) => (
    <Toast.Root
      key={toast.id}
      toast={toast}
      className={cx(
        "card-2 pointer-events-auto flex items-start justify-between gap-x-3 p-2 pl-3",
        "[translate:var(--toast-swipe-movement-x)_var(--toast-swipe-movement-y)]",
        "transition-[translate,opacity] duration-200 ease-out",
        "data-[ending-style]:opacity-0 data-[starting-style]:opacity-0 data-[starting-style]:[translate:0_0.5rem]",
        "data-[limited]:hidden",
      )}
    >
      <span className="flex min-w-0 grow items-start gap-2">
        <span
          className={cx(
            "grid h-6 shrink-0 place-items-center",
            toast.type === "error" ? "text-text-danger" : "text-text-tertiary",
          )}
        >
          <ErrorIcon16 />
        </span>
        <span className="min-w-0 grow pt-0.5 leading-5">
          <Toast.Title className="font-normal">{toast.title}</Toast.Title>
          {toast.description ? (
            <Toast.Description className="text-text-secondary">
              {toast.description}
            </Toast.Description>
          ) : null}
        </span>
      </span>
      <Toast.Close render={<Button size="small" />} className="shrink-0">
        Dismiss
      </Toast.Close>
    </Toast.Root>
  ))
}
