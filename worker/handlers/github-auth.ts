// GitHub OAuth callback: exchanges the `code` for an access token using the
// client secret (held as a Worker secret), then redirects back to the app with
// the token and user info in the query string.
// Reference: https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps

import { refreshCookie } from "../github-cookie"
import type { Env } from "../types"

export async function githubAuth(request: Request, env: Env): Promise<Response> {
  try {
    const url = new URL(request.url)
    const code = url.searchParams.get("code")
    const state = url.searchParams.get("state")

    const response = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        client_id: env.VITE_GITHUB_CLIENT_ID,
        client_secret: env.GITHUB_CLIENT_SECRET,
        code,
      }),
    })

    const {
      error,
      access_token: token,
      refresh_token: refreshToken,
      expires_in: expiresIn,
      refresh_token_expires_in: refreshExpiresIn,
    } = (await response.json()) as {
      error?: string
      access_token?: string
      refresh_token?: string
      expires_in?: number
      refresh_token_expires_in?: number
    }

    if (error || !token) {
      throw new Error(error || "No access token returned")
    }

    const { id, login, name, email } = await getUser(token)

    // `state` is the app URL to return to (set by the sign-in button).
    const redirectUrl = new URL(state || url.origin)
    redirectUrl.searchParams.set("user_token", token)
    if (typeof id === "number" && Number.isFinite(id)) {
      redirectUrl.searchParams.set("user_id", String(id))
    }
    redirectUrl.searchParams.set("user_login", login)
    redirectUrl.searchParams.set("user_name", name)
    redirectUrl.searchParams.set("user_email", email)
    // Pass the (non-sensitive) expiry timestamps so the client can drive silent
    // refresh and the session-status UI. Absent when the OAuth app has token
    // expiration disabled — the client then treats the token as non-expiring.
    if (typeof expiresIn === "number") {
      redirectUrl.searchParams.set("access_expires", String(Date.now() + expiresIn * 1000))
    }
    if (typeof refreshExpiresIn === "number") {
      redirectUrl.searchParams.set("refresh_expires", String(Date.now() + refreshExpiresIn * 1000))
    }

    // The refresh token is the long-lived, sensitive credential: keep it out of
    // JS entirely by storing it in an HttpOnly cookie. `/github-refresh` reads it
    // to mint fresh access tokens. SameSite=Lax blocks cross-site use (CSRF).
    const headers = new Headers({ Location: redirectUrl.toString() })
    if (refreshToken) {
      headers.append("Set-Cookie", refreshCookie(refreshToken, refreshExpiresIn))
    }
    return new Response(null, { status: 302, headers })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error"
    return new Response(`Error: ${message}`, { status: 500 })
  }
}

async function getUser(token: string) {
  const userResponse = await fetch("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": "ruminate",
    },
  })

  const { error, id, login, name } = (await userResponse.json()) as {
    error?: string
    id?: number
    login: string
    name: string | null
  }

  if (error) {
    throw new Error(error)
  }

  const emailResponse = await fetch("https://api.github.com/user/emails", {
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": "ruminate",
    },
  })

  if (emailResponse.status === 401) {
    throw new Error("Invalid token")
  }

  if (!emailResponse.ok) {
    throw new Error("Error getting user's emails")
  }

  const emails = (await emailResponse.json()) as Array<{
    email: string
    primary: boolean
    visibility: string
  }>
  const primaryEmail = emails.find((email) => email.visibility !== "private")

  if (!primaryEmail) {
    throw new Error(
      "No public email found. Check your email settings in https://github.com/settings/emails",
    )
  }

  return { id, login, name: resolveDisplayName(name, login), email: primaryEmail.email }
}

/**
 * GitHub's `name` is null when the user never set a display name. Without this
 * fallback the null would round-trip through the redirect query string as the
 * literal string "null" and end up as the git `user.name`.
 */
export function resolveDisplayName(name: string | null | undefined, login: string): string {
  const trimmed = typeof name === "string" ? name.trim() : ""
  return trimmed && trimmed !== "null" ? trimmed : login
}
