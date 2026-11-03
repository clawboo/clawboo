// Where an "Open on another device" link points, and whether a phone could reach
// it. Plain functions, so they are tested without rendering the dialog.

/** Hostnames that reach only the computer they are typed on. */
export function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[(.*)\]$/, '$1')
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '::1' ||
    /^127(\.\d{1,3}){3}$/.test(host)
  )
}

/**
 * The dashboard page under `origin` and the mount, with the launch code when
 * there is one. A `localhost` origin becomes `127.0.0.1`, the address the server
 * listens on: `localhost` can resolve to ::1, where another user's program
 * could be listening on the same port to catch the code.
 */
export function deviceLink(origin: string, base: string, code: string | null): string {
  let target = origin
  try {
    const url = new URL(origin)
    if (url.hostname === 'localhost') {
      url.hostname = '127.0.0.1'
      target = url.origin
    }
  } catch {
    // Not a URL: use it as given.
  }
  const page = `${target}${base}/`
  return code === null ? page : `${page}?access_code=${encodeURIComponent(code)}`
}
