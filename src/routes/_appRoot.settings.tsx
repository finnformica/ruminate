import { createFileRoute, Outlet } from "@tanstack/react-router"
import { SettingsIcon16 } from "../components/icons"
import { PageLayout } from "../components/page-layout"
import { useCurrentSettingsPage } from "../components/settings/settings-pages"

/**
 * Settings: one page per subject (src/components/settings/settings-pages.tsx),
 * chosen in the sidebar, which lists the pages while Settings is open — and
 * from a list at `/settings` on a phone, where each page stands alone.
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
      <div className="p-4 pb-6">
        <div className="mx-auto max-w-xl">
          <Outlet />
        </div>
      </div>
    </PageLayout>
  )
}
