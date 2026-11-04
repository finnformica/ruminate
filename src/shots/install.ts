import { GITHUB_USER_STORAGE_KEY } from "../utils/github-session"
import type { ShotsFixtures } from "./fixtures"
import { createMockApi, isMockedPath, type MockApi } from "./mock-api"

/**
 * The browser half of shots mode (docs/screenshots.md). Loaded ONLY by the
 * `shots` Vite mode (scripts/shots-vite-plugin.ts), which puts this module
 * ahead of the app's own entry in index.html, so it runs before any app
 * module reads the session or captures `fetch`. The production build never
 * names it; `src/shots/bundle-guard.test.ts` and the CI build job fail if it
 * reaches the bundle.
 *
 * 1. The auth stub: the fixed user is written as the stored GitHub session,
 *    so the app boots signed in. The token is never sent anywhere real.
 * 2. The API: `fetch` to an app route is answered by the mock API from the
 *    fixtures the dev server serves at `/__shots/fixtures.json`. A route the
 *    mock does not know is logged loudly, here and in the server's terminal.
 * 3. Push: a fixed subscription, so the reminder settings read as this
 *    device's.
 */

/** Marks the mock layer in a bundle: the guard looks for this string. */
const MARKER = "__RUMINATE_SHOTS_MOCK_LAYER__"

declare global {
  interface Window {
    /** Set inline by the plugin: the user, and which fixture set is served. */
    __RUMINATE_SHOTS__?: { user: ShotsFixtures["user"]; kind: ShotsFixtures["kind"] }
  }
}

const config = window.__RUMINATE_SHOTS__
if (!config) throw new Error(`${MARKER}: loaded without its config`)

localStorage.setItem(
  GITHUB_USER_STORAGE_KEY,
  JSON.stringify({ token: "shots-token", ...config.user }),
)

const realFetch = window.fetch.bind(window)
let api: Promise<MockApi> | null = null
const loadApi = (): Promise<MockApi> =>
  (api ??= realFetch("/__shots/fixtures.json")
    .then((response) => response.json() as Promise<ShotsFixtures>)
    .then((fixtures) => createMockApi(fixtures, localDay(new Date()))))

function localDay(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/** Say a gap where the worker taking shots sees it: the console, and the
 * terminal `npm run shots:serve` runs in. */
function reportGap(method: string, url: URL) {
  const line = `UNMOCKED ${method} ${url.pathname}${url.search}`
  console.error(`[shots] ${line}: add it to src/shots/mock-api.ts`)
  void realFetch("/__shots/log", { method: "POST", body: line }).catch(() => {})
}

async function readBody(request: Request): Promise<unknown> {
  if (request.method === "GET" || request.method === "HEAD") return null
  const text = await request.text()
  try {
    return text === "" ? null : JSON.parse(text)
  } catch {
    return text
  }
}

window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const request = new Request(input, init)
  const url = new URL(request.url)
  if (!isMockedPath(url, window.location.origin)) return realFetch(input, init)
  const answer = (await loadApi()).answer(request.method, url, await readBody(request))
  if (answer === null) {
    reportGap(request.method, url)
    return Response.json({ error: "unmocked", path: url.pathname }, { status: 501 })
  }
  return Response.json(answer.body, { status: answer.status })
}

// Push, as a phone that said yes has it. A headless browser has no push
// service, may have no `Notification` or `PushManager`, and its dev service
// worker may never be ready; so the reminder card reads a fixed
// subscription from a fixed registration, and asks for (and shows) this
// device's reminder.
const subscription = {
  endpoint: "https://push.invalid/shots",
  expirationTime: null,
  options: { applicationServerKey: null, userVisibleOnly: true },
  getKey: () => null,
  toJSON: () => ({ endpoint: "https://push.invalid/shots" }),
  unsubscribe: () => Promise.resolve(true),
}
const pushManager = {
  getSubscription: () => Promise.resolve(subscription),
  subscribe: () => Promise.resolve(subscription),
  permissionState: () => Promise.resolve("granted"),
}
const globals = window as unknown as Record<string, unknown>
globals.PushManager ??= function PushManager() {}
globals.Notification ??= Object.assign(function Notification() {}, {
  permission: "granted",
  requestPermission: () => Promise.resolve("granted"),
})
if ("serviceWorker" in navigator) {
  Object.defineProperty(navigator.serviceWorker, "ready", {
    configurable: true,
    get: () => Promise.resolve({ pushManager, scope: `${window.location.origin}/` }),
  })
}

console.info(`[shots] signed in as ${config.user.login}, serving the ${config.kind} fixtures`)
