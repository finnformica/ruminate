import { cx } from "../utils/cx"

/**
 * Loading placeholders — see "Loading" in docs/design-principles.md.
 *
 * A skeleton stands where content is about to be, at the content's own size
 * and shape, so the page settles rather than jumping when the real thing
 * lands. Bars are chrome-rank (`bg-bg-tertiary`) and pulse quietly; they
 * carry no words. One live region names the state for screen readers.
 */
export function Skeleton({ className }: { className?: string }) {
  return (
    <span aria-hidden className={cx("block animate-pulse rounded bg-bg-tertiary", className)} />
  )
}

/** A page's content while the notes are still on their way: a title-sized
 * bar and a few lines of prose at varying lengths, in the page column. */
export function PageSkeleton() {
  return (
    <div role="status" aria-label="Loading" data-testid="page-skeleton" className="p-4 sm:p-10">
      <div className="mx-auto flex max-w-2xl flex-col gap-3">
        <Skeleton className="mb-3 h-8 w-2/5" />
        <Skeleton className="h-4 w-11/12" />
        <Skeleton className="h-4 w-4/5" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-3/5" />
        <Skeleton className="mt-3 h-4 w-5/6" />
        <Skeleton className="h-4 w-2/3" />
      </div>
    </div>
  )
}

/** The sidebar's note rows while the notes are still on their way. */
export function NavListSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div
      role="status"
      aria-label="Loading"
      data-testid="nav-skeleton"
      className="flex flex-col gap-1 border-t border-border-secondary pt-3"
    >
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex h-8 items-center gap-3 px-2 coarse:h-10 coarse:px-3">
          <Skeleton className="h-4 w-4 shrink-0 rounded-sm" />
          <Skeleton className={cx("h-3", i === 0 ? "w-3/5" : i === 1 ? "w-2/5" : "w-1/2")} />
        </div>
      ))}
    </div>
  )
}
