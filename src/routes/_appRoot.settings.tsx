import { createFileRoute, Outlet } from "@tanstack/react-router"
import { SettingsIcon16 } from "../components/icons"
import { PageLayout } from "../components/page-layout"
import { SettingsNav, useCurrentSettingsPage } from "../components/settings/settings-pages"

/**
 * Settings: one page per subject (src/components/settings/settings-pages.tsx),
 * chosen in a column beside the page where there is room for one, and from
 * a list at `/settings` on a phone, where each page stands alone.
 */
export const Route = createFileRoute("/_appRoot/settings")({
  component: RouteComponent,
  head: () => ({
    meta: [{ title: "Settings · Ruminate" }],
  }),
})

function RouteComponent() {
  const page = useCurrentSettingsPage()
  return (
    <PageLayout
      title={
        <span className="flex items-center gap-2">
          <span>Settings</span>
          {page ? (
            <span className="text-text-secondary sm:hidden">
              <span aria-hidden="true">/ </span>
              {page.label}
            </span>
          ) : null}
        </span>
      }
      icon={<SettingsIcon16 />}
      disableGuard
    >
      {/* The nav is its column's full height (the rule down its edge runs
          the page's height, however short the page), and sticks so it stays
          in view down a long one. */}
      <div className="grid min-h-full sm:grid-cols-[13rem_1fr]">
        <div className="hidden border-r border-border-secondary sm:block">
          <SettingsNav className="sticky top-0 p-2" />
        </div>
        <div className="p-4 pb-6">
          <div className="mx-auto max-w-xl">
            <Outlet />
          </div>
        </div>
      </div>
    </PageLayout>
  )
}
