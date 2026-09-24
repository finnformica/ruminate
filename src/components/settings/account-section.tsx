import { useNavigate } from "@tanstack/react-router"
import { useAtomValue } from "jotai"
import { useNetworkState } from "react-use"
import { recordedEmailAtom } from "../../data/shared-mode"
import { githubUserAtom } from "../../global-state"
import { SignInButton, useSignOut } from "../github-auth"
import { GitHubAvatar } from "../github-avatar"
import { Button } from "../ui/button"
import { SettingsSection } from "../settings-section"

/** The GitHub account this sign-in is: name, login and the address others
 * share notes with (as the server has it recorded, which is what sharing
 * resolves against — falling back to the sign-in's copy until the first
 * shares request has answered). GitHub is identity only: no repository
 * backs the notes. */
export function AccountSection() {
  const navigate = useNavigate()
  const githubUser = useAtomValue(githubUserAtom)
  const recordedEmail = useAtomValue(recordedEmailAtom)
  const signOut = useSignOut()
  const { online } = useNetworkState()

  if (!githubUser) {
    return (
      <SettingsSection title="GitHub">
        <span className="leading-5 text-text-secondary">
          Sign in with GitHub to keep your notes and sync them between devices.
        </span>
        <SignInButton className="self-start" />
      </SettingsSection>
    )
  }

  return (
    <SettingsSection title="GitHub">
      <div className="flex items-center justify-between gap-4">
        <div className="flex w-0 grow items-center gap-3">
          {online ? <GitHubAvatar login={githubUser.login} size={40} /> : null}
          <div className="flex w-0 grow flex-col gap-1">
            <span className="truncate leading-4">{githubUser.name}</span>
            <span className="truncate text-sm leading-5 text-text-secondary">
              {githubUser.login} · {recordedEmail ?? githubUser.email}
            </span>
          </div>
        </div>
        <Button
          className="shrink-0"
          onClick={() => {
            signOut()
            navigate({ to: "/", search: { query: undefined } })
          }}
        >
          Sign out
        </Button>
      </div>
    </SettingsSection>
  )
}
