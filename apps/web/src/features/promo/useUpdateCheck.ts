import { useCallback, useEffect, useRef, useState } from 'react'

// useUpdateCheck — polls the server's self-version endpoint and decides whether
// to surface the "update available" chip. Mirrors GitHubStarButton's
// fetch+localStorage-cache+focus-refetch pattern so multiple mounts share one
// call and rapid tab-switching doesn't spam the endpoint.
//
// The endpoint itself does the registry probe server-side (cached ~6h,
// fail-silent), so the client cache here is just to avoid a fetch on every
// mount. Dismiss is keyed to the LATEST version, so a dismissed chip reappears
// only when a newer version ships.

export interface SelfVersionInfo {
  current: string
  latest: string | null
  updateAvailable: boolean
  updateCommand: string
  installMethod: 'global' | 'npx' | 'dev'
  applyable: boolean
  isDeprecated: boolean
  checkedAt: number | null
}

const ENDPOINT = '/api/system/self-version'
const CACHE_KEY = 'clawboo.updateCheck'
const DISMISS_KEY = 'clawboo.updateDismissedVersion'
const CACHE_TTL_MS = 60 * 60 * 1000 // 1h client cache (server caches the registry ~6h)

interface CachedInfo {
  info: SelfVersionInfo
  fetchedAt: number
}

function readCache(): SelfVersionInfo | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(CACHE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as CachedInfo
    if (!parsed || typeof parsed.fetchedAt !== 'number') return null
    if (Date.now() - parsed.fetchedAt > CACHE_TTL_MS) return null
    if (typeof parsed.info?.current !== 'string') return null
    return parsed.info
  } catch {
    return null
  }
}

function writeCache(info: SelfVersionInfo): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(CACHE_KEY, JSON.stringify({ info, fetchedAt: Date.now() }))
  } catch {
    /* localStorage unavailable — fall through */
  }
}

function readDismissed(): string | null {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage.getItem(DISMISS_KEY)
  } catch {
    return null
  }
}

function writeDismissed(version: string | null): void {
  if (typeof window === 'undefined') return
  try {
    if (version) window.localStorage.setItem(DISMISS_KEY, version)
    else window.localStorage.removeItem(DISMISS_KEY)
  } catch {
    /* best-effort */
  }
}

export interface UseUpdateCheck {
  info: SelfVersionInfo | null
  /** True when an update is available AND not dismissed for this latest version. */
  shouldShow: boolean
  dismiss: () => void
  recheck: () => void
}

export function useUpdateCheck(): UseUpdateCheck {
  const [info, setInfo] = useState<SelfVersionInfo | null>(() => readCache())
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(() => readDismissed())
  // Prevents mount + focus + recheck from racing into concurrent fetches.
  const inflight = useRef(false)

  const fetchInfo = useCallback(async (force = false) => {
    if (inflight.current) return
    if (!force && readCache()) return
    inflight.current = true
    try {
      const res = await fetch(ENDPOINT, { cache: 'no-store' })
      if (!res.ok) return
      const data = (await res.json()) as SelfVersionInfo
      if (typeof data.current !== 'string') return
      setInfo(data)
      writeCache(data)
    } catch {
      /* offline / endpoint absent — keep whatever we have, never nag */
    } finally {
      inflight.current = false
    }
  }, [])

  useEffect(() => {
    void fetchInfo()
  }, [fetchInfo])

  // Refetch when the tab regains focus — catches "a new version shipped while I
  // was away". Cache-gated, so quick tab-switching doesn't hit the endpoint.
  useEffect(() => {
    const onFocus = () => {
      void fetchInfo()
    }
    const onVisibilityChange = () => {
      if (!document.hidden) void fetchInfo()
    }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [fetchInfo])

  const dismiss = useCallback(() => {
    const v = info?.latest ?? null
    setDismissedVersion(v)
    writeDismissed(v)
  }, [info])

  const recheck = useCallback(() => {
    void fetchInfo(true)
  }, [fetchInfo])

  const shouldShow = Boolean(
    info?.updateAvailable && info.latest && info.latest !== dismissedVersion,
  )

  return { info, shouldShow, dismiss, recheck }
}
