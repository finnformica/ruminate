import { useNavigate } from "@tanstack/react-router"
import { useAtomValue } from "jotai"
import React from "react"
import { useNetworkState } from "react-use"
import { recordedEmailAtom } from "../../data/shared-mode"
import { githubUserAtom } from "../../global-state"
import { usePending } from "../../hooks/pending"
import { FormControl } from "../form-control"
import { SignInButton, useSignOut } from "../github-auth"
import { GitHubAvatar } from "../github-avatar"
import { ChevronDownIcon16 } from "../icons"
import { Button } from "../ui/button"
import { DropdownMenu } from "../ui/dropdown-menu"
import { TextInput } from "../ui/text-input"
import { SettingsSection } from "../settings-section"

/**
 * PROTOTYPE — the Account page's **Profile** card: the person's name, as
 * first and last, and the address others share notes with them at.
 *
 * Nothing here is saved yet. The shape it proposes: the name and the chosen
 * address live on the `users` row (control plane, worker/handlers/tenancy.ts),
 * read and written through one `/api/account` route; the address is CHOSEN
 * from the ones GitHub reports as verified for the account, never typed,
 * since it is what sharing resolves a grantee by (docs/sharing.md §2 — a
 * typed address would let anyone claim anyone's shares). The sign-in's
 * refresh of `users.email` would then defer to the choice while it stays
 * verified on GitHub.
 */
export function ProfileSection() {
  const githubUser = useAtomValue(githubUserAtom)
  const recordedEmail = useAtomValue(recordedEmailAtom)
  const { online } = useNetworkState()

  // Seeded from what the sign-in already knows. A real profile would come
  // from the server (with the verified addresses to choose from).
  const [given, family] = splitName(githubUser?.name ?? "")
  const [firstName, setFirstName] = React.useState(given)
  const [lastName, setLastName] = React.useState(family)
  const email = recordedEmail ?? githubUser?.email ?? ""
  const [chosenEmail, setChosenEmail] = React.useState(email)
  const emails = React.useMemo(() => [email], [email])
  // The sign-in resolves a beat after the page mounts: follow it.
  React.useEffect(() => {
    setFirstName(given)
    setLastName(family)
  }, [given, family])
  React.useEffect(() => {
    setChosenEmail(email)
  }, [email])

  const dirty = firstName !== given || lastName !== family || chosenEmail !== email
  const [save, saving] = usePending(async () => {
    // Prototype: nowhere to send it yet.
    await new Promise((resolve) => setTimeout(resolve, 600))
  })

  if (!githubUser) {
    return (
      <SettingsSection title="Profile">
        <div className="flex flex-col gap-3">
          <span className="leading-5 text-text-secondary">
            Sign in with GitHub to keep your notes, and to set your name and email address.
          </span>
          <SignInButton className="self-start" />
        </div>
      </SettingsSection>
    )
  }

  return (
    <SettingsSection title="Profile">
      <div className="flex items-center gap-3">
        {online ? <GitHubAvatar login={githubUser.login} size={40} /> : null}
        <div className="flex w-0 grow flex-col gap-1">
          <span className="leading-4">{[firstName, lastName].filter(Boolean).join(" ")}</span>
          <span className="text-sm leading-4 text-text-secondary">
            Your picture comes from GitHub.
          </span>
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <FormControl htmlFor="first-name" label="First name">
          <TextInput
            id="first-name"
            value={firstName}
            autoComplete="given-name"
            onChange={(event) => setFirstName(event.target.value)}
          />
        </FormControl>
        <FormControl htmlFor="last-name" label="Last name">
          <TextInput
            id="last-name"
            value={lastName}
            autoComplete="family-name"
            onChange={(event) => setLastName(event.target.value)}
          />
        </FormControl>
      </div>
      <div className="flex flex-col gap-2">
        <span id="email-label" className="text-sm leading-4 text-text-secondary">
          Email address
        </span>
        <DropdownMenu modal={false}>
          <DropdownMenu.Trigger
            render={
              <Button className="self-start" aria-labelledby="email-label">
                <span className="truncate">{chosenEmail}</span>
                <ChevronDownIcon16 />
              </Button>
            }
          />
          <DropdownMenu.Content align="start" width={280}>
            <DropdownMenu.Group>
              <DropdownMenu.GroupLabel>Verified on GitHub</DropdownMenu.GroupLabel>
              {emails.map((address) => (
                <DropdownMenu.Item
                  key={address}
                  selected={address === chosenEmail}
                  onClick={() => setChosenEmail(address)}
                >
                  {address}
                </DropdownMenu.Item>
              ))}
            </DropdownMenu.Group>
          </DropdownMenu.Content>
        </DropdownMenu>
        <span className="text-sm leading-5 text-text-secondary text-pretty">
          Others share notes with you at this address. Choose any address verified on your GitHub
          account — add one at{" "}
          <a
            className="link"
            href="https://github.com/settings/emails"
            target="_blank"
            rel="noopener noreferrer"
          >
            github.com/settings/emails
          </a>
          .
        </span>
      </div>
      <div className="flex gap-2">
        <Button variant="primary" disabled={!dirty} loading={saving} onClick={() => save()}>
          Save changes
        </Button>
        {dirty ? (
          <Button
            onClick={() => {
              setFirstName(given)
              setLastName(family)
              setChosenEmail(email)
            }}
          >
            Cancel
          </Button>
        ) : null}
      </div>
    </SettingsSection>
  )
}

/** "Ada Lovelace" → ["Ada", "Lovelace"]; a single word is all first name. */
function splitName(name: string): [string, string] {
  const trimmed = name.trim()
  const at = trimmed.indexOf(" ")
  return at === -1 ? [trimmed, ""] : [trimmed.slice(0, at), trimmed.slice(at + 1).trim()]
}

/** The sign-in itself: which GitHub account, and the way out. */
export function SignInSection() {
  const navigate = useNavigate()
  const githubUser = useAtomValue(githubUserAtom)
  const signOut = useSignOut()
  const { online } = useNetworkState()

  if (!githubUser) return null

  // GitHub is identity only — no repository backs the notes.
  return (
    <SettingsSection title="Sign-in">
      <div className="flex items-center justify-between gap-4">
        <div className="flex w-0 grow flex-col gap-1">
          <span className="flex items-center gap-2 leading-4">
            {online ? <GitHubAvatar login={githubUser.login} size={16} /> : null}
            <span className="truncate">{githubUser.login}</span>
          </span>
          <span className="truncate text-sm leading-5 text-text-secondary">
            Signed in with GitHub. Ruminate uses it for identity only.
          </span>
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
