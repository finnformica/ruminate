import { describe, expect, it } from "vitest"
import { placeChain, reverseGeocode } from "./geocode"

/** A Nominatim that answers as told, and records what it was asked. */
function nominatim(reply: () => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit | undefined }[] = []
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init })
    return reply()
  }) as typeof fetch
  return { fetchImpl, calls }
}

const answer = (display_name: string) =>
  new Response(JSON.stringify({ display_name, address: {} }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })

const AIRPORT =
  "Ljubljana Jože Pučnik Airport, Zgornji Brnik, Cerklje na Gorenjskem, Upper Carniola, 4210, Slovenia"

describe("placeChain", () => {
  it("is the names most specific first, with the postcode and house number dropped", () => {
    expect(placeChain(AIRPORT)).toBe(
      "Ljubljana Jože Pučnik Airport; Zgornji Brnik; Cerklje na Gorenjskem; Upper Carniola; Slovenia",
    )
    expect(
      placeChain("12b, Trubarjeva cesta, Center, Ljubljana, Upper Carniola, SI-1000, Slovenia"),
    ).toBe("Trubarjeva cesta; Center; Ljubljana; Upper Carniola; Slovenia")
    expect(placeChain("221B, Baker Street, London, NW1 6XE, United Kingdom")).toBe(
      "Baker Street; London; NW1 6XE; United Kingdom",
    )
  })

  it("names a place once, cuts a long chain, and is nothing for nothing", () => {
    expect(placeChain("Bled, Bled, Upper Carniola, Slovenia")).toBe(
      "Bled; Upper Carniola; Slovenia",
    )
    const long = Array.from({ length: 30 }, (_, i) => `Place number ${i}`).join(", ")
    const chain = placeChain(long) as string
    expect(chain.length).toBeLessThanOrEqual(160)
    expect(chain.startsWith("Place number 0; Place number 1")).toBe(true)
    expect(placeChain("")).toBeNull()
    expect(placeChain("4210, SI-4210")).toBeNull()
  })
})

describe("reverseGeocode", () => {
  it("asks Nominatim as its policy wants, at the finest zoom, and gives the chain", async () => {
    const { fetchImpl, calls } = nominatim(() => answer(AIRPORT))
    expect(await reverseGeocode(fetchImpl, { lat: 46.22371, lon: 14.45776 })).toBe(
      "Ljubljana Jože Pučnik Airport; Zgornji Brnik; Cerklje na Gorenjskem; Upper Carniola; Slovenia",
    )
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(
      "https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&lat=46.22371&lon=14.45776",
    )
    expect(calls[0].init?.headers).toEqual({
      "User-Agent": "Ruminate (https://github.com/finnformica/ruminate)",
      "Accept-Language": "en",
    })
    expect(calls[0].init?.signal).toBeInstanceOf(AbortSignal)
  })

  it("is nothing on a refusal, a bad body, no name, or a failure", async () => {
    const at = { lat: 1, lon: 2 }
    expect(
      await reverseGeocode(nominatim(() => new Response("", { status: 429 })).fetchImpl, at),
    ).toBeNull()
    expect(
      await reverseGeocode(nominatim(() => new Response("<html>", { status: 200 })).fetchImpl, at),
    ).toBeNull()
    expect(
      await reverseGeocode(nominatim(() => new Response("{}", { status: 200 })).fetchImpl, at),
    ).toBeNull()
    expect(await reverseGeocode(nominatim(() => answer("4210")).fetchImpl, at)).toBeNull()
    const failing = (async () => {
      throw new TypeError("Failed to fetch")
    }) as unknown as typeof fetch
    expect(await reverseGeocode(failing, at)).toBeNull()
  })

  it("gives up after its timeout", async () => {
    // A Nominatim that answers only when told to stop.
    const slow = ((_: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason))
      })) as typeof fetch
    const started = Date.now()
    expect(await reverseGeocode(slow, { lat: 1, lon: 2 }, 50)).toBeNull()
    expect(Date.now() - started).toBeLessThan(2000)
  })
})
