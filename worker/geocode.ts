// A place for a pair of coordinates — the chain of names from the most
// specific out to the country — from OpenStreetMap's Nominatim, for the
// Location hint the tagging prompt carries (docs/boards.md, "Tagging with
// Claude"). The model is given the whole chain and asked to name the place
// as a person would: a town and a country are not always what a person
// says ("Ljubljana airport", "Slovenia"), and which it is depends on what
// the chain holds.
//
// One call per tag, through the `fetch` the handler was given (so a test
// stubs it), named as Nominatim's usage policy asks and in English, and
// held to three seconds: a place is a hint, and a slow or failed lookup is
// no reason to fail the tag. Anything but a clean answer with a name in it
// is null.

import type { Coordinates } from "../src/data/exif-location"

const NOMINATIM = "https://nominatim.openstreetmap.org/reverse"
const USER_AGENT = "Ruminate (https://github.com/finnformica/ruminate)"
const GEOCODE_TIMEOUT_MS = 3000
/** How much of the chain goes to the model. */
const MAX_PLACE_LENGTH = 160

/** A part of the chain that is a postcode or a house number — "4210",
 * "SI-4210", "12b" — which names nothing to a person. */
const isCode = (part: string): boolean => /^[A-Za-z]{0,3}[-\s]?\d[\d\s-]*[A-Za-z]?$/.test(part)

/**
 * The chain of names Nominatim's `display_name` gives for a place, most
 * specific first — "Ljubljana Jože Pučnik Airport; Zgornji Brnik; Cerklje
 * na Gorenjskem; Upper Carniola; Slovenia" — with postcodes and house
 * numbers dropped, each name once, joined with "; " and cut to length.
 * Null when there is nothing left.
 */
export function placeChain(displayName: string): string | null {
  const seen = new Set<string>()
  const parts: string[] = []
  for (const raw of displayName.split(", ")) {
    const part = raw.trim()
    if (part === "" || isCode(part)) continue
    const key = part.toLocaleLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    parts.push(part)
  }
  if (parts.length === 0) return null
  const chain = parts.join("; ")
  return chain.length > MAX_PLACE_LENGTH ? chain.slice(0, MAX_PLACE_LENGTH).trimEnd() : chain
}

export async function reverseGeocode(
  fetchImpl: typeof fetch,
  { lat, lon }: Coordinates,
  timeoutMs: number = GEOCODE_TIMEOUT_MS,
): Promise<string | null> {
  const url = `${NOMINATIM}?format=jsonv2&zoom=18&lat=${lat}&lon=${lon}`
  try {
    const response = await fetchImpl(url, {
      headers: { "User-Agent": USER_AGENT, "Accept-Language": "en" },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) return null
    const body = (await response.json()) as { display_name?: unknown } | null
    return typeof body?.display_name === "string" ? placeChain(body.display_name) : null
  } catch {
    return null
  }
}
