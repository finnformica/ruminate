import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useAtomValue, useSetAtom } from "jotai"
import { useState } from "react"
import { useNetworkState } from "react-use"
import { Button } from "../components/button"
import { useSignOut } from "../components/github-auth"
import { GitHubAvatar } from "../components/github-avatar"
import { LoadingIcon16, SettingsIcon16 } from "../components/icons"
import { PageLayout } from "../components/page-layout"
import { RepoForm } from "../components/repo-form"
import { Signature } from "../components/signature"
import {
  githubRepoAtom,
  githubUserAtom,
  globalStateMachineAtom,
  isCloningRepoAtom,
  isRepoClonedAtom,
  isRepoNotClonedAtom,
} from "../global-state"

export const Route = createFileRoute("/_appRoot/settings")({
  component: RouteComponent,
  head: () => ({
    meta: [{ title: "Settings · Ruminate" }],
  }),
})

function RouteComponent() {
  return (
    <PageLayout title="Settings" icon={<SettingsIcon16 />} disableGuard>
      <div className="p-4 pb-6">
        <div className="mx-auto flex max-w-xl flex-col gap-6">
          <GitHubSection />
          <div className="p-5 text-text-tertiary self-center flex flex-col gap-3 items-center">
            <span className="text-sm">
              Made by{" "}
              <a
                className="link decoration-text-tertiary"
                href="https://colebemis.com"
                target="_blank"
                rel="noopener noreferrer"
              >
                Cole Bemis
              </a>{" "}
              &{" "}
              <a
                className="link decoration-text-tertiary"
                href="https://github.com/lumen-notes/lumen/graphs/contributors"
                target="_blank"
                rel="noopener noreferrer"
              >
                friends
              </a>
            </span>
            <a href="https://colebemis.com" target="_blank" rel="noopener noreferrer">
              <Signature width={100} />
            </a>
          </div>
        </div>
      </div>
    </PageLayout>
  )
}

function SettingsSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-3">
      <h3 className="font-bold leading-4">{title}</h3>
      <div className="card-1 p-4">{children}</div>
    </div>
  )
}

function GitHubSection() {
  const navigate = useNavigate()
  const send = useSetAtom(globalStateMachineAtom)
  const githubUser = useAtomValue(githubUserAtom)
  const githubRepo = useAtomValue(githubRepoAtom)
  const isRepoNotCloned = useAtomValue(isRepoNotClonedAtom)
  const isCloningRepo = useAtomValue(isCloningRepoAtom)
  const isRepoCloned = useAtomValue(isRepoClonedAtom)
  const signOut = useSignOut()
  const { online } = useNetworkState()
  const [isEditingRepo, setIsEditingRepo] = useState(false)

  if (!githubUser) {
    return (
      <SettingsSection title="GitHub">
        <div className="text-text-secondary">You're not signed in</div>
      </SettingsSection>
    )
  }

  return (
    <SettingsSection title="GitHub">
      <div className="flex items-center justify-between gap-4">
        <div className="flex w-0 grow flex-col gap-1">
          <span className="text-sm leading-4 text-text-secondary">Account</span>
          <span className="flex items-center gap-2 leading-4">
            {online ? <GitHubAvatar login={githubUser.login} size={16} /> : null}
            <span className="truncate">{githubUser.login}</span>
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
      <div className="mt-4 border-t border-border-secondary pt-4 empty:hidden">
        {isRepoNotCloned || isEditingRepo ? (
          <RepoForm
            onSubmit={() => setIsEditingRepo(false)}
            onCancel={!isRepoNotCloned ? () => setIsEditingRepo(false) : undefined}
          />
        ) : null}
        {isCloningRepo && githubRepo ? (
          <div className="flex items-center gap-2 leading-4 text-text-secondary">
            <LoadingIcon16 />
            Cloning {githubRepo.owner}/{githubRepo.name}…
          </div>
        ) : null}
        {isRepoCloned && !isEditingRepo && githubRepo ? (
          <div className="flex items-center justify-between gap-4">
            <div className="flex w-0 grow flex-col items-start gap-1">
              <span className="text-sm leading-4 text-text-secondary">Repository</span>
              <a
                href={`https://github.com/${githubRepo.owner}/${githubRepo.name}`}
                className="link leading-5"
                target="_blank"
                rel="noopener noreferrer"
              >
                {githubRepo.owner}/{githubRepo.name}
              </a>
            </div>
            <Button className="shrink-0" onClick={() => setIsEditingRepo(true)}>
              Change
            </Button>
          </div>
        ) : null}
      </div>
      {isRepoCloned && !isEditingRepo && githubRepo ? (
        <div className="mt-4 border-t border-border-secondary pt-4">
          <div className="flex items-center justify-between gap-4">
            <div className="flex w-0 grow flex-col gap-1">
              <span className="text-sm leading-4 text-text-secondary">Reset local copy</span>
              <span className="text-sm leading-5 text-text-secondary">
                If sync is stuck, delete the notes stored in this browser and re-clone them from
                GitHub. Unpushed changes are kept as conflicted-copy notes.
              </span>
            </div>
            <Button
              className="shrink-0"
              disabled={!online}
              onClick={() => {
                if (
                  window.confirm(
                    `Reset the local copy of ${githubRepo.owner}/${githubRepo.name}?\n\nThis deletes the notes stored in this browser and re-clones them from GitHub. Any unpushed changes are saved as conflicted-copy notes.`,
                  )
                ) {
                  send({ type: "SELECT_REPO", githubRepo })
                }
              }}
            >
              Reset
            </Button>
          </div>
        </div>
      ) : null}
    </SettingsSection>
  )
}
