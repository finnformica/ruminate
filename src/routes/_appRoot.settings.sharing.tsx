import { createFileRoute } from "@tanstack/react-router"
import { SharingSection } from "../components/sharing-section"
import { SettingsPageBody, settingsPage } from "../components/settings/settings-pages"

export const Route = createFileRoute("/_appRoot/settings/sharing")({
  component: RouteComponent,
  head: () => ({ meta: [{ title: "Sharing · Settings · Ruminate" }] }),
})

const page = settingsPage("sharing")

function RouteComponent() {
  return (
    <SettingsPageBody page={page}>
      <SharingSection />
    </SettingsPageBody>
  )
}
