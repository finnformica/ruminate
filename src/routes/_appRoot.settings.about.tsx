import { createFileRoute } from "@tanstack/react-router"
import { AboutSection } from "../components/settings/about-section"
import { SettingsPageBody, settingsPage } from "../components/settings/settings-pages"

export const Route = createFileRoute("/_appRoot/settings/about")({
  component: RouteComponent,
  head: () => ({ meta: [{ title: "About · Settings · Ruminate" }] }),
})

const page = settingsPage("about")

function RouteComponent() {
  return (
    <SettingsPageBody page={page}>
      <AboutSection />
    </SettingsPageBody>
  )
}
