/// <reference lib="webworker" />
import {
  cleanupOutdatedCaches,
  createHandlerBoundToURL,
  precacheAndRoute,
} from "workbox-precaching"
import { NavigationRoute, registerRoute } from "workbox-routing"

/**
 * The service worker (vite-plugin-pwa `injectManifest`, vite.config.ts).
 *
 * The first half is what the generated worker did before: precache the
 * build (the manifest the plugin injects at `self.__WB_MANIFEST`), drop the
 * caches of older builds, serve `index.html` for every navigation but the
 * auth routes, and wait. With registerType "prompt" a new worker stays
 * waiting until "Update Ruminate" posts SKIP_WAITING
 * (src/hooks/app-update.ts); nothing here skips on its own.
 *
 * The second half is habit reminders (docs/reminders.md): show the push the
 * Worker's cron sends (worker/reminders/cron.ts), and on a tap focus the app
 * and open the tracker the reminder names.
 */

declare const self: ServiceWorkerGlobalScope & { __WB_MANIFEST: (string | { url: string })[] }

precacheAndRoute(self.__WB_MANIFEST, { ignoreURLParametersMatching: [/^utm_/, /^fbclid$/] })
cleanupOutdatedCaches()
registerRoute(
  new NavigationRoute(createHandlerBoundToURL("index.html"), {
    denylist: [/cors-proxy/, /file-proxy/, /git-lfs-file/, /github-auth/],
  }),
)

self.addEventListener("message", (event) => {
  if ((event.data as { type?: string } | null)?.type === "SKIP_WAITING") void self.skipWaiting()
})

/** The payload worker/reminders/message.ts writes. */
interface ReminderPayload {
  title?: string
  body?: string
  url?: string
  tag?: string
}

self.addEventListener("push", (event) => {
  let payload: ReminderPayload = {}
  try {
    payload = (event.data?.json() ?? {}) as ReminderPayload
  } catch {
    payload = { body: event.data?.text() }
  }
  event.waitUntil(
    self.registration.showNotification(payload.title ?? "Ruminate", {
      body: payload.body ?? "",
      tag: payload.tag,
      icon: "/icon-1024.png",
      data: { url: payload.url ?? "/" },
    }),
  )
})

self.addEventListener("notificationclick", (event) => {
  event.notification.close()
  const path = (event.notification.data as { url?: string } | null)?.url ?? "/"
  const url = new URL(path, self.location.origin).href
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true })
      const open = windows.find((client) => new URL(client.url).origin === self.location.origin)
      if (open) {
        const focused = await open.focus()
        // `navigate` works only on a window this worker controls; else open one.
        if (focused.url !== url) {
          const moved = await focused.navigate(url).catch(() => null)
          if (moved === null) await self.clients.openWindow(url)
        }
        return
      }
      await self.clients.openWindow(url)
    })(),
  )
})
