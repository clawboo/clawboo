// Which site a saved login belongs to, as one exact origin.
//
// THE ANTI-PHISHING RULE. A login fills only into a page whose live origin is
// exactly the login's: scheme, host and port. No subdomain matching: without a
// public suffix list, "anything under example.com" also means "anything under
// github.io", and one hostile subdomain would receive every login saved for its
// parent. Someone who signs in at two addresses saves the login twice.
//
// https only, except a loopback host, where plain http never leaves the machine.
// A password typed into plain http elsewhere is readable by anyone on the path,
// and a fill that is willing to do that is a fill a network attacker can harvest.

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

export type LoginOriginResult =
  { ok: true; origin: string } | { ok: false; reason: 'invalid' | 'insecure' }

function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname) || hostname.endsWith('.localhost')
}

/**
 * The origin a site names, from what a person typed or an agent passed: a bare
 * host (`example.com`, read as https), an origin, or any address on the site
 * (its path, query and fragment are dropped). Refuses anything that is not a
 * plain http(s) address with a host, credentials in the address, and plain http
 * off loopback.
 */
export function loginOriginOf(input: string): LoginOriginResult {
  const raw = input.trim()
  if (!raw || raw.length > 2_048 || /\s/.test(raw)) return { ok: false, reason: 'invalid' }
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`
  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    return { ok: false, reason: 'invalid' }
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { ok: false, reason: 'invalid' }
  if (!url.hostname) return { ok: false, reason: 'invalid' }
  if (url.username || url.password) return { ok: false, reason: 'invalid' }
  if (url.protocol === 'http:' && !isLoopbackHost(url.hostname)) {
    return { ok: false, reason: 'insecure' }
  }
  return { ok: true, origin: url.origin }
}

/**
 * The origin of a page's address, or null when it has none a login could belong
 * to (`about:blank`, `data:`, `file:`, `chrome:`, an opaque origin). Never
 * applies the bare-host reading: this is what the browser reports.
 */
export function pageOriginOf(pageUrl: string): string | null {
  let url: URL
  try {
    url = new URL(pageUrl)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  const origin = url.origin
  return origin && origin !== 'null' ? origin : null
}
