import { useEffect, useState } from 'react'

const STORAGE_KEY = 'clawboo.welcome.atmosphere'
const STORAGE_EVENT = 'clawboo:welcome-atmosphere-changed'

export type AtmospherePreference = 'on' | 'off'

function readPreference(): AtmospherePreference {
  if (typeof window === 'undefined') return 'on'
  const raw = window.localStorage.getItem(STORAGE_KEY)
  return raw === 'off' ? 'off' : 'on'
}

/**
 * Read user opt-out preference for the Welcome atmosphere.
 * Default ON; persisted to localStorage. Listens for storage events so the
 * Maintenance panel toggle and any tab/window sees the change immediately.
 */
export function useAtmospherePreference(): AtmospherePreference {
  const [pref, setPref] = useState<AtmospherePreference>(readPreference)

  useEffect(() => {
    const handler = () => setPref(readPreference())
    window.addEventListener('storage', handler)
    window.addEventListener(STORAGE_EVENT, handler)
    return () => {
      window.removeEventListener('storage', handler)
      window.removeEventListener(STORAGE_EVENT, handler)
    }
  }, [])

  return pref
}

/** Imperative setter used by the Maintenance toggle. */
export function setAtmospherePreference(pref: AtmospherePreference): void {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(STORAGE_KEY, pref)
  window.dispatchEvent(new Event(STORAGE_EVENT))
}

/** Read the OS prefers-reduced-motion flag (live). */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState<boolean>(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  })

  useEffect(() => {
    if (!window.matchMedia) return
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const handler = (e: MediaQueryListEvent) => setReduced(e.matches)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])

  return reduced
}

/**
 * Returns true when the document is visible AND the element is in the viewport.
 * Pauses WebGL work when the user tabs away or scrolls the atmosphere off-screen.
 */
export function useElementVisible(ref: React.RefObject<HTMLElement | null>): boolean {
  const [visible, setVisible] = useState(true)

  useEffect(() => {
    const el = ref.current
    if (!el) return

    let inViewport = true
    let tabVisible = !document.hidden

    const update = () => setVisible(inViewport && tabVisible)

    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          inViewport = entry.isIntersecting
        }
        update()
      },
      { threshold: 0 },
    )
    io.observe(el)

    const onVisChange = () => {
      tabVisible = !document.hidden
      update()
    }
    document.addEventListener('visibilitychange', onVisChange)

    return () => {
      io.disconnect()
      document.removeEventListener('visibilitychange', onVisChange)
    }
  }, [ref])

  return visible
}
