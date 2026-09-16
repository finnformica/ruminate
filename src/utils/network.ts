/**
 * True only when the browser says it is definitely offline.
 *
 * `navigator.onLine` is asymmetric: `false` means there is no network at all
 * (no LAN, no router, or Firefox's "Work Offline"), while `true` only means
 * "not known to be offline" — a captive portal or a dead upstream still
 * reads as online. So it is safe to skip network work on `false`, and never
 * safe to assume a request will succeed on `true`. Outside a browser (node
 * tests) there is no such flag, and nothing is skipped.
 */
export function isBrowserOffline(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine === false
}
