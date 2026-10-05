import { describe, expect, it } from "vitest"
import { EXIF_READ_BYTES, exifLocation, readExifLocation } from "./exif-location"

/**
 * A minimal JPEG by hand: `FFD8`, an APP1 segment holding a TIFF block
 * whose IFD0 points at a GPS IFD with the four tags the reader wants, then
 * `FFD9`. Built in either byte order, so both branches are walked.
 */
function jpegWithGps(options: {
  latRef: "N" | "S"
  lat: [number, number, number]
  lonRef: "E" | "W"
  lon: [number, number, number]
  little?: boolean
  /** A segment before APP1, as a camera writes (JFIF, say). */
  leading?: boolean
}): Uint8Array {
  const little = options.little ?? false
  const tiff: number[] = []
  const u16 = (value: number) =>
    little ? [value & 0xff, (value >> 8) & 0xff] : [(value >> 8) & 0xff, value & 0xff]
  const u32 = (value: number) =>
    little
      ? [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >>> 24) & 0xff]
      : [(value >>> 24) & 0xff, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff]
  // Header: order, 42, offset of IFD0 (8).
  tiff.push(...(little ? [0x49, 0x49] : [0x4d, 0x4d]), ...u16(0x2a), ...u32(8))
  // IFD0 at 8: one entry, the GPSInfo pointer, then no next IFD.
  const gpsIfd = 8 + 2 + 12 + 4
  tiff.push(...u16(1), ...u16(0x8825), ...u16(4), ...u32(1), ...u32(gpsIfd), ...u32(0))
  // GPS IFD: four entries; the rationals follow it.
  const rationals = gpsIfd + 2 + 4 * 12 + 4
  const ascii = (letter: string) => [letter.charCodeAt(0), 0, 0, 0]
  tiff.push(...u16(4))
  tiff.push(...u16(1), ...u16(2), ...u32(2), ...ascii(options.latRef))
  tiff.push(...u16(2), ...u16(5), ...u32(3), ...u32(rationals))
  tiff.push(...u16(3), ...u16(2), ...u32(2), ...ascii(options.lonRef))
  tiff.push(...u16(4), ...u16(5), ...u32(3), ...u32(rationals + 24))
  tiff.push(...u32(0))
  // Degrees and minutes whole; seconds to a hundredth.
  for (const value of [...options.lat, ...options.lon]) {
    tiff.push(...u32(Math.round(value * 100)), ...u32(100))
  }
  const app1 = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00, ...tiff]
  const length = app1.length + 2
  const bytes = [0xff, 0xd8]
  if (options.leading) bytes.push(0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46)
  bytes.push(0xff, 0xe1, (length >> 8) & 0xff, length & 0xff, ...app1, 0xff, 0xd9)
  return new Uint8Array(bytes)
}

const buffer = (bytes: Uint8Array) =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer

describe("exifLocation", () => {
  it("reads a north-east position, big-endian", () => {
    const jpeg = jpegWithGps({ latRef: "N", lat: [46, 3, 4.56], lonRef: "E", lon: [14, 30, 20] })
    expect(exifLocation(buffer(jpeg))).toEqual({ lat: 46.05127, lon: 14.50556 })
  })

  it("reads a south-west position, little-endian, behind another segment", () => {
    const jpeg = jpegWithGps({
      latRef: "S",
      lat: [33, 51, 54],
      lonRef: "W",
      lon: [151, 12, 36],
      little: true,
      leading: true,
    })
    expect(exifLocation(buffer(jpeg))).toEqual({ lat: -33.865, lon: -151.21 })
  })

  it("is nothing for a file that is not a JPEG, has no EXIF, or no GPS", () => {
    expect(exifLocation(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]).buffer)).toBeNull()
    expect(exifLocation(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]).buffer)).toBeNull()
    // An APP1 that is not EXIF (XMP, say).
    expect(
      exifLocation(
        new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x06, 0x68, 0x74, 0x74, 0x70]).buffer,
      ),
    ).toBeNull()
    expect(exifLocation(new ArrayBuffer(0))).toBeNull()
  })

  it("is nothing for a file cut short or garbled, never a throw", () => {
    const jpeg = jpegWithGps({ latRef: "N", lat: [46, 3, 4], lonRef: "E", lon: [14, 30, 20] })
    for (const length of [3, 6, 12, 30, 60, jpeg.length - 20]) {
      expect(exifLocation(buffer(jpeg.slice(0, length)))).toBeNull()
    }
    const garbled = jpeg.slice()
    garbled[12] = 0x00 // the byte order
    expect(exifLocation(buffer(garbled))).toBeNull()
    const noise = new Uint8Array(400)
    noise[0] = 0xff
    noise[1] = 0xd8
    for (let i = 2; i < noise.length; i++) noise[i] = (i * 73) & 0xff
    expect(exifLocation(buffer(noise))).toBeNull()
  })

  it("refuses a position off the globe", () => {
    const jpeg = jpegWithGps({ latRef: "N", lat: [91, 0, 0], lonRef: "E", lon: [14, 0, 0] })
    expect(exifLocation(buffer(jpeg))).toBeNull()
  })
})

describe("readExifLocation", () => {
  it("reads a JPEG file's head, and nothing of another type", async () => {
    const jpeg = jpegWithGps({ latRef: "N", lat: [46, 3, 4.56], lonRef: "E", lon: [14, 30, 20] })
    expect(await readExifLocation(new Blob([buffer(jpeg)], { type: "image/jpeg" }))).toEqual({
      lat: 46.05127,
      lon: 14.50556,
    })
    expect(await readExifLocation(new Blob([buffer(jpeg)], { type: "image/png" }))).toBeNull()
    expect(await readExifLocation(new Blob([buffer(jpeg)], { type: "image/heic" }))).toBeNull()
  })

  it("looks at the first quarter megabyte only", async () => {
    const jpeg = jpegWithGps({ latRef: "N", lat: [1, 0, 0], lonRef: "E", lon: [1, 0, 0] })
    const padded = new Uint8Array(EXIF_READ_BYTES + jpeg.length)
    padded[0] = 0xff
    padded[1] = 0xd8
    // A huge first segment, then the EXIF too far in to be read.
    padded[2] = 0xff
    padded[3] = 0xe0
    const length = EXIF_READ_BYTES - 2
    padded[4] = (length >> 8) & 0xff
    padded[5] = length & 0xff
    padded.set(jpeg.slice(2), EXIF_READ_BYTES)
    expect(await readExifLocation(new Blob([padded], { type: "image/jpeg" }))).toBeNull()
  })
})
