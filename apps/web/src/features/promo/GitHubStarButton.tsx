import { useCallback, useEffect, useRef, useState } from 'react'
import { Github, Star } from 'lucide-react'

// GitHub star button — dograh-style outline pill rendered in each view's
// header. Drives traffic to the repo for stars.
//
// Live count update strategy (balances freshness against GitHub's rate limit
// of 60 requests/hour per IP for unauthenticated API calls):
//
//   1. Fetch on mount if cache > 10 min old. Cache the result in localStorage
//      so multiple `GitHubStarButton` instances share one fetch.
//   2. Refetch on window focus (also cache-gated). Catches the common
//      "user starred on GitHub then came back to the tab" flow without
//      spamming the API.
//   3. Optimistic update on click: bump the displayed count by 1 immediately
//      (assumes the user is starring), then trigger a refetch after 3 s so
//      the number reconciles with the real count regardless of whether the
//      user actually starred.
//
// Net effect: at most ~6 API calls / hour / install (the TTL ceiling), well
// under the 60 req/hr rate limit. Falls back to a "·" glyph when the API is
// unreachable (offline, rate-limited, corporate firewall).

const REPO_URL = 'https://github.com/clawboo/clawboo'
const API_URL = 'https://api.github.com/repos/clawboo/clawboo'
const CACHE_KEY = 'clawboo.github.stars'
const CACHE_TTL_MS = 10 * 60 * 1000 // 10 min
const POST_CLICK_REFETCH_DELAY_MS = 3000

interface CachedStars {
  count: number
  fetchedAt: number
}

function readCache(): CachedStars | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(CACHE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as CachedStars
    if (typeof parsed.count !== 'number' || typeof parsed.fetchedAt !== 'number') return null
    if (Date.now() - parsed.fetchedAt > CACHE_TTL_MS) return null
    return parsed
  } catch {
    return null
  }
}

function writeCache(count: number) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(CACHE_KEY, JSON.stringify({ count, fetchedAt: Date.now() }))
  } catch {
    /* localStorage unavailable in some browsing contexts — fall through */
  }
}

function formatCount(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`
  if (count >= 10_000) return `${(count / 1000).toFixed(0)}k`
  if (count >= 1_000) return `${(count / 1000).toFixed(1)}k`
  return String(count)
}

export function GitHubStarButton() {
  const [stars, setStars] = useState<number | null>(() => readCache()?.count ?? null)
  // `inflight` prevents multiple concurrent fetches when mount + focus +
  // click-refetch all race.
  const inflight = useRef(false)

  const fetchStars = useCallback(async (force = false) => {
    if (inflight.current) return
    if (!force) {
      const cached = readCache()
      if (cached) return // fresh enough
    }
    inflight.current = true
    try {
      const res = await fetch(API_URL, { headers: { Accept: 'application/vnd.github+json' } })
      if (!res.ok) return
      const data = (await res.json()) as { stargazers_count?: number }
      if (typeof data.stargazers_count !== 'number') return
      setStars(data.stargazers_count)
      writeCache(data.stargazers_count)
    } catch {
      /* offline / rate-limited / blocked — keep whatever we have */
    } finally {
      inflight.current = false
    }
  }, [])

  // Initial fetch on mount (cache-gated)
  useEffect(() => {
    void fetchStars()
  }, [fetchStars])

  // Refetch when the window regains focus — catches "user just starred on
  // GitHub and came back to the tab". Still cache-gated so rapid tab
  // switching doesn't hit the API repeatedly.
  useEffect(() => {
    const onFocus = () => {
      void fetchStars()
    }
    const onVisibilityChange = () => {
      if (!document.hidden) void fetchStars()
    }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [fetchStars])

  // Click handler: optimistic +1, then forced refetch after the user has
  // had time to click Star on GitHub in the new tab.
  const handleClick = useCallback(() => {
    setStars((prev) => (prev !== null ? prev + 1 : prev))
    window.setTimeout(() => {
      void fetchStars(true)
    }, POST_CLICK_REFETCH_DELAY_MS)
  }, [fetchStars])

  return (
    <a
      href={REPO_URL}
      target="_blank"
      rel="noopener noreferrer"
      onClick={handleClick}
      data-testid="github-star-button"
      title="Star Clawboo on GitHub — it really helps!"
      // Sized to match the surrounding view chrome — Atlas's Re-layout /
      // Team halos / Connect, Group Chat's Brief & Rules gear all sit
      // around 30-32 px tall with the same thin border and no shadow.
      // The earlier 36 px + shadow made the pill float visually above
      // the rest of the toolbar; now it belongs in the same row.
      className="group inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-card px-2 text-[12px] font-medium text-foreground transition-all duration-150 hover:border-foreground/20 hover:bg-foreground/[0.04]"
    >
      <Github className="h-3.5 w-3.5 shrink-0" strokeWidth={2} />
      <span>Star</span>
      <span className="flex h-[18px] items-center gap-0.5 rounded-md bg-amber/15 px-1 text-[10px] font-semibold text-amber transition-colors group-hover:bg-amber/25">
        <Star className="h-2.5 w-2.5 shrink-0 fill-current" strokeWidth={0} />
        {stars !== null ? formatCount(stars) : '·'}
      </span>
    </a>
  )
}
