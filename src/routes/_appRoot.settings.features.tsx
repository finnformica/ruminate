import { createFileRoute } from "@tanstack/react-router"
import { FeaturesSection } from "../components/settings/features-section"
import { useIsAdmin } from "../data/features"
import { SettingsPageBody, settingsPage } from "../components/settings/settings-pages"

export const Route = createFileRoute("/_appRoot/settings/features")({
  component: RouteComponent,
  head: () => ({ meta: [{ title: "Feature flags · Settings · Ruminate" }] }),
})

const page = settingsPage("features")

function RouteComponent() {
  const isAdmin = useIsAdmin()
  return (
    <SettingsPageBody page={page}>
      {isAdmin ? <FeaturesSection /> : <span className="text-text-secondary">Nothing here.</span>}
    </SettingsPageBody>
  )
}
