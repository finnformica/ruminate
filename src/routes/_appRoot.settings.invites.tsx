import { createFileRoute } from "@tanstack/react-router"
import { InvitesSection } from "../components/settings/invites-section"
import { useIsAdmin } from "../data/features"
import { SettingsPageBody, settingsPage } from "../components/settings/settings-pages"

export const Route = createFileRoute("/_appRoot/settings/invites")({
  component: RouteComponent,
  head: () => ({ meta: [{ title: "Invites · Settings · Ruminate" }] }),
})

const page = settingsPage("invites")

function RouteComponent() {
  const isAdmin = useIsAdmin()
  return (
    <SettingsPageBody page={page}>
      {isAdmin ? <InvitesSection /> : <span className="text-text-secondary">Nothing here.</span>}
    </SettingsPageBody>
  )
}
