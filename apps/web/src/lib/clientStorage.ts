// Browser storage, scoped to the URL prefix this dashboard is served under.
//
// localStorage and sessionStorage belong to the ORIGIN, not the page. Behind a
// reverse proxy that serves two Clawboo instances at `/a/` and `/b/`
// (CLAWBOO_BASE_PATH), every key one instance wrote was read by the other: a
// fresh instance skipped its welcome screen because the other had finished it,
// and the theme, layout, board, memory and tour state followed along. So every
// read and write in the SPA goes through here, and the key carries the base path
// in front of it: `/a:clawboo.theme`. A base path cannot contain `:`, so two
// instances can never spell the same key.
//
// At the root the prefix is empty and every key is spelled exactly as before, so
// a laptop install keeps everything it has stored.
//
// A key stored before the prefix existed has none. Under a base path, the first
// read of a key with no prefixed copy MOVES the unprefixed value into this
// instance's scope: an upgraded instance keeps its settings, and the value is not
// left behind for the next instance on the origin to inherit. Removing a key
// removes both spellings, or the old one would come back on the next read.
//
// EVERY CALL TOLERATES FAILURE. Storage throws in Safari private mode and some
// embedded webviews, and a full one throws on write. A read then answers null and
// a write or remove does nothing, which is what each caller did with its own
// try/catch before.
//
// The pre-paint theme script in index.html runs before any module and derives
// the same key inline; `themePrePaint.test.ts` holds the two spellings together.
// ESLint refuses direct storage use anywhere else in the SPA.

import { readInjectedBase } from '@/app/injectedBase'

type AreaName = 'localStorage' | 'sessionStorage'

/** A key prefixed by a base path: the path alphabet, then the `:` separator. */
const SCOPED_KEY_RE = /^\/[A-Za-z0-9._~/-]*:/

/** The key as stored for this instance: unchanged at the root, `<base>:<key>` under a prefix. */
export function scopedStorageKey(key: string): string {
  const base = readInjectedBase()
  return base ? `${base}:${key}` : key
}

function areaOf(name: AreaName): Storage | null {
  try {
    // Reading the property itself throws where storage is disabled.
    return (globalThis as Partial<Record<AreaName, Storage>>)[name] ?? null
  } catch {
    return null
  }
}

/** The Storage methods the SPA uses, scoped to this instance and never throwing. */
export interface ScopedStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
  /** This instance's keys, without the prefix, plus any not yet moved under it. */
  keys(): string[]
}

function scopedArea(name: AreaName): ScopedStorage {
  return {
    getItem(key) {
      const store = areaOf(name)
      if (!store) return null
      const own = scopedStorageKey(key)
      let legacy: string | null
      try {
        const value = store.getItem(own)
        if (value !== null || own === key) return value
        legacy = store.getItem(key)
      } catch {
        return null
      }
      if (legacy === null) return null
      try {
        store.setItem(own, legacy)
        store.removeItem(key)
      } catch {
        // Could not move it (a full store): answer from the old key, try again next read.
      }
      return legacy
    },
    setItem(key, value) {
      try {
        areaOf(name)?.setItem(scopedStorageKey(key), value)
      } catch {
        // Private mode or a full store: the value is simply not remembered.
      }
    },
    removeItem(key) {
      const store = areaOf(name)
      if (!store) return
      const own = scopedStorageKey(key)
      try {
        store.removeItem(own)
        if (own !== key) store.removeItem(key)
      } catch {
        // Nothing stored that could be removed.
      }
    },
    keys() {
      const store = areaOf(name)
      if (!store) return []
      const base = readInjectedBase()
      const prefix = `${base}:`
      const out = new Set<string>()
      try {
        for (let i = 0; i < store.length; i++) {
          const key = store.key(i)
          if (key === null) continue
          if (base && key.startsWith(prefix)) out.add(key.slice(prefix.length))
          else if (!SCOPED_KEY_RE.test(key)) out.add(key)
        }
      } catch {
        return []
      }
      return [...out]
    },
  }
}

/** `localStorage`, scoped to this instance's base path. */
export const scopedLocalStorage: ScopedStorage = scopedArea('localStorage')

/** `sessionStorage`, scoped to this instance's base path. */
export const scopedSessionStorage: ScopedStorage = scopedArea('sessionStorage')
