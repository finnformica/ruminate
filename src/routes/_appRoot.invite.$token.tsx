import { createFileRoute, Link } from "@tanstack/react-router"
import { useAtomValue } from "jotai"
import { beginGitHubSignIn } from "../components/github-auth"
import { GitHubIcon16, NoteIcon16 } from "../components/icons"
import { PageLayout } from "../components/page-layout"
import { SettingsSection } from "../components/settings-section"
import { Button } from "../components/button"
import { githubUserAtom } from "../global-state"
import type { InviteOutcome } from "../../worker/admin-wire"

/**
 * The invite page — where an invite link lands (`/invite/<token>`).
 *
 * The page does not redeem anything itself. Its one button starts the
 * ordinary GitHub sign-in with THIS URL as the return address, so the token
 * reaches the Worker's sign-in callback in the OAuth `state`; the callback
 * redeems it in the one place a `users` row can be written, then sends the
 * browser back here with `?invite=` saying how it went
 * (worker/handlers/github-auth.ts). Already signed in, the button still goes
 * through GitHub — a re-authorization that returns at once — because only
 * the callback redeems.
 */
export const Route = createFileRoute("/_appRoot/invite/$token")({
  component: RouteComponent,
  validateSearch: (search: Record<string, unknown>): { invite?: InviteOutcome } => {
    const invite = search.invite
    return invite === "accepted" || invite === "member" || invite === "invalid" ? { invite } : {}
  },
  head: () => ({
    meta: [{ title: "Invite · Ruminate" }],
  }),
})

function RouteComponent() {
  const { invite } = Route.useSearch()
  const githubUser = useAtomValue(githubUserAtom)

  return (
    <PageLayout title="Invite" icon={<NoteIcon16 />} disableGuard>
      <div className="p-4 pb-6">
        <div className="mx-auto flex max-w-xl flex-col gap-6">
          <SettingsSection title="You've been invited to Ruminate">
            {invite === "accepted" ? (
              <>
                <p className="leading-5">
                  You&rsquo;re in{githubUser ? `, ${githubUser.login}` : ""}. Your notes live in a
                  private database of your own and sync across your devices.
                </p>
                <Link to="/" search={{ query: undefined }} className="self-start">
                  <Button variant="primary">Start writing</Button>
                </Link>
              </>
            ) : invite === "member" ? (
              <>
                <p className="leading-5">
                  You already have access{githubUser ? `, ${githubUser.login}` : ""} — this link
                  wasn&rsquo;t needed, and it is still unused.
                </p>
                <Link to="/" search={{ query: undefined }} className="self-start">
                  <Button variant="primary">Open your notes</Button>
                </Link>
              </>
            ) : invite === "invalid" ? (
              <p className="leading-5">
                This invite link has already been used, has expired, or was revoked. Ask whoever
                sent it for a new one.
              </p>
            ) : (
              <>
                <p className="leading-5 text-text-secondary">
                  Ruminate is a note-taking app. Sign in with GitHub through this link and
                  you&rsquo;ll have a private notes database of your own — GitHub is used for
                  identity only; your notes never touch a repository.
                </p>
                <Button
                  variant="primary"
                  className="self-start"
                  onClick={() => beginGitHubSignIn()}
                >
                  <GitHubIcon16 />
                  Sign in with GitHub to join
                </Button>
              </>
            )}
          </SettingsSection>
        </div>
      </div>
    </PageLayout>
  )
}
