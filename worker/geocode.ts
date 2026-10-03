// A place name for a pair of coordinates — the town and the country —
// from OpenStreetMap's Nominatim, for the Location hint the tagging
// prompt carries (docs/boards.md, "Tagging with Claude").
//
// One call per tag, through the `fetch` the handler was given (so a test
// stubs it), named as Nominatim's usage policy asks and in English, and
// held to three seconds: a place name is a hint, and a slow or failed
// lookup is no reason to fail the tag. Anything but a clean answer with
// an address in it is null.

import type { Coordinates } from "../src/data/exif-location"

const NOMINATIM = "https://nominatim.openstreetmap.org/reverse"
const USER_AGENT = "Ruminate (https://github.com/finnformica/ruminate)"
const GEOCODE_TIMEOUT_MS = 3000

/** The town-sized part of a Nominatim address, whichever it offers. */
const TOWN_KEYS = ["city", "town", "village", "municipality", "county"] as const

export async function reverseGeocode(
  fetchImpl: typeof fetch,
  { lat, lon }: Coordinates,
  timeoutMs: number = GEOCODE_TIMEOUT_MS,
): Promise<string | null> {
  const url = `${NOMINATIM}?format=jsonv2&zoom=10&lat=${lat}&lon=${lon}`
  try {
    const response = await fetchImpl(url, {
      headers: { "User-Agent": USER_AGENT, "Accept-Language": "en" },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) return null
    const body = (await response.json()) as { address?: Record<string, unknown> } | null
    const address = body?.address
    if (typeof address !== "object" || address === null) return null
    const town = TOWN_KEYS.map((key) => address[key]).find(
      (value): value is string => typeof value === "string" && value.trim() !== "",
    )
    const country = typeof address.country === "string" ? address.country.trim() : ""
    const parts = [town?.trim(), country].filter((part): part is string => Boolean(part))
    return parts.length ? parts.join(", ") : null
  } catch {
    return null
  }
}
