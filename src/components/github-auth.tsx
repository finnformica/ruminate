import { useSetAtom } from "jotai"
import urlcat from "urlcat"
import { globalStateMachineAtom } from "../global-state"
import { Button, ButtonProps } from "./button"
import { GitHubIcon16 } from "./icons"

/**
 * Kick off the GitHub OAuth flow (also used to re-authenticate from the sync
 * status when the session has expired). `state` carries the current URL so the
 * worker redirects back here after the token exchange.
 */
export function beginGitHubSignIn() {
  const authUrl = urlcat("https://github.com/login/oauth/authorize", {
    client_id: import.meta.env.VITE_GITHUB_CLIENT_ID,
    state: window.location.href,
    // Identity + gist publishing only — notes live in the database, not a
    // repository, so no repo scope is requested.
    scope: "gist,user:email",
  })

  // Open in new tab if in iframe (GitHub doesn't load inside iframes)
  const isInIframe = window.self !== window.top
  if (isInIframe) {
    window.open(authUrl, "_blank", "noopener")
  } else {
    window.location.href = authUrl
  }
}

export function SignInButton(props: ButtonProps) {
  const send = useSetAtom(globalStateMachineAtom)
  return (
    <Button
      variant="primary"
      {...props}
      onClick={async (event) => {
        // Sign in with a personal access token in local development
        if (import.meta.env.DEV && import.meta.env.VITE_GITHUB_PAT) {
          try {
            const token = import.meta.env.VITE_GITHUB_PAT
            const { login, name, email } = await getUser(token)
            send({ type: "SIGN_IN", githubUser: { token, login, name, email } })
          } catch (error) {
            console.error(error)
          }
          return
        }

        beginGitHubSignIn()
        props.onClick?.(event)
      }}
    >
      <GitHubIcon16 />
      Sign in with GitHub
    </Button>
  )
}

export function useSignOut() {
  const send = useSetAtom(globalStateMachineAtom)

  return () => {
    send({ type: "SIGN_OUT" })
  }
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
