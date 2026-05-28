import { useEffect, useState } from 'react'
import { Github, Star } from 'lucide-react'

// GitHub star button — dograh-style outline pill rendered at the top-right
// of the app via `AppTopBar`. Drives traffic to the repo for stars.
//
// Visual: white/surface pill with thin outline, GitHub octocat icon on the
// left, "Star" text, and a divider + live star count on the right (amber).
// Subtle hover lift. Opens GitHub in a new tab.
//
// Live count: single GitHub API fetch on mount, cached in localStorage with
// a 1-hour TTL. Falls back to a static "★" glyph when the API is unreachable
// (offline, rate-limited at 60 req/hr/IP for unauthenticated requests).

const REPO_URL = 'https://github.com/clawboo/clawboo'
const API_URL = 'https://api.github.com/repos/clawboo/clawboo'
const CACHE_KEY = 'clawboo.github.stars'
const CACHE_TTL_MS = 60 * 60 * 1000 // 1 hour

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

  useEffect(() => {
    const cached = readCache()
    if (cached) return

    let cancelled = false
    fetch(API_URL, { headers: { Accept: 'application/vnd.github+json' } })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { stargazers_count?: number } | null) => {
        if (cancelled || !data || typeof data.stargazers_count !== 'number') return
        setStars(data.stargazers_count)
        writeCache(data.stargazers_count)
      })
      .catch(() => {
        /* offline / rate-limited — render without the count */
      })

    return () => {
      cancelled = true
    }
  }, [])

  return (
    <a
      href={REPO_URL}
      target="_blank"
      rel="noopener noreferrer"
      data-testid="github-star-button"
      title="Star Clawboo on GitHub — it really helps!"
      // Sized to match the surrounding view chrome — Atlas's Re-layout /
      // Team halos / Connect, Group Chat's Brief & Rules gear, Cost's
      // Frugal Mode toggle all sit around 30-32 px tall with the same
      // thin border and no shadow. The earlier 36 px + shadow made the
      // pill float visually above the rest of the toolbar; now it
      // belongs in the same row.
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
