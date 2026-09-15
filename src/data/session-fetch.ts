import { ensureFreshToken, getAccessToken, withAuthRetry } from "../utils/github-session"

/**
 * A fetch carrying the session: the bearer token and the same-origin
 * cookie, the token refreshed first if it is near expiry, and the request
 * retried once through a refresh on a 401. What the app's own API routes
 * (`/api/images`, `/api/unfurl`) are called with. `signedOut` makes the
 * error thrown when there is no session to carry — each caller says it in
 * its own words.
 */
export async function sessionFetch(
  input: string,
  init: RequestInit,
  signedOut: () => Error,
): Promise<Response> {
  await ensureFreshToken()
  if (!getAccessToken()) throw signedOut()
  return withAuthRetry(async () => {
    const token = getAccessToken()
    if (!token) throw signedOut()
    const response = await fetch(input, {
      ...init,
      credentials: "same-origin",
      headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` },
    })
    if (response.status === 401) {
      throw Object.assign(new Error("Request rejected (401)"), { status: 401 })
    }
    return response
  })
}
