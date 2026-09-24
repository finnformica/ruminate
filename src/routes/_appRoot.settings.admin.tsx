import { createFileRoute } from "@tanstack/react-router"
import { FeaturesSection } from "../components/settings/features-section"
import { InvitesSection } from "../components/settings/invites-section"
import { useIsAdmin } from "../data/features"
import { SettingsPageBody, settingsPage } from "../components/settings/settings-pages"

export const Route = createFileRoute("/_appRoot/settings/admin")({
  component: RouteComponent,
  head: () => ({ meta: [{ title: "Admin · Settings · Ruminate" }] }),
})

const page = settingsPage("admin")

function RouteComponent() {
  const isAdmin = useIsAdmin()
  return (
    <SettingsPageBody page={page}>
      {isAdmin ? (
        <>
          <FeaturesSection />
          <InvitesSection />
        </>
      ) : (
        <span className="text-text-secondary">Nothing here.</span>
      )}
    </SettingsPageBody>
  )
}
