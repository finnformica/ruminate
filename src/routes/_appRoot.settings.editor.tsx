import { createFileRoute } from "@tanstack/react-router"
import { EditorSection } from "../components/settings/editor-section"
import { SettingsPageBody, settingsPage } from "../components/settings/settings-pages"

export const Route = createFileRoute("/_appRoot/settings/editor")({
  component: RouteComponent,
  head: () => ({ meta: [{ title: "Editor · Settings · Ruminate" }] }),
})

const page = settingsPage("editor")

function RouteComponent() {
  return (
    <SettingsPageBody page={page}>
      <EditorSection />
    </SettingsPageBody>
  )
}
