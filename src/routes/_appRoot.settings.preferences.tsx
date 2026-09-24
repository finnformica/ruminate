import { createFileRoute } from "@tanstack/react-router"
import { useAtomValue } from "jotai"
import { AppearanceSection } from "../components/settings/appearance-section"
import { EditorSection } from "../components/settings/editor-section"
import { UpdatesSection } from "../components/settings/updates-section"
import { githubUserAtom } from "../global-state"
import { SettingsPageBody, settingsPage } from "../components/settings/settings-pages"

export const Route = createFileRoute("/_appRoot/settings/preferences")({
  component: RouteComponent,
  head: () => ({ meta: [{ title: "Preferences · Settings · Ruminate" }] }),
})

const page = settingsPage("preferences")

function RouteComponent() {
  const githubUser = useAtomValue(githubUserAtom)
  return (
    <SettingsPageBody page={page}>
      <AppearanceSection />
      <EditorSection />
      {githubUser ? <UpdatesSection /> : null}
    </SettingsPageBody>
  )
}
