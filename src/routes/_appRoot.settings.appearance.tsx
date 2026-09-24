import { createFileRoute } from "@tanstack/react-router"
import { AppearanceSection } from "../components/settings/appearance-section"
import { SettingsPageBody, settingsPage } from "../components/settings/settings-pages"

export const Route = createFileRoute("/_appRoot/settings/appearance")({
  component: RouteComponent,
  head: () => ({ meta: [{ title: "Appearance · Settings · Ruminate" }] }),
})

const page = settingsPage("appearance")

function RouteComponent() {
  return (
    <SettingsPageBody page={page}>
      <AppearanceSection />
    </SettingsPageBody>
  )
}
