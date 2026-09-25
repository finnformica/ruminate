import { createFileRoute, notFound } from "@tanstack/react-router"
import {
  isSettingsPageId,
  SettingsPageBody,
  settingsPage,
} from "../components/settings/settings-nav"
import { SettingsPageContent } from "../components/settings/settings-pages"

/** One settings page: `/settings/<id>` — Account, Preferences, Sharing…
 * (src/components/settings/settings-nav.tsx). An id that names no page is
 * not found. */
export const Route = createFileRoute("/_appRoot/settings/$page")({
  loader: ({ params }) => {
    if (!isSettingsPageId(params.page)) throw notFound()
    return settingsPage(params.page)
  },
  head: ({ loaderData }) => ({
    meta: [{ title: `${loaderData?.label ?? "Settings"} · Settings · Ruminate` }],
  }),
  component: RouteComponent,
})

function RouteComponent() {
  const page = Route.useLoaderData()
  return (
    <SettingsPageBody page={page}>
      <SettingsPageContent id={page.id} />
    </SettingsPageBody>
  )
}
