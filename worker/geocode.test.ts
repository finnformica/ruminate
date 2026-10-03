import { describe, expect, it } from "vitest"
import { reverseGeocode } from "./geocode"

/** A Nominatim that answers as told, and records what it was asked. */
function nominatim(reply: () => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit | undefined }[] = []
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init })
    return reply()
  }) as typeof fetch
  return { fetchImpl, calls }
}

const answer = (address: Record<string, unknown>) =>
  new Response(JSON.stringify({ address }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })

describe("reverseGeocode", () => {
  it("asks Nominatim as its policy wants, and names the town and the country", async () => {
    const { fetchImpl, calls } = nominatim(() =>
      answer({ city: "Ljubljana", country: "Slovenia", country_code: "si" }),
    )
    expect(await reverseGeocode(fetchImpl, { lat: 46.05127, lon: 14.50556 })).toBe(
      "Ljubljana, Slovenia",
    )
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(
      "https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=10&lat=46.05127&lon=14.50556",
    )
    expect(calls[0].init?.headers).toEqual({
      "User-Agent": "Ruminate (https://github.com/finnformica/ruminate)",
      "Accept-Language": "en",
    })
    expect(calls[0].init?.signal).toBeInstanceOf(AbortSignal)
  })

  it("takes the town-sized name Nominatim offers, whichever it is", async () => {
    const at = { lat: 1, lon: 2 }
    for (const [address, expected] of [
      [{ town: "Bled", country: "Slovenia" }, "Bled, Slovenia"],
      [{ village: "Ribčev Laz", country: "Slovenia" }, "Ribčev Laz, Slovenia"],
      [{ municipality: "Bohinj", country: "Slovenia" }, "Bohinj, Slovenia"],
      [{ county: "Cornwall", country: "United Kingdom" }, "Cornwall, United Kingdom"],
      [{ country: "Slovenia" }, "Slovenia"],
      [{ city: "Ljubljana" }, "Ljubljana"],
    ] as const) {
      const { fetchImpl } = nominatim(() => answer(address))
      expect(await reverseGeocode(fetchImpl, at)).toBe(expected)
    }
  })

  it("is nothing on a refusal, a bad body, no address, or a failure", async () => {
    const at = { lat: 1, lon: 2 }
    expect(
      await reverseGeocode(nominatim(() => new Response("", { status: 429 })).fetchImpl, at),
    ).toBeNull()
    expect(
      await reverseGeocode(nominatim(() => new Response("<html>", { status: 200 })).fetchImpl, at),
    ).toBeNull()
    expect(await reverseGeocode(nominatim(() => answer({})).fetchImpl, at)).toBeNull()
    expect(
      await reverseGeocode(nominatim(() => new Response("{}", { status: 200 })).fetchImpl, at),
    ).toBeNull()
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
