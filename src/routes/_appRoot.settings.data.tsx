import { createFileRoute } from "@tanstack/react-router"
import { useAtomValue } from "jotai"
import { DeletedNotesSection } from "../components/deleted-notes-section"
import { StorageSection } from "../components/settings/storage-section"
import { githubUserAtom } from "../global-state"
import { SettingsPageBody, settingsPage } from "../components/settings/settings-pages"

export const Route = createFileRoute("/_appRoot/settings/data")({
  component: RouteComponent,
  head: () => ({ meta: [{ title: "Data · Settings · Ruminate" }] }),
})

const page = settingsPage("data")

function RouteComponent() {
  const githubUser = useAtomValue(githubUserAtom)
  return (
    <SettingsPageBody page={page}>
      <StorageSection />
      {githubUser ? <DeletedNotesSection /> : null}
    </SettingsPageBody>
  )
}
