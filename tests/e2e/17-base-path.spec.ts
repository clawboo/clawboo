// Serving the whole app under a URL path prefix (CLAWBOO_BASE_PATH).
//
// Three servers, because the interesting part is the token-gated one: the same
// -origin guard and the access gate decide what to protect by matching the API
// path and FAIL OPEN on anything else, so "the API is still guarded once it moves
// under a prefix" is the property worth proving end to end rather than in a unit.
// The third starts with no STUDIO_ACCESS_TOKEN at all, the default install, which
// locks itself with a per-install token that `clawboo open` signs a browser in to.
//
// These spawn their own servers rather than using the shared one from
// playwright.config.ts, since the prefix is a boot-time setting. They reuse the
// `dist/ui` that config already built, so nothing here rebuilds.

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

import { expect, test } from '@playwright/test'

import { SIGNED_OUT } from './helpers/fixtures'

// Specs load as CommonJS here, so no `import.meta`. Playwright resolves its
// config from the repo root and runs from there.
const WEB_DIR = path.join(process.cwd(), 'apps/web')
const BASE_PATH = '/clawboo'

// HOME is sandboxed per server below, and corepack keys its cache off HOME, so
// without an explicit COREPACK_HOME the pnpm shim re-downloads itself from the
// registry and this otherwise network-free suite quietly needs the network.
// playwright.config.ts computes the same fallback for its own webServer; it is
// recomputed here because that value lives in the config's module scope and is
// never exported into the runner's environment.
const COREPACK_HOME =
  process.env['COREPACK_HOME'] ??
  path.join(
    process.env['XDG_CACHE_HOME'] ??
      process.env['LOCALAPPDATA'] ??
      path.join(os.homedir(), process.platform === 'win32' ? 'AppData/Local' : '.cache'),
    'node/corepack',
  )

interface Started {
  origin: string
  /** The sandboxed HOME; its Clawboo home is `<home>/.clawboo`. */
  home: string
  stop: () => void
}

// Every server spawned by this file, registered the moment it exists. A hook
// that times out or throws never returns its handle, so a per-describe
// `afterAll(() => server?.stop())` cannot clean up what it was never given, and
// a detached server would keep the port for the next run. The sweep below always
// runs and always sees them.
const spawned: Started[] = []
test.afterAll(() => {
  for (const s of spawned.splice(0)) s.stop()
})

/**
 * Fail if anything already holds the port.
 *
 * The port is pinned, so a collision makes OUR server die on EADDRINUSE while
 * the squatter keeps answering. Checking after the fact cannot work: the
 * squatter replies to the first probe about a second before the child's exit is
 * observed, so the readiness loop adopts it and the whole spec silently tests
 * someone else's server. The only reliable moment is before the spawn.
 */
async function assertPortFree(port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const probe = net
      .createServer()
      .once('error', (err: NodeJS.ErrnoException) =>
        reject(
          new Error(
            `port ${port} is already in use (${err.code}), so this spec cannot tell its own server from the squatter`,
          ),
        ),
      )
      .once('listening', () => probe.close(() => resolve()))
      .listen(port, '127.0.0.1')
  })
}

/**
 * Boot a sandboxed server under the prefix and wait for it to answer. An
 * `undefined` in `extraEnv` removes that variable from the inherited environment.
 */
async function startServer(
  port: number,
  extraEnv: Record<string, string | undefined> = {},
): Promise<Started> {
  await assertPortFree(port)
  const home = mkdtempSync(path.join(os.tmpdir(), 'clawboo-e2e-base-'))
  // `detached` puts the server in its own process GROUP. `pnpm exec` is a wrapper
  // that forks the real node process, so signalling the child alone leaves the
  // server orphaned and still holding the port: the next run's readiness probe
  // then answers from that stale process, whose sandbox this run already deleted,
  // and the app serves its shell but never initializes.
  const child: ChildProcess = spawn('pnpm', ['exec', 'tsx', 'server/index.ts'], {
    cwd: WEB_DIR,
    stdio: 'ignore',
    detached: true,
    env: {
      ...process.env,
      HOME: home,
      CLAWBOO_HOME: path.join(home, '.clawboo'),
      OPENCLAW_STATE_DIR: path.join(home, '.openclaw'),
      CLAWBOO_API_PORT: String(port),
      CLAWBOO_BASE_PATH: BASE_PATH,
      CLAWBOO_UI_DIR: path.join(WEB_DIR, 'dist/ui'),
      COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
      COREPACK_HOME,
      ...extraEnv,
    },
  })

  /** Kill the whole process group, so no orphan keeps holding the port. */
  const stop = (): void => {
    try {
      if (child.pid) process.kill(-child.pid, 'SIGKILL')
    } catch {
      // Already gone.
    }
    rmSync(home, { recursive: true, force: true })
  }

  const started: Started = { origin: `http://127.0.0.1:${port}`, home, stop }
  // Registered BEFORE the wait, so a hook timeout mid-boot still gets cleaned up.
  spawned.push(started)

  let exited = false
  child.once('exit', () => {
    exited = true
  })

  const origin = started.origin
  const deadline = Date.now() + 90_000
  for (;;) {
    // Belt to assertPortFree's braces: catches a child that dies for any other
    // reason (a crash on boot) instead of waiting out the full deadline.
    if (exited) {
      stop()
      throw new Error(`server for ${port} exited during startup (is the port taken?)`)
    }
    if (Date.now() > deadline) {
      stop()
      throw new Error(`server on ${port} did not become ready`)
    }
    try {
      // Any answer (200 or a 401 from the gate) means it is listening.
      await fetch(`${origin}${BASE_PATH}/api/settings`)
      break
    } catch {
      await new Promise((r) => setTimeout(r, 500))
    }
  }

  return started
}

/** Boot inside a hook, widening the hook's own timeout to cover a cold start. */
async function startInHook(
  port: number,
  extraEnv?: Record<string, string | undefined>,
): Promise<Started> {
  // A beforeAll hook inherits the project timeout (30s by default), which is less
  // than a cold server boot, so without this the hook is killed before the
  // readiness loop's own deadline can report anything useful.
  test.setTimeout(150_000)
  return startServer(port, extraEnv)
}

test.describe.configure({ mode: 'serial' })

test.describe('served under a path prefix', () => {
  let server: Started

  test.beforeAll(async () => {
    // A blank token is the documented way to run with no gate at all.
    server = await startInHook(19971, { STUDIO_ACCESS_TOKEN: '' })
  })
  test.afterAll(() => server?.stop())

  test('the dashboard loads at the mount and its assets resolve', async ({ page }) => {
    // Same-origin only: the shell loads Google Fonts, and an egress-restricted
    // runner failing that request says nothing about the base path.
    const sameOrigin = (url: string): boolean => url.startsWith(server.origin)
    const failed: string[] = []
    page.on('requestfailed', (r) => {
      if (sameOrigin(r.url())) failed.push(r.url())
    })
    page.on('response', (r) => {
      if (sameOrigin(r.url()) && r.status() >= 400) failed.push(`${r.status()} ${r.url()}`)
    })
    // Anything the app addresses at the ORIGIN ROOT escaped the mount. The server
    // still serves the unprefixed /api for its loopback control plane, so such a
    // request answers 200 and would never show up as a failure: this is the only
    // check that sees it.
    const escaped: string[] = []
    const apiRequests: string[] = []
    page.on('request', (r) => {
      if (!sameOrigin(r.url())) return
      const p = new URL(r.url()).pathname
      if (p.startsWith(`${BASE_PATH}/api/`)) apiRequests.push(r.url())
      else if (p.startsWith('/api/')) escaped.push(r.url())
    })

    await page.goto(`${server.origin}${BASE_PATH}/`)
    // The shell advertises its own mount point, which is what lets the prebuilt
    // bundle resolve assets and build API URLs without a rebuild.
    await expect(page.locator('base')).toHaveAttribute('href', `${BASE_PATH}/`)
    expect(await page.evaluate(() => window.__CLAWBOO_BASE__)).toBe(BASE_PATH)
    // Assets first: a 404 here is the root cause of an empty #root, so asserting
    // it before the render check makes the failure name itself.
    expect(failed, `no request under the mount should fail:\n${failed.join('\n')}`).toEqual([])
    // The app actually mounted (React rendered into #root).
    await expect(page.locator('#root')).not.toBeEmpty({ timeout: 30_000 })

    // The SPA issues almost all of its API traffic AFTER first paint, so let the
    // network settle before judging where those requests went. Asserting at first
    // paint would have seen a single request and passed regardless.
    await page.waitForLoadState('networkidle').catch(() => undefined)
    expect(apiRequests.length, 'the app should have called its API by now').toBeGreaterThan(1)
    expect(
      escaped,
      `these addressed the origin root instead of the mount:\n${escaped.join('\n')}`,
    ).toEqual([])
  })

  test('a deep route serves the shell and the API answers under the prefix', async () => {
    const deep = await fetch(`${server.origin}${BASE_PATH}/board`)
    expect(deep.status).toBe(200)
    expect(await deep.text()).toContain('__CLAWBOO_BASE__')

    const api = await fetch(`${server.origin}${BASE_PATH}/api/settings`)
    expect(api.status).toBe(200)
    expect(await api.json()).toHaveProperty('gatewayUrl')
  })

  test('the bare prefix and the root redirect to the mount, preserving the query', async () => {
    const bare = await fetch(`${server.origin}${BASE_PATH}`, { redirect: 'manual' })
    expect(bare.status).toBe(302)
    expect(bare.headers.get('location')).toBe(`${BASE_PATH}/`)

    // The CLI prints `/?access_token=...`; dropping the query would break it.
    const root = await fetch(`${server.origin}/?access_token=abc`, { redirect: 'manual' })
    expect(root.status).toBe(302)
    expect(root.headers.get('location')).toBe(`${BASE_PATH}/?access_token=abc`)
  })

  test('paths outside the mount 404', async () => {
    for (const p of ['/clawboonot/x', '/elsewhere']) {
      expect((await fetch(`${server.origin}${p}`)).status).toBe(404)
    }
  })
})

test.describe('the guards still enforce under the prefix', () => {
  let server: Started
  const TOKEN = 'e2ebasepathtoken'

  test.beforeAll(async () => {
    server = await startInHook(19972, { STUDIO_ACCESS_TOKEN: TOKEN })
  })
  test.afterAll(() => server?.stop())

  test('the access gate blocks the prefixed API without a cookie', async () => {
    const res = await fetch(`${server.origin}${BASE_PATH}/api/settings`)
    expect(res.status).toBe(401)
  })

  test('the same-origin guard blocks a foreign Origin under the prefix', async () => {
    // The fail-open case: a guard still matching only the unprefixed path would
    // wave this through as if it were a static asset.
    const res = await fetch(`${server.origin}${BASE_PATH}/api/settings`, {
      headers: { Origin: 'https://evil.example' },
    })
    expect(res.status).toBe(403)
  })

  test('the token exchange scopes its cookie to the mount and returns to it', async () => {
    const res = await fetch(`${server.origin}${BASE_PATH}/?access_token=${TOKEN}`, {
      redirect: 'manual',
    })
    expect(res.status).toBe(302)
    expect(res.headers.get('set-cookie')).toContain(`Path=${BASE_PATH}`)
    expect(res.headers.get('location')).toContain(`${BASE_PATH}/`)

    const authed = await fetch(`${server.origin}${BASE_PATH}/api/settings`, {
      headers: { Cookie: `clawboo_access=${TOKEN}` },
    })
    expect(authed.status).toBe(200)
  })

  test('the unprefixed API is still gated, not opened up', async () => {
    // It stays served for the loopback control plane, but the prefix must not
    // have turned it into an unauthenticated bypass.
    const res = await fetch(`${server.origin}/api/settings`)
    expect(res.status).toBe(401)
  })

  test('a launch code signs in under the mount, once, and returns to it', async ({
    playwright,
  }) => {
    const minted = await fetch(`${server.origin}${BASE_PATH}/api/access/launch-code`, {
      method: 'POST',
      headers: { Cookie: `clawboo_access=${TOKEN}` },
    })
    expect(minted.status).toBe(200)
    const { code } = (await minted.json()) as { code: string }

    // The fetch metadata a browser sends when it loads a page; without it the
    // code is not spent (a link previewer's fetch). Not Node's fetch, which sends
    // its own Sec-Fetch-Mode over any given.
    const pageLoad = { 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' }
    const bare = await playwright.request.newContext({ storageState: SIGNED_OUT })
    const url = `${server.origin}${BASE_PATH}/?access_code=${code}`
    const first = await bare.get(url, { headers: pageLoad, maxRedirects: 0 })
    expect(first.status()).toBe(302)
    expect(first.headers()['set-cookie']).toContain(`clawboo_access=${TOKEN}`)
    expect(first.headers()['set-cookie']).toContain(`Path=${BASE_PATH}`)
    expect(first.headers()['location']).toBe(`${server.origin}${BASE_PATH}/`)

    const fresh = await playwright.request.newContext({ storageState: SIGNED_OUT })
    const again = await fresh.get(url, { headers: pageLoad, maxRedirects: 0 })
    expect(again.status()).toBe(302)
    expect(again.headers()['set-cookie']).toBeUndefined()
    await bare.dispose()
    await fresh.dispose()
  })
})

test.describe('a server started with no STUDIO_ACCESS_TOKEN locks itself', () => {
  let server: Started
  const PORT = 19973

  test.beforeAll(async () => {
    // Unset, not blank: the default install.
    server = await startInHook(PORT, { STUDIO_ACCESS_TOKEN: undefined })
  })
  test.afterAll(() => server?.stop())

  test('the API needs the cookie, and the token is in a file only its owner can read', async () => {
    const res = await fetch(`${server.origin}${BASE_PATH}/api/settings`)
    expect(res.status).toBe(401)
    expect(((await res.json()) as { gate?: string }).gate).toBe('clawboo-access')

    const file = path.join(server.home, '.clawboo', 'access-token')
    expect(readFileSync(file, 'utf8')).toMatch(/^[A-Za-z0-9_-]{43}$/)
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  test('a signed-out browser gets the locked screen, which names clawboo open', async ({
    browser,
  }) => {
    const context = await browser.newContext({ storageState: SIGNED_OUT })
    const page = await context.newPage()
    await page.goto(`${server.origin}${BASE_PATH}/`)
    await expect(page.getByRole('heading', { name: /locked to your computer/i })).toBeVisible({
      timeout: 30_000,
    })
    await expect(page.getByText('clawboo open', { exact: true })).toBeVisible()
    await context.close()
  })

  test('clawboo open --print gives a one-time link that signs one browser in', async ({
    browser,
  }) => {
    // The CLI from source, reading the token file the server wrote.
    const cli = spawnSync('pnpm', ['exec', 'tsx', '../cli/src/index.ts', 'open', '--print'], {
      cwd: WEB_DIR,
      encoding: 'utf8',
      timeout: 60_000,
      env: {
        ...process.env,
        STUDIO_ACCESS_TOKEN: undefined,
        HOME: server.home,
        CLAWBOO_HOME: path.join(server.home, '.clawboo'),
        CLAWBOO_API_PORT: String(PORT),
        CLAWBOO_BASE_PATH: BASE_PATH,
        COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
        COREPACK_HOME,
      },
    })
    // The CLI's notices go to stdout, so show both streams when it fails.
    expect(cli.status, `${cli.stdout}\n${cli.stderr}`).toBe(0)
    const link = cli.stdout.trim()
    expect(link).toMatch(
      new RegExp(`^${server.origin}${BASE_PATH}/\\?access_code=[A-Za-z0-9_-]{32,}$`),
    )
    // Nothing secret on the terminal: the token is in neither stream.
    const token = readFileSync(path.join(server.home, '.clawboo', 'access-token'), 'utf8')
    expect(cli.stdout + cli.stderr).not.toContain(token)

    // The CLI dials and prints 127.0.0.1, the address this server listens on, so
    // the link opens as printed.
    const first = await browser.newContext({ storageState: SIGNED_OUT })
    const page = await first.newPage()
    await page.goto(link)
    await expect(page).toHaveURL(`${server.origin}${BASE_PATH}/`)
    await expect(page.locator('#root')).not.toBeEmpty({ timeout: 30_000 })
    await expect(page.getByTestId('access-locked')).toHaveCount(0)
    expect((await first.cookies()).some((c) => c.name === 'clawboo_access')).toBe(true)
    await first.close()

    // The same link a second time: spent, so the lock.
    const second = await browser.newContext({ storageState: SIGNED_OUT })
    const late = await second.newPage()
    await late.goto(link)
    await expect(late.getByTestId('access-locked')).toBeVisible({ timeout: 30_000 })
    await second.close()
  })
})
