import React from "react"

/**
 * Whether the tree is inside a modal surface (a `Dialog`). A popup opened
 * from there — a menu in a dialog's form — is positioned in the modal
 * layer rather than the popup one, or it would open behind the window
 * that holds its trigger (docs/design-principles.md, "Elevation"). The
 * dialog provides it; the positioned parts read it.
 */
export const InModalContext = React.createContext(false)
