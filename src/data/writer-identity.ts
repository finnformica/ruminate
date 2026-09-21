// Who is writing, as far as the replica's event log needs to know
// (docs/event-sourcing.md): which device and tab, running which build.
//
// Neither is identity — the Worker takes that from the verified session and
// nothing else. These are the two facts the incident of 2026-09-19 could not
// recover afterwards: whether one tab or two were pushing, and what code they
// were running. They ride as headers, so a push's BODY stays the rows it
// always was and an older Worker ignores them.

const DEVICE_KEY = "ruminate.device"
const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz"

function mint(length: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length))
  let out = ""
  for (const byte of bytes) out += ALPHABET[byte % ALPHABET.length]
  return out
}

/** This page load. Two tabs on one device share a device id and differ here. */
const TAB = mint(6)

/** The device's id, minted once per browser profile. Storage can be absent
 * or refuse (private windows, blocked site data): the tab id still says
 * something, so that is what is left. */
function deviceId(): string {
  try {
    const held = localStorage.getItem(DEVICE_KEY)
    if (held !== null && /^[0-9a-z]{8}$/.test(held)) return held
    const minted = mint(8)
    localStorage.setItem(DEVICE_KEY, minted)
    return minted
  } catch {
    return "nostore"
  }
}

export const WRITER_DEVICE_HEADER = "X-Ruminate-Device"
export const WRITER_BUILD_HEADER = "X-Ruminate-Build"

/** Spread into the headers of every request that writes. */
export function writerHeaders(): Record<string, string> {
  return {
    [WRITER_DEVICE_HEADER]: `${deviceId()}.${TAB}`,
    // The changelog version is the app's build identity (vite.config.ts): it
    // changes with every change a user could see.
    [WRITER_BUILD_HEADER]:
      typeof __CHANGELOG_VERSION__ === "string" ? __CHANGELOG_VERSION__ : "dev",
  }
}
