#!/usr/bin/env node
/**
 * scripts/test-clean-install.mjs
 *
 * End-to-end smoke test that simulates `npx clawboo` on a real user's
 * machine and asserts the bundled CLI reaches a working Clawboo dashboard.
 *
 * Catches the class of bug v0.1.1 and v0.1.2 shipped broken:
 *
 *   v0.1.1: bundled server returned "Cannot GET /" because the Express 5
 *     SPA catch-all pattern '/{*splat}' didn't match the bare /.
 *
 *   v0.1.2: CLI's `findRunningDashboard()` did a TCP-only probe, so when
 *     port 18790 was free but 18791 was held by another service (OpenClaw
 *     Gateway aux port, Chrome --remote-debugging-port, etc.), the CLI
 *     mistook 18791 for Clawboo and routed the browser there — user saw
 *     "Unauthorized" instead of the dashboard.
 *
 * Test scenario (the EXACT condition v0.1.2 shipped broken under):
 *   1. Bind port 18791 with a fake service that returns 401 "Unauthorized"
 *      — mimics OpenClaw Gateway's auxiliary port behavior.
 *   2. Spawn the bundled CLI in an isolated state dir with no env-var
 *      pins. With the v0.1.3 fix, the CLI's HTTP-signature probe rejects
 *      18791 (wrong JSON shape) and Clawboo's own server picks 18790.
 *   3. Assert the CLI prints a URL that is NOT :18791.
 *   4. Curl the printed URL — must return Clawboo SPA HTML.
 *   5. Curl /api/settings — must return Clawboo-shaped JSON.
 *   6. Curl a deep SPA route — must fall through to index.html.
 *
 * Exit codes:
 *   0 — all assertions passed
 *   1 — at least one assertion failed; details in stderr
 */

import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const REPO_ROOT = path.resolve(__dirname, '..')
const CLI_PATH = path.join(REPO_ROOT, 'apps/cli/dist/index.js')
const FAKE_PORT = 18791
const READY_TIMEOUT_MS = 30_000
// /api/system/status does multiple I/O ops: filesystem checks for
// openclaw.json + .env, a 2-s probeGatewayPort fetch to :18789, plus
// the openclaw binary probe via which/where. On Windows CI runners the
// cumulative latency exceeded 5 s in practice. 20 s is a generous cap
// that still fails fast on real hangs.
const HTTP_TIMEOUT_MS = 20_000

// ─── Tiny logger ─────────────────────────────────────────────────────────────

function log(msg) {
  console.log(`[clean-install] ${msg}`)
}

function fail(msg) {
  console.error(`[clean-install] FAIL: ${msg}`)
  process.exitCode = 1
}

// ─── State for cleanup ───────────────────────────────────────────────────────

let fakeService = null
let cliProc = null
let tmpDir = null
let shadowBinDir = null
let clawbooPort = null

async function cleanup() {
  // Best-effort kill the CLI process and the detached server it spawned.
  if (cliProc && !cliProc.killed) {
    try {
      cliProc.kill('SIGTERM')
    } catch {
      /* ignore */
    }
  }
  if (clawbooPort) {
    await killByPort(clawbooPort)
  }
  if (fakeService) {
    await new Promise((resolve) => fakeService.close(() => resolve()))
  }
  for (const dir of [tmpDir, shadowBinDir]) {
    if (dir) {
      try {
        await fs.rm(dir, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
    }
  }
}

process.on('SIGINT', async () => {
  await cleanup()
  process.exit(130)
})

// SIGTERM during cleanup is normal (the spawned detached server's death
// cascade can hit us in macOS). Honor whatever exitCode the assertions
// already set; don't get SIGTERM-amplified to 143.
process.on('SIGTERM', () => {
  process.exit(process.exitCode ?? 0)
})

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function killByPort(port) {
  // Cleanup is best-effort. On Windows there's no `lsof` — CI runners are
  // ephemeral, so leftover processes get reaped when the job exits anyway.
  // Implementing a `netstat -ano` parse here would be defensible but adds
  // moving parts to a script whose main job is asserting onboarding works.
  if (process.platform === 'win32') return
  try {
    const out = await runCmd('lsof', ['-ti', `:${port}`])
    const pids = out.trim().split('\n').filter(Boolean)
    for (const pid of pids) {
      try {
        process.kill(Number(pid), 'SIGTERM')
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* lsof might not exist; ignore */
  }
}

function runCmd(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''
    child.stdout.on('data', (d) => {
      out += d.toString()
    })
    child.on('error', reject)
    child.on('close', () => resolve(out))
  })
}

async function httpGet(url, opts = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeout ?? HTTP_TIMEOUT_MS)
  try {
    const res = await fetch(url, { signal: controller.signal })
    const text = await res.text()
    return { ok: res.ok, status: res.status, text, headers: res.headers }
  } finally {
    clearTimeout(timer)
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  // 1. Verify the bundled CLI exists
  try {
    const stats = await fs.stat(CLI_PATH)
    if (!stats.isFile()) throw new Error('not a file')
  } catch {
    fail(`CLI binary not found at ${CLI_PATH}. Run \`pnpm assemble\` first.`)
    return
  }
  log(`Bundled CLI: ${CLI_PATH}`)

  // 2. Sanity-check port 18791 is free before we try to bind it
  await killByPort(FAKE_PORT) // best-effort clean from prior aborted runs
  await new Promise((r) => setTimeout(r, 200))

  // 3. Start the fake "Gateway-aux" listener on 18791
  fakeService = createServer((_req, res) => {
    res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end('Unauthorized')
  })
  await new Promise((resolve, reject) => {
    fakeService.once('error', (err) => reject(err))
    fakeService.listen(FAKE_PORT, '127.0.0.1', () => resolve())
  })
  log(`Fake service on :${FAKE_PORT} (returns 401 "Unauthorized" — mimics Gateway aux port)`)

  // 4. Create isolated state dir + isolated $HOME so the developer's real
  //    ~/.openclaw/ is never touched.
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'clawboo-clean-install-'))
  await fs.mkdir(path.join(tmpDir, '.openclaw', 'clawboo'), { recursive: true })
  log(`Isolated state: ${tmpDir}`)

  // 5. Build a shadow PATH that includes node + npm + which (Clawboo needs
  //    them) but NOT `open` / `xdg-open` — that way the CLI's browser-open
  //    fails silently and we don't get a real browser launch during tests.
  //
  //    Windows: symlinking system binaries requires admin in some setups,
  //    and `start` (the Windows browser-open shim) on a headless CI runner
  //    won't open anything anyway. Skip the shadow PATH on Windows and let
  //    the CLI inherit the system PATH.
  const useShadowPath = process.platform !== 'win32'
  let cliEnvPath = process.env.PATH ?? ''
  if (useShadowPath) {
    shadowBinDir = await fs.mkdtemp(path.join(os.tmpdir(), 'clawboo-shadow-bin-'))
    const allowedBins = ['node', 'npm', 'pnpm', 'which', 'ls']
    for (const dir of ['/usr/bin', '/bin', '/usr/local/bin', path.dirname(process.execPath)]) {
      for (const bin of allowedBins) {
        const src = path.join(dir, bin)
        try {
          await fs.access(src)
          await fs.symlink(src, path.join(shadowBinDir, bin)).catch(() => {})
        } catch {
          /* skip missing */
        }
      }
    }
    cliEnvPath = shadowBinDir
  }

  // 6. Spawn the CLI binary
  cliProc = spawn('node', [CLI_PATH], {
    env: {
      PATH: cliEnvPath,
      HOME: tmpDir,
      // Windows uses USERPROFILE — Node's os.homedir() reads it. Keep it
      // pointed at the isolated state dir so any HOME-derived state goes
      // there too.
      USERPROFILE: tmpDir,
      OPENCLAW_STATE_DIR: path.join(tmpDir, '.openclaw'),
      STUDIO_ACCESS_TOKEN: '',
      CLAWBOO_API_PORT: '',
      // Inherit a few harmless vars
      NODE_ENV: 'production',
      LANG: process.env.LANG || 'en_US.UTF-8',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let stdoutBuf = ''
  let stderrBuf = ''
  cliProc.stdout.on('data', (data) => {
    stdoutBuf += data.toString()
    process.stdout.write(`[cli] ${data.toString().trimEnd()}\n`)
  })
  cliProc.stderr.on('data', (data) => {
    stderrBuf += data.toString()
    process.stderr.write(`[cli] ${data.toString().trimEnd()}\n`)
  })

  // 7. Wait for the CLI to print an "opened at http://localhost:<port>" URL.
  // CLI uses chalk for colors; strip ANSI escapes before regex matching.
  // eslint-disable-next-line no-control-regex
  const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
  const urlRegex = /opened at\s+(http:\/\/localhost:(\d+))/i
  const deadline = Date.now() + READY_TIMEOUT_MS
  let openedUrl = null
  while (Date.now() < deadline) {
    // ora writes the success banner ("opened at ...") to stderr; clack
    // writes intro/outro to stdout. Search the combined buffer.
    const match = stripAnsi(stdoutBuf + stderrBuf).match(urlRegex)
    if (match) {
      openedUrl = match[1]
      clawbooPort = Number(match[2])
      break
    }
    if (cliProc.exitCode !== null) {
      fail(`CLI exited (code ${cliProc.exitCode}) before printing a URL`)
      console.error('--- CLI stdout ---\n' + stripAnsi(stdoutBuf))
      console.error('--- CLI stderr ---\n' + stderrBuf)
      return
    }
    await new Promise((r) => setTimeout(r, 200))
  }
  if (!openedUrl) {
    fail(`CLI did not print "opened at <URL>" within ${READY_TIMEOUT_MS}ms`)
    console.error('--- CLI stdout ---\n' + stripAnsi(stdoutBuf))
    return
  }
  log(`CLI announced dashboard at: ${openedUrl} (port ${clawbooPort})`)

  // ─── CRITICAL ASSERTION ─────────────────────────────────────────────────
  // Even though :18791 is "alive" (TCP), the CLI must reject it because
  // the HTTP signature probe sees non-Clawboo content.
  if (clawbooPort === FAKE_PORT) {
    fail(`CLI routed browser to fake :${FAKE_PORT} — this is the v0.1.2 bug!`)
    return
  }
  log(`✓ CLI correctly skipped fake :${FAKE_PORT}`)

  // 8. Test 1: GET / returns SPA HTML
  const root = await httpGet(`${openedUrl}/`)
  if (!root.ok) {
    fail(`GET ${openedUrl}/ → HTTP ${root.status}`)
    return
  }
  if (!root.text.includes('<div id="root"></div>')) {
    fail(`GET ${openedUrl}/ did not return SPA HTML (no <div id="root">)`)
    console.error('Body (first 500 chars):\n' + root.text.slice(0, 500))
    return
  }
  log('✓ GET / returns SPA HTML')

  // 9. Test 2: deep SPA route falls through to index.html
  const deep = await httpGet(`${openedUrl}/some/spa/route`)
  if (!deep.ok) {
    fail(`GET /some/spa/route → HTTP ${deep.status}`)
    return
  }
  if (!deep.text.includes('<div id="root"></div>')) {
    fail('GET /some/spa/route did not fall through to SPA HTML')
    return
  }
  log('✓ GET /some/spa/route falls through to SPA (catch-all works)')

  // 10. Test 3: /api/settings returns Clawboo JSON
  const settings = await httpGet(`${openedUrl}/api/settings`)
  if (!settings.ok) {
    fail(`GET /api/settings → HTTP ${settings.status}`)
    return
  }
  let body
  try {
    body = JSON.parse(settings.text)
  } catch {
    fail(`/api/settings did not return JSON: ${settings.text.slice(0, 200)}`)
    return
  }
  if (typeof body.gatewayUrl !== 'string' || typeof body.hasToken !== 'boolean') {
    fail(`/api/settings JSON missing required fields: ${JSON.stringify(body)}`)
    return
  }
  log('✓ GET /api/settings returns Clawboo-shaped JSON')

  // 11. Test 4: /api/system/status returns object with expected keys
  const status = await httpGet(`${openedUrl}/api/system/status`)
  if (!status.ok) {
    fail(`GET /api/system/status → HTTP ${status.status}`)
    return
  }
  let statusBody
  try {
    statusBody = JSON.parse(status.text)
  } catch {
    fail(`/api/system/status did not return JSON: ${status.text.slice(0, 200)}`)
    return
  }
  if (!statusBody.node || !statusBody.gateway) {
    fail(`/api/system/status missing keys: ${JSON.stringify(statusBody)}`)
    return
  }
  log('✓ GET /api/system/status returns expected shape')

  log('All clean-install smoke tests passed.')
}

// Run, ensuring cleanup with a hard timeout
const startedAt = Date.now()
try {
  await main()
} catch (err) {
  console.error(`[clean-install] Unhandled error: ${err?.message ?? err}`)
  if (err?.stack) console.error(err.stack)
  process.exitCode = 1
}

log(`Cleaning up...`)
// IMPORTANT: store success state BEFORE running cleanup so signals during
// cleanup don't lose the result. The cleanup itself runs detached from
// the main flow — its job is best-effort port/handle release.
const succeeded = process.exitCode !== 1
if (succeeded) {
  console.log('[clean-install] ✓ All checks passed.')
} else {
  console.error('[clean-install] One or more assertions failed.')
}

// Cleanup runs as a fire-and-forget detached chain, capped at 3s.
// Whatever doesn't finish in that window is "good enough" — the
// detached server gets reaped by the OS when its parent exits.
const cleanupDone = Promise.race([cleanup(), new Promise((resolve) => setTimeout(resolve, 3000))])

// Set the exit code IMMEDIATELY so any signal (SIGTERM from the OS or
// detached server's death cascade) gets the right code.
process.exitCode = succeeded ? 0 : 1
await cleanupDone
log(`Done (total ${Date.now() - startedAt}ms)`)
process.exit(process.exitCode)
