/**
 * Stargazer count, resolved at BUILD time.
 *
 * The count used to be client-only: the page shipped a literal "★" placeholder
 * and a script swapped in the real number. When api.github.com rate-limits the
 * visitor (unauthenticated requests are limited per IP, and a shared or
 * corporate IP hits that constantly) the fetch fails and the badge fell back to
 * the word "Star" — so the button read "Star on GitHub Star".
 *
 * Fetching at build time means the served HTML always carries a real number.
 * The client script still refreshes it, so the figure is live when GitHub
 * answers and merely slightly stale when it does not.
 *
 * FALLBACK is only reached if the build itself cannot reach GitHub (offline
 * build, CI without egress). It is deliberately a real past value rather than
 * zero: a visibly wrong "0" is worse than a number a few stars behind.
 */
const FALLBACK = 57

export async function getStarCount(): Promise<number> {
  try {
    const res = await fetch('https://api.github.com/repos/clawboo/clawboo', {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'clawboo-website-build' },
      signal: AbortSignal.timeout(4000),
    })
    if (!res.ok) return FALLBACK
    const data = (await res.json()) as { stargazers_count?: unknown }
    return typeof data.stargazers_count === 'number' ? data.stargazers_count : FALLBACK
  } catch {
    // Never fail the build over a decorative number.
    return FALLBACK
  }
}

/** 1234 -> "1.2k". Mirrors the formatter in the client script. */
export function formatStars(n: number): string {
  if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, '') + 'k'
  return String(n)
}
