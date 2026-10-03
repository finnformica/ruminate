import { rounded, type Coordinates } from "./exif-location"

/**
 * Where the device is, for a photo taken with the Camera button
 * (docs/boards.md, "Tagging with Claude"): the browser's geolocation,
 * asked once, with the browser's own permission prompt and no copy of
 * ours. Never rejects and never waits long: no API, an insecure context,
 * a refusal, or a timeout are all null, silently, and the upload it runs
 * beside is never held for it.
 */
export function devicePosition(): Promise<Coordinates | null> {
  if (typeof navigator === "undefined" || !navigator.geolocation) return Promise.resolve(null)
  if (typeof window !== "undefined" && window.isSecureContext === false) {
    return Promise.resolve(null)
  }
  return new Promise((resolve) => {
    try {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          const { latitude, longitude } = position.coords
          if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) resolve(null)
          else resolve({ lat: rounded(latitude), lon: rounded(longitude) })
        },
        () => resolve(null),
        { enableHighAccuracy: false, timeout: 8000, maximumAge: 60000 },
      )
    } catch {
      resolve(null)
    }
  })
}
