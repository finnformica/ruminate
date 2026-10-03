/**
 * Where a photo was taken, from its own metadata (docs/boards.md, "Tagging
 * with Claude"): the GPS block of a JPEG's EXIF, read by hand — a few
 * tags, no dependency. Anything that is not a JPEG, carries no EXIF, no
 * GPS block, or is cut short or garbled, reads as nothing. Only the first
 * `EXIF_READ_BYTES` of the file are looked at: the EXIF segment is at the
 * head of a JPEG, before the picture itself.
 *
 * The walk: `FFD8`, then segment by segment to APP1 `Exif\0\0`; a TIFF
 * header there says the byte order; IFD0's entries are searched for the
 * GPSInfo pointer (0x8825); that IFD's tags 1–4 are the latitude's
 * hemisphere and degrees/minutes/seconds, and the longitude's. Every read
 * is bounds-checked, so a truncated file is a null, not a throw.
 */

export interface Coordinates {
  lat: number
  lon: number
}

/** How much of the file is read: EXIF lives in the first segments. */
export const EXIF_READ_BYTES = 256 * 1024

const JPEG_MIME = "image/jpeg"
const GPS_INFO_TAG = 0x8825
const RATIONAL = 5
const PLACES = 5

/** `value` to five decimal places — about a metre. */
export const rounded = (value: number): number => Number(value.toFixed(PLACES))

/** The coordinates in `bytes`, a JPEG's head, or null. */
export function exifLocation(bytes: ArrayBuffer): Coordinates | null {
  try {
    return readLocation(new DataView(bytes))
  } catch {
    // A read past the end: a file cut short, or one that is not what it
    // claims. Nothing, rather than a throw.
    return null
  }
}

function readLocation(view: DataView): Coordinates | null {
  if (view.byteLength < 4 || view.getUint16(0) !== 0xffd8) return null
  let offset = 2
  while (offset + 4 <= view.byteLength) {
    if (view.getUint8(offset) !== 0xff) return null
    const marker = view.getUint8(offset + 1)
    // Markers with no segment behind them.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2
      continue
    }
    // The picture itself, or the end: EXIF would have come before.
    if (marker === 0xda || marker === 0xd9) return null
    const length = view.getUint16(offset + 2)
    if (length < 2) return null
    if (marker === 0xe1 && isExif(view, offset + 4)) {
      return readTiff(view, offset + 10, offset + 2 + length)
    }
    offset += 2 + length
  }
  return null
}

/** Whether the bytes at `at` spell `Exif\0\0`. */
function isExif(view: DataView, at: number): boolean {
  if (at + 6 > view.byteLength) return false
  const letters = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00]
  return letters.every((letter, index) => view.getUint8(at + index) === letter)
}

/** The TIFF block at `tiff`: byte order, IFD0, the GPS IFD it points to. */
function readTiff(view: DataView, tiff: number, end: number): Coordinates | null {
  const order = view.getUint16(tiff)
  const little = order === 0x4949
  if (!little && order !== 0x4d4d) return null
  const u16 = (at: number) => view.getUint16(at, little)
  const u32 = (at: number) => view.getUint32(at, little)
  if (u16(tiff + 2) !== 0x2a) return null
  const ifd0 = tiff + u32(tiff + 4)
  const gpsPointer = findEntry(ifd0)
  if (gpsPointer === null) return null
  const gps = tiff + gpsPointer
  const entries = u16(gps)
  let latRef: string | null = null
  let lonRef: string | null = null
  let lat: number | null = null
  let lon: number | null = null
  for (let index = 0; index < entries; index++) {
    const entry = gps + 2 + index * 12
    if (entry + 12 > end) return null
    const tag = u16(entry)
    const type = u16(entry + 2)
    const count = u32(entry + 4)
    if (tag === 1 || tag === 3) {
      // ASCII, two bytes: the letter and its terminator, in the value itself.
      const letter = String.fromCharCode(view.getUint8(entry + 8))
      if (tag === 1) latRef = letter
      else lonRef = letter
    } else if ((tag === 2 || tag === 4) && type === RATIONAL && count === 3) {
      const at = tiff + u32(entry + 8)
      const parts = [0, 1, 2].map((part) => {
        const numerator = u32(at + part * 8)
        const denominator = u32(at + part * 8 + 4)
        return denominator === 0 ? 0 : numerator / denominator
      })
      const degrees = parts[0] + parts[1] / 60 + parts[2] / 3600
      if (tag === 2) lat = degrees
      else lon = degrees
    }
  }
  if (latRef === null || lonRef === null || lat === null || lon === null) return null
  const signedLat = latRef === "S" ? -lat : latRef === "N" ? lat : null
  const signedLon = lonRef === "W" ? -lon : lonRef === "E" ? lon : null
  if (signedLat === null || signedLon === null) return null
  if (!Number.isFinite(signedLat) || !Number.isFinite(signedLon)) return null
  if (Math.abs(signedLat) > 90 || Math.abs(signedLon) > 180) return null
  return { lat: rounded(signedLat), lon: rounded(signedLon) }

  /** The GPSInfo pointer among IFD0's entries, as an offset from `tiff`. */
  function findEntry(ifd: number): number | null {
    const count = u16(ifd)
    for (let index = 0; index < count; index++) {
      const entry = ifd + 2 + index * 12
      if (entry + 12 > end) return null
      if (u16(entry) === GPS_INFO_TAG) return u32(entry + 8)
    }
    return null
  }
}

/**
 * Where `file` was taken, from its EXIF, or null: a JPEG only, read from
 * its first `EXIF_READ_BYTES`. Read from the ORIGINAL file, before it is
 * fitted for upload — the fitter keeps only the pixels.
 */
export async function readExifLocation(file: Blob): Promise<Coordinates | null> {
  if (file.type.split(";")[0].trim().toLowerCase() !== JPEG_MIME) return null
  try {
    return exifLocation(await file.slice(0, EXIF_READ_BYTES).arrayBuffer())
  } catch {
    return null
  }
}
