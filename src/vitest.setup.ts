/**
 * Vitest setup: repair `localStorage`.
 *
 * Node >= 22 ships an experimental `localStorage` global that is
 * non-functional unless `--localstorage-file` is passed, and in the jsdom
 * environment it shadows jsdom's real implementation (vitest's populateGlobal
 * keeps the pre-existing Node global). Replace it with a small in-memory
 * Storage so code under test and tests alike can use localStorage normally.
 */

class MemoryStorage implements Storage {
  private map = new Map<string, string>()

  get length() {
    return this.map.size
  }

  clear() {
    this.map.clear()
  }

  getItem(key: string) {
    return this.map.has(key) ? this.map.get(key)! : null
  }

  key(index: number) {
    return [...this.map.keys()][index] ?? null
  }

  removeItem(key: string) {
    this.map.delete(key)
  }

  setItem(key: string, value: string) {
    this.map.set(String(key), String(value))
  }
}

function isBrokenStorage(): boolean {
  try {
    const storage = (globalThis as { localStorage?: Storage }).localStorage
    return !storage || typeof storage.getItem !== "function"
  } catch {
    return true
  }
}

if (isBrokenStorage()) {
  Object.defineProperty(globalThis, "localStorage", {
    value: new MemoryStorage(),
    configurable: true,
    writable: true,
  })
}
