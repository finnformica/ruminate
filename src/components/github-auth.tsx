import { useSetAtom } from "jotai"
import urlcat from "urlcat"
import { signInAtom, signOutAtom } from "../global-state"
import { AsyncButton, type AsyncButtonProps } from "./ui/async-button"
import { GitHubIcon16 } from "./icons"

/**
 * Kick off the GitHub OAuth flow (also used to re-authenticate from the sync
 * status when the session has expired). `state` carries the current URL so the
 * worker redirects back here after the token exchange.
 *
 * Leaving for GitHub takes a moment, and the page is live until it has gone:
 * the promise stays open for that moment, so the control that began it stays
 * busy — and settles if the page comes back (the reader pressing Back into
 * this one, restored as it was), so that control is pressable again. Opened
 * in a new tab, nothing is in flight here, and it settles at once.
 */
export function beginGitHubSignIn(): Promise<void> {
  const authUrl = urlcat("https://github.com/login/oauth/authorize", {
    client_id: import.meta.env.VITE_GITHUB_CLIENT_ID,
    state: window.location.href,
    // The OAuth app registers multiple callback URLs (production + preview
    // hosts); without an explicit redirect_uri GitHub falls back to the FIRST
    // registered one, which would bounce preview sign-ins to production.
    redirect_uri: `${window.location.origin}/github-auth`,
    // Identity only — notes live in the database, not a repository, so no
    // repo scope is requested.
    scope: "user:email",
  })

  // Open in new tab if in iframe (GitHub doesn't load inside iframes)
  const isInIframe = window.self !== window.top
  if (isInIframe) {
    window.open(authUrl, "_blank", "noopener")
    return Promise.resolve()
  }
  window.location.href = authUrl
  return new Promise((resolve) => {
    window.addEventListener("pageshow", () => resolve(), { once: true })
  })
}

/**
 * The "Sign in with GitHub" button, busy from the press until the page has
 * left for GitHub. Its children replace the label.
 */
export function SignInButton({ children, ...props }: Partial<AsyncButtonProps>) {
  const signIn = useSetAtom(signInAtom)
  return (
    <AsyncButton
      variant="primary"
      icon={<GitHubIcon16 />}
      {...props}
      onClick={async (event) => {
        // Sign in with a personal access token in local development
        if (import.meta.env.DEV && import.meta.env.VITE_GITHUB_PAT) {
          try {
            const token = import.meta.env.VITE_GITHUB_PAT
            const { login, name, email } = await getUser(token)
            signIn({ token, login, name, email })
          } catch (error) {
            console.error(error)
          }
          return
        }

        const left = beginGitHubSignIn()
        await props.onClick?.(event)
        await left
      }}
    >
      {children ?? "Sign in with GitHub"}
    </AsyncButton>
  )
}

export function useSignOut() {
  return useSetAtom(signOutAtom)
}

async function getUser(token: string) {
  const userResponse = await fetch("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  })

  if (userResponse.status === 401) {
    throw new Error("Invalid token")
  }

  if (!userResponse.ok) {
    throw new Error("Unknown error")
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { login, name } = (await userResponse.json()) as any

  const emailResponse = await fetch("https://api.github.com/user/emails", {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  })

  if (emailResponse.status === 401) {
    throw new Error("Invalid token")
  }

  if (!emailResponse.ok) {
    throw new Error("Error getting user's emails")
  }

  const emails = (await emailResponse.json()) as Array<{ email: string; primary: boolean }>
  const primaryEmail = emails.find((email) => email.primary)

  if (!primaryEmail) {
    throw new Error("No primary email found")
  }

  return { login, name, email: primaryEmail.email }
}
