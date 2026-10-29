import { Link } from "@tanstack/react-router"
import type React from "react"
import { CORPUS_ROOT_ID } from "../data/graph"
import { ROOT_LABEL } from "../data/root-frame"
import { cx } from "../utils/cx"

/**
 * **A page's icon, as the way back to Root** (src/data/root-frame.ts): the
 * note page's and the board page's header icon. The icon is 16px, which a
 * mouse hits and a finger does not: on a touch screen the link's hit area
 * grows to 40px around it (`before:`), so one tap lands on it. The area is
 * drawn by the link itself, so the tap is the link's, and nothing in the
 * header moves. `touch-manipulation` lets the tap go at once, with no wait
 * for a double tap.
 */
export function RootLink({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  return (
    <Link
      to="/notes/$"
      params={{ _splat: CORPUS_ROOT_ID }}
      search={{ query: undefined }}
      aria-label={ROOT_LABEL}
      data-testid="root-link"
      className={cx(
        "focus-ring relative flex touch-manipulation rounded-sm",
        "coarse:before:absolute coarse:before:-inset-3 coarse:before:content-['']",
        className,
      )}
    >
      {children}
    </Link>
  )
}
