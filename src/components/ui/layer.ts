import React from "react"

/**
 * Whether the tree is inside a modal surface (a `Dialog`). A popup opened
 * from there — a menu in a dialog's form — is positioned in the modal
 * layer rather than the popup one, or it would open behind the window
 * that holds its trigger (docs/design-principles.md, "Elevation"). The
 * dialog provides it; the positioned parts read it.
 */
export const InModalContext = React.createContext(false)

/**
 * The page's own box (`PageLayout`): where a `FloatingBar` is placed, so
 * that it clears whatever the app draws beneath the page — the phone's nav
 * bar and the sign-in banner inside it — without knowing the height of
 * either. Null outside a page (a story, a test), where the bar falls back
 * to the window.
 */
export const FloatingHostContext = React.createContext<HTMLElement | null>(null)
