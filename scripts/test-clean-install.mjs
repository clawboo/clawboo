#!/usr/bin/env node
/**
 * scripts/test-clean-install.mjs
 *
 * End-to-end smoke test that simulates `npx clawboo` on a real user's
 * machine and asserts the bundled CLI reaches a working Clawboo dashboard.
 *
 * Guards two regression classes:
 *
 *   1. The bundled server must serve the SPA at the bare `/` (an Express 5
 *      SPA catch-all that doesn't match `/` returns "Cannot GET /").
 *
 *   2. The CLI must HTTP-verify a port is Clawboo before opening the browser:
 *      a TCP-only probe would mistake another service on a nearby port
 *      (an OpenClaw Gateway aux port, Chrome's --remote-debugging-port, etc.)
 *      for Clawboo and route the browser to an "Unauthorized" page.
 *
 * Test scenario:
 *   1. Bind a fake service that returns 401 "Unauthorized" on 18791 (with
 *      retry + sibling-port fallback inside the CLI's 18790-18809 scan
 *      window, so a just-finished e2e run's dying server can't false-fail
 *      the bind) — mimics OpenClaw Gateway's auxiliary port behavior.
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
// Preferred fake-listener port first, then fallbacks. Every candidate sits
// inside the CLI's 18790-18809 discovery scan window, so an alive non-Clawboo
// listener on ANY of them exercises the same probe-rejection guard. Fallbacks
// exist because a `pnpm e2e` run that finished moments earlier can leave a
// dying process still holding 18791 — binding a sibling port keeps the
// chained local gate (`pnpm e2e && pnpm prepublish:check`) reliable.
const FAKE_PORT_CANDIDATES = [18791, 18795, 18799, 18803]
// Total budget for bind attempts before giving up (covers slow teardown of a
// just-killed e2e server; each retry round also best-effort kills leftovers).
const FAKE_BIND_RETRY_MS = 10_000
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
let fakePort = null
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

// Bind an HTTP server that answers 401 "Unauthorized" (mimics an OpenClaw
// Gateway aux port). Resolves the listening server or rejects with the listen
// error (EADDRINUSE when the port is held).
function tryListenFake(port) {
  return new Promise((resolve, reject) => {
    const srv = createServer((_req, res) => {
      res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end('Unauthorized')
    })
    srv.once('error', (err) => reject(err))
    srv.listen(port, '127.0.0.1', () => resolve(srv))
  })
}

// Bind the fake listener robustly. A `pnpm e2e` run that ended moments before
// can leave a dying process still holding the preferred port, which used to
// EADDRINUSE-crash this whole gate in ~250ms. Strategy per round: try every
// candidate port; on EADDRINUSE best-effort kill whatever holds it (a leftover
// from a prior aborted run) and move on; between rounds back off, up to the
// retry budget. The first successful bind wins — normally 18791 on the first
// attempt, or a sibling port with zero delay in the chained-after-e2e case.
async function bindFakeService() {
  const deadline = Date.now() + FAKE_BIND_RETRY_MS
  let delay = 250
  let lastErr = null
  // Candidate ports a foreign process held at any point during binding. The
  // caller must assert the CLI did NOT attach to one of these — in fallback
  // mode the fake sits ABOVE the busy port in the CLI's ascending scan, so a
  // surviving squatter (worst case: a stale Clawboo-shaped server) would
  // otherwise be discovered first and the probe-rejection guard would pass
  // vacuously against the wrong server.
  const busy = new Set()
  for (;;) {
    for (const port of FAKE_PORT_CANDIDATES) {
      try {
        const srv = await tryListenFake(port)
        busy.delete(port) // we own it now — no foreign holder left
        return { srv, port, busyPorts: [...busy] }
      } catch (err) {
        if (err?.code !== 'EADDRINUSE') throw err
        lastErr = err
        busy.add(port)
        await killByPort(port)
      }
    }
    if (Date.now() >= deadline) break
    log(
      `fake-listener ports ${FAKE_PORT_CANDIDATES.join('/')} busy ` +
        `(likely still releasing after an e2e run) — retrying in ${delay}ms...`,
    )
    await new Promise((r) => setTimeout(r, delay))
    delay = Math.min(delay * 2, 2_000)
  }
  // Out of budget — name the squatters so the failure is self-diagnosing.
  let holders = ''
  if (process.platform !== 'win32') {
    holders = await runCmd('lsof', ['-nP', '-iTCP:18790-18809', '-sTCP:LISTEN']).catch(() => '')
  }
  throw new Error(
    `could not bind a fake listener on any of :${FAKE_PORT_CANDIDATES.join(', :')} ` +
      `within ${FAKE_BIND_RETRY_MS}ms (${lastErr?.message ?? 'EADDRINUSE'}).` +
      (holders.trim() ? `\nListeners in the 18790-18809 window:\n${holders.trim()}` : ''),
  )
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

// Spawn a bundled stdio MCP bin and drive a minimal MCP handshake over its
// stdin/stdout (raw newline-delimited JSON-RPC — no SDK import needed in this
// harness): initialize → notifications/initialized → tools/list. Resolves to the
// tool names. Proves an external runtime can spawn the packaged bin + call a tool.
function mcpStdioListTools(binPath, dbDir) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [binPath], {
      env: {
        ...process.env,
        HOME: dbDir,
        USERPROFILE: dbDir,
        CLAWBOO_DB_PATH: path.join(dbDir, 'mcp.db'),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let buf = ''
    let done = false
    const finish = (fn, arg) => {
      if (done) return
      done = true
      clearTimeout(timer)
      try {
        child.kill('SIGTERM')
      } catch {
        /* ignore */
      }
      fn(arg)
    }
    const timer = setTimeout(
      () => finish(reject, new Error('MCP stdio handshake timed out')),
      15_000,
    )
    const send = (msg) => child.stdin.write(JSON.stringify(msg) + '\n')
    child.stdout.on('data', (d) => {
      buf += d.toString()
      let idx
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx).trim()
        buf = buf.slice(idx + 1)
        if (!line) continue
        let msg
        try {
          msg = JSON.parse(line)
        } catch {
          continue
        }
        if (msg.id === 1 && msg.result) {
          send({ jsonrpc: '2.0', method: 'notifications/initialized' })
          send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
        } else if (msg.id === 2 && msg.result) {
          finish(
            resolve,
            (msg.result.tools ?? []).map((t) => t.name),
          )
        } else if (msg.error) {
          finish(reject, new Error(`MCP error: ${JSON.stringify(msg.error)}`))
        }
      }
    })
    child.stderr.on('data', () => {}) // the bin may log to stderr; ignore
    child.on('error', (err) => finish(reject, err))
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'clean-install-smoke', version: '0.0.0' },
      },
    })
  })
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

  // 2+3. Start the fake "Gateway-aux" listener (retry + sibling-port fallback
  //      so a just-finished e2e run's dying server can't false-fail the gate).
  let fakeBusyPorts = []
  try {
    const bound = await bindFakeService()
    fakeService = bound.srv
    fakePort = bound.port
    fakeBusyPorts = bound.busyPorts
  } catch (err) {
    fail(err?.message ?? String(err))
    return
  }
  log(`Fake service on :${fakePort} (returns 401 "Unauthorized" — mimics Gateway aux port)`)

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
  // Even though the fake port is "alive" (TCP), the CLI must reject it
  // because the HTTP signature probe sees non-Clawboo content.
  if (clawbooPort === fakePort) {
    fail(`CLI routed browser to fake :${fakePort} — port verification regressed`)
    return
  }
  // Fallback-mode guard: if the CLI attached to a port a FOREIGN process held
  // during fake-bind, we're either looking at a probe regression (it accepted
  // the squatter) or a stale Clawboo-shaped leftover server — either way the
  // fresh bundle was never exercised, so the run must not go green.
  if (fakeBusyPorts.includes(clawbooPort)) {
    fail(
      `CLI attached to :${clawbooPort}, a port a foreign process held during fake-bind — ` +
        `it should have spawned a fresh server (stale/foreign listener, or probe regression)`,
    )
    return
  }
  log(`✓ CLI correctly skipped fake :${fakePort}`)

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

  // 12. Test 5: spawn the bundled stdio MCP bin and call a tool (CLAWBOO_MCP
  //     attach surface) — proves an external runtime can spawn it from the tarball.
  const tasksBin = path.join(REPO_ROOT, 'apps/cli/dist/bin/tasks.js')
  let binPresent = true
  try {
    const st = await fs.stat(tasksBin)
    if (!st.isFile()) throw new Error('not a file')
  } catch {
    binPresent = false
    fail(`MCP stdio bin not found at ${tasksBin}. Run 'pnpm assemble' (after 'pnpm build').`)
  }
  if (binPresent) {
    const mcpDbDir = await fs.mkdtemp(path.join(os.tmpdir(), 'clawboo-mcp-bin-'))
    try {
      const tools = await mcpStdioListTools(tasksBin, mcpDbDir)
      if (!tools.includes('list_tasks')) {
        fail(`Stdio MCP bin tools/list did not include list_tasks: ${JSON.stringify(tools)}`)
      } else {
        log('✓ spawned the bundled stdio MCP bin (tasks) and listed its tools')
      }
    } catch (err) {
      fail(`Stdio MCP bin handshake failed: ${err?.message ?? err}`)
    } finally {
      await fs.rm(mcpDbDir, { recursive: true, force: true }).catch(() => {})
    }
  }

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
