// The base-URL + header seam every control-plane call routes through.
//
// Web defaults to same-origin (empty base) so behavior is byte-identical to the
// old hard-coded `fetch('/api/...')`. A desktop/mobile/npm client calls
// `setApiBase('https://host')` to target a remote server, and
// `setRequestHeaderProvider(() => ({ Authorization: ... }))` to inject an auth /
// tenant header on every request (a no-op in single-tenant today; pairs with the
// server's `getTenantId` + auth middleware seam).

let apiBase = ''

/** Returns extra headers to merge into every control-plane request. */
export type HeaderProvider = () => Record<string, string>

let headerProvider: HeaderProvider = () => ({})

/**
 * Point the control client at a server. Web leaves this unset (same-origin);
 * desktop/mobile/npm pass an absolute origin (e.g. `https://app.example.com`).
 * A trailing slash is stripped so `apiUrl('/api/x')` never doubles the slash.
 */
export function setApiBase(url: string): void {
  apiBase = url.replace(/\/+$/, '')
}

/** The configured base (empty string = same-origin). */
export function getApiBase(): string {
  return apiBase
}

/**
 * Register a synchronous header provider (auth / tenant). Sync so it composes
 * with the SSE consumer's synchronous-return contract; a token refresh mutates
 * the variable the closure reads.
 */
export function setRequestHeaderProvider(fn: HeaderProvider): void {
  headerProvider = fn
}

/** The current injected headers (defaults to none). */
export function getRequestHeaders(): Record<string, string> {
  return headerProvider()
}

/** Reset base + header provider to their same-origin, no-header defaults (tests). */
export function resetControlClient(): void {
  apiBase = ''
  headerProvider = () => ({})
}

/** Resolve an `/api/...` path against the configured base. */
export function apiUrl(path: string): string {
  return `${apiBase}${path}`
}

/**
 * Base-aware `fetch` with the injected headers merged in. Per-call `init.headers`
 * win over the provider so a caller's `Content-Type` overrides. With the default
 * empty base + empty provider this is byte-identical to `fetch(path, init)`.
 */
export function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(apiUrl(path), {
    ...init,
    headers: { ...headerProvider(), ...(init.headers ?? {}) },
  })
}
