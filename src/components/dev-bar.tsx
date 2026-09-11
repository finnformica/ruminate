import { useAtomValue } from "jotai"
import React from "react"
import { useHotkeys } from "react-hotkeys-hook"
import { authStateAtom } from "../global-state"
import { APP_SHORTCUTS, GLOBAL_HOTKEY_OPTIONS } from "../shortcuts/registry"

/**
 * Shows where the identity stands (resolving, signed in, signed out) and the
 * active breakpoint, for debugging.
 */
export function DevBar() {
  const authState = useAtomValue(authStateAtom)

  // Toggle dev bar with ctrl+`
  const [isEnabled, setIsEnabled] = React.useState(false)
  useHotkeys(APP_SHORTCUTS.devBar, () => setIsEnabled((prev) => !prev), {
    ...GLOBAL_HOTKEY_OPTIONS,
    enabled: import.meta.env.DEV,
  })

  if (!isEnabled) return null

  return (
    <div className="fixed bottom-16 left-2 flex h-6 items-center rounded bg-bg sm:bottom-2">
      <div className="flex h-6 items-center gap-1.5 whitespace-nowrap rounded bg-bg-secondary px-2 font-mono text-sm text-text-secondary">
        <span>{authState}</span>
        <span className="text-text-tertiary">·</span>
        <CurrentBreakpoint />
      </div>
    </div>
  )
}

function CurrentBreakpoint() {
  return (
    <span>
      <span className="sm:hidden">xs</span>
      <span className="hidden sm:inline md:hidden">sm</span>
      <span className="hidden md:inline lg:hidden">md</span>
      <span className="hidden lg:inline xl:hidden">lg</span>
      <span className="hidden xl:inline 2xl:hidden">xl</span>
      <span className="hidden 2xl:inline">2xl</span>
    </span>
  )
}
