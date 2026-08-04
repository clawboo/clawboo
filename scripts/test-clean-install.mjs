#!/usr/bin/env node
/**
 * scripts/test-clean-install.mjs
 *
 * End-to-end smoke test that simulates `npx clawboo` on a real user's machine
 * and asserts the PUBLISHED artifact reaches a working Clawboo dashboard.
 *
 * It packs `apps/cli` into a tarball and installs it into a throwaway directory
 * under the OS temp dir with a real `npm install`. Everything after that runs
 * against THAT install — never the repo build — so the `files` whitelist and the
 * published dependency closure are genuinely exercised: nothing can resolve
 * through a workspace symlink or the monorepo's hoisted `node_modules`, which is
 * exactly the difference between "works in the repo" and "works for a stranger".
 *
 * Guards these regression classes:
 *
 *   1. The bundled server must serve the SPA at the bare `/` (an Express 5
 *      SPA catch-all that doesn't match `/` returns "Cannot GET /").
 *
 *   2. The CLI must HTTP-verify a port is Clawboo before opening the browser:
 *      a TCP-only probe would mistake another service on a nearby port
 *      (an OpenClaw Gateway aux port, Chrome's --remote-debugging-port, etc.)
 *      for Clawboo and route the browser to an "Unauthorized" page.
 *
 *   3. The packed tarball must carry everything `npx clawboo` needs — every
 *      declared `bin`, the UI, the notices — and must not load a module that
 *      only resolves from the workspace (the static externals-vs-dependencies
 *      check).
 *
 *   4. Dispatching a task to a runtime must actually run: an agent run is the
 *      product's main path, and it should never be a publish-time unknown.
 *
 * Test scenario:
 *   1.  Refuse to run if a Clawboo dashboard already answers in the CLI's
 *       18790-18809 discovery window — the CLI would attach to it and every
 *       assertion below would silently test that server, not the tarball.
 *   2.  `pnpm pack` apps/cli, then `npm install <tarball>` into a fresh temp dir.
 *   3.  Assert the installed tree (bins + their npm shims, UI, notices).
 *   4.  Assert every external the installed bundles load is declared / builtin /
 *       documented-optional.
 *   5.  Bind a fake service that returns 401 "Unauthorized" on 18791 (with
 *       retry + sibling-port fallback inside the CLI's 18790-18809 scan
 *       window, so a just-finished e2e run's dying server can't false-fail
 *       the bind) — mimics OpenClaw Gateway's auxiliary port behavior.
 *   6.  Spawn the INSTALLED CLI in an isolated state dir with no env-var pins.
 *       The CLI's HTTP-signature probe must reject 18791 (wrong JSON shape) so
 *       Clawboo's own server picks 18790.
 *   7.  Assert the CLI prints a URL that is NOT :18791, and that the server on
 *       it wrote its api-port file under THIS run's isolated $HOME (i.e. it is
 *       the server we spawned, not one that was already there).
 *   8.  Curl the printed URL — must return Clawboo SPA HTML.
 *   9.  Curl a deep SPA route — must fall through to index.html.
 *   10. Curl /api/settings + /api/system/status — must return Clawboo JSON.
 *   11. Spawn the installed stdio MCP bin and complete a `tools/list` handshake.
 *   12. Create an agent + a board task and drive a real
 *       `POST /api/runtimes/clawboo-native/run` against a local
 *       OpenAI-compatible stub — the "an agent run can start" assertion.
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

import { checkBundleExternals } from './check-bundle-externals.mjs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const REPO_ROOT = path.resolve(__dirname, '..')
const CLI_PACKAGE_DIR = path.join(REPO_ROOT, 'apps/cli')
const IS_WINDOWS = process.platform === 'win32'

// Build artifacts `pnpm assemble` must have produced before we can pack.
const REQUIRED_BUILD_ARTIFACTS = [
  'dist/index.js',
  'dist/server.js',
  'dist/ui/index.html',
  'dist/bin/tasks.js',
  'dist/THIRD_PARTY_NOTICES.md',
]

// The CLI's dashboard-discovery scan window (mirrors apps/cli/src/index.ts).
const DISCOVERY_FIRST_PORT = 18790
const DISCOVERY_PORT_COUNT = 20
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
// The CLI polls for its own server for up to ~45 s before giving up (a cold
// Windows boot of the freshly-EXTRACTED bundle + better-sqlite3 binding gets
// scanned by Defender on first load). Our budget has to exceed the CLI's own, or
// we'd report a timeout the CLI was about to report better; when the CLI does
// give up it exits, which the wait loop notices immediately.
const READY_TIMEOUT_MS = 90_000
// /api/system/status does multiple I/O ops: filesystem checks for
// openclaw.json + .env, a 2-s probeGatewayPort fetch to :18789, plus
// the openclaw binary probe via which/where. On Windows CI runners the
// cumulative latency exceeded 5 s in practice. 20 s is a generous cap
// that still fails fast on real hangs.
const HTTP_TIMEOUT_MS = 20_000
// A real `npm install` of the tarball resolves the published dependency closure
// from the registry AND builds/downloads better-sqlite3's native binding. Cold
// Windows runners are the slow case.
const INSTALL_TIMEOUT_MS = 10 * 60_000
// One runtime dispatch against a local stub provider: no network, but it claims
// the task, opens an execution row, drives the harness, and reports up.
const DISPATCH_TIMEOUT_MS = 90_000
// The canned reply the stub provider streams back; the run's report-up summary
// must carry it, which proves the text came from the provider round-trip and
// not from some default.
const DISPATCH_MARKER = 'CLAWBOO_CLEAN_INSTALL_DISPATCH_OK'

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
let stubProvider = null
let cliProc = null
let tmpDir = null
let shadowBinDir = null
let packDir = null
let installDir = null
let clawbooPort = null
let cleanupRunning = false

async function cleanup() {
  cleanupRunning = true
  // Kill the DETACHED server first. Killing the launcher can cascade a SIGTERM
  // back to us on macOS, and if that lands before this line the server survives
  // the run — which the next run's "a Clawboo is already listening" preflight
  // then (correctly, but confusingly) fails on.
  if (clawbooPort) {
    await killByPort(clawbooPort)
  }
  if (cliProc && !cliProc.killed) {
    try {
      cliProc.kill('SIGTERM')
    } catch {
      /* ignore */
    }
  }
  for (const server of [fakeService, stubProvider]) {
    if (server) {
      // `close()` waits for open sockets, and the stub provider answers with
      // `Connection: keep-alive` — a socket the detached server still holds
      // would otherwise keep this pending long enough to eat the whole cleanup
      // budget, so the temp dirs below never get removed.
      server.closeAllConnections?.()
      await new Promise((resolve) => server.close(() => resolve()))
    }
  }
  for (const dir of [tmpDir, shadowBinDir, packDir, installDir]) {
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
// cascade can hit us on macOS). Swallow it while cleanup runs — exiting here
// would abandon the teardown mid-way and strand the server we spawned. Outside
// cleanup, honor whatever exitCode the assertions already set; don't get
// SIGTERM-amplified to 143.
process.on('SIGTERM', () => {
  if (cleanupRunning) return
  process.exit(process.exitCode ?? 0)
})

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** PIDs listening on `port` (POSIX only — returns [] where `lsof` is absent). */
async function listenersOn(port) {
  if (IS_WINDOWS) return []
  try {
    const out = await runCmd('lsof', ['-ti', `:${port}`])
    return out
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(Number)
      .filter((pid) => Number.isInteger(pid) && pid > 0)
  } catch {
    return [] // lsof might not exist
  }
}

/**
 * SIGTERM whatever listens on `port`, escalating to SIGKILL only when we own it.
 *
 * `escalateMs: 0` means "ask, don't insist" — used on the fake-listener bind
 * path, where the holder is *probably* a leftover from an aborted run but could
 * be an unrelated local service the developer cares about. SIGKILLing a
 * stranger's process to free a test port is not a trade this gate gets to make;
 * if the port stays busy we simply try the next candidate and, failing that,
 * name the holders in the error. The cleanup path DOES escalate, because there
 * the target is the server this run spawned.
 */
async function killByPort(port, escalateMs = 3_000) {
  // On Windows there's no `lsof`, so this is a no-op there — CI runners are
  // ephemeral, and on a dev box a stranded server is caught by the "a Clawboo
  // dashboard is already running" preflight, which names the port and says what
  // to do. A `netstat -ano` + `taskkill` parse here would be defensible but adds
  // moving parts to a script whose main job is asserting onboarding works.
  if (IS_WINDOWS) return
  for (const pid of await listenersOn(port)) {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      /* already gone */
    }
  }
  if (escalateMs <= 0) return
  // Escalate: a server that ignores SIGTERM (or dies slowly) would otherwise
  // outlive the run and block the next one at the preflight.
  const deadline = Date.now() + escalateMs
  for (;;) {
    const remaining = await listenersOn(port)
    if (remaining.length === 0 || Date.now() >= deadline) {
      for (const pid of remaining) {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {
          /* already gone */
        }
      }
      return
    }
    await new Promise((r) => setTimeout(r, 200))
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

/** Windows can't spawn a `.cmd` shim (npm/pnpm) without a shell — the same
 *  `shell: isWindows` posture the server's runtime installer uses. Quote each
 *  argument so a temp path with a space survives cmd.exe's parsing. */
function shellQuote(value) {
  return IS_WINDOWS && /\s/.test(value) ? `"${value}"` : value
}

/**
 * Run a build/packaging tool to completion. Resolves `{ code, stdout, stderr }`
 * — never rejects on a non-zero exit, so the caller reports a readable failure.
 */
function runTool(cmd, args, { cwd, timeoutMs = 120_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(
      IS_WINDOWS ? shellQuote(cmd) : cmd,
      IS_WINDOWS ? args.map(shellQuote) : args,
      {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: IS_WINDOWS,
        windowsHide: IS_WINDOWS,
        env: { ...process.env, npm_config_yes: 'true' },
      },
    )
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      try {
        // On Windows `shell: true` means `child` is cmd.exe, not npm/pnpm —
        // killing it would leave the real process tree running, still writing
        // into the temp dir that cleanup is about to remove. taskkill /T takes
        // the whole tree.
        if (IS_WINDOWS && child.pid) {
          spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
        } else {
          child.kill('SIGKILL')
        }
      } catch {
        /* ignore */
      }
      resolve({ code: null, stdout, stderr: `${stderr}\n[timed out after ${timeoutMs}ms]` })
    }, timeoutMs)
    child.stdout.on('data', (d) => {
      stdout += d.toString()
    })
    child.stderr.on('data', (d) => {
      stderr += d.toString()
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({ code: null, stdout, stderr: `${stderr}\n${String(err)}` })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
  })
}

async function pathExists(target) {
  try {
    await fs.access(target)
    return true
  } catch {
    return false
  }
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
        // SIGTERM only — see killByPort. The usual holder is a dying e2e server
        // that releases in milliseconds; anything that survives a SIGTERM might
        // not be ours to kill, so we move to the next candidate instead.
        await killByPort(port, 0)
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
  if (!IS_WINDOWS) {
    holders = await runCmd('lsof', ['-nP', '-iTCP:18790-18809', '-sTCP:LISTEN']).catch(() => '')
  }
  throw new Error(
    `could not bind a fake listener on any of :${FAKE_PORT_CANDIDATES.join(', :')} ` +
      `within ${FAKE_BIND_RETRY_MS}ms (${lastErr?.message ?? 'EADDRINUSE'}).` +
      (holders.trim() ? `\nListeners in the 18790-18809 window:\n${holders.trim()}` : ''),
  )
}

/**
 * Ports in the CLI's discovery window that ALREADY answer with the Clawboo
 * `/api/settings` signature.
 *
 * The CLI is supposed to attach to a dashboard that is already running, so a
 * stray Clawboo (a `pnpm dev` server, a leftover from an earlier gate run)
 * silently turns every assertion below into a test of THAT server — the freshly
 * packed tarball would never boot and the run would go green on nothing. Cheap
 * to detect, so detect it and say so.
 */
async function findExistingClawbooPorts() {
  const ports = Array.from({ length: DISCOVERY_PORT_COUNT }, (_, i) => DISCOVERY_FIRST_PORT + i)
  const hits = await Promise.all(
    ports.map(async (port) => {
      try {
        const res = await httpGet(`http://127.0.0.1:${port}/api/settings`, { timeout: 1_500 })
        if (!res.ok) return null
        const body = JSON.parse(res.text)
        const isClawboo = typeof body.gatewayUrl === 'string' && typeof body.hasToken === 'boolean'
        return isClawboo ? port : null
      } catch {
        return null // closed port / not JSON / not Clawboo
      }
    }),
  )
  return hits.filter((p) => p !== null)
}

/**
 * A minimal OpenAI-compatible chat-completions endpoint. The native runtime's
 * keyless `ollama` provider rides the same OpenAI client with a base-URL
 * override, so pointing `OLLAMA_BASE_URL` here gives the dispatch assertion a
 * real provider round-trip with no key, no network, and no model download.
 * Streams the SSE shape the client parses: content delta → finish → usage →
 * [DONE].
 */
function createStubProvider() {
  const state = { chatCompletions: 0 }
  const server = createServer((req, res) => {
    // Drain the request body before replying — the OpenAI client sends a POST
    // body and an unread stream keeps the socket half-open.
    req.resume()
    req.on('end', () => {
      if (req.method === 'POST' && (req.url ?? '').endsWith('/chat/completions')) {
        state.chatCompletions++
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        })
        const base = { id: 'clean-install-stub', object: 'chat.completion.chunk', created: 0 }
        const send = (payload) => res.write(`data: ${JSON.stringify({ ...base, ...payload })}\n\n`)
        send({
          choices: [
            {
              index: 0,
              delta: { role: 'assistant', content: DISPATCH_MARKER },
              finish_reason: null,
            },
          ],
        })
        send({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
        send({ choices: [], usage: { prompt_tokens: 8, completion_tokens: 4 } })
        res.write('data: [DONE]\n\n')
        res.end()
        return
      }
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: `stub provider: unhandled ${req.method} ${req.url}` }))
    })
  })
  return { server, state }
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

/** POST JSON and parse the response; `json` is null when the body isn't JSON. */
async function httpPostJson(url, body, opts = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeout ?? HTTP_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    const text = await res.text()
    let json = null
    try {
      json = JSON.parse(text)
    } catch {
      /* caller reports the raw text */
    }
    return { ok: res.ok, status: res.status, text, json }
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

// ─── Pack + install ──────────────────────────────────────────────────────────

/**
 * `pnpm pack` apps/cli, then `npm install <tarball>` into a fresh directory
 * under the OS temp dir.
 *
 * `pnpm pack` (not `npm pack`) because `pnpm changeset publish` is what actually
 * publishes: pnpm rewrites `workspace:` protocol specifiers into concrete
 * versions in the packed manifest, so the tarball here is the one users get.
 * `npm install` (not `pnpm add`) because npm's hoisted layout is what an
 * `npx clawboo` user resolves modules through.
 *
 * Returns the installed package directory, or null after reporting a failure.
 */
async function packAndInstall() {
  packDir = await fs.mkdtemp(path.join(os.tmpdir(), 'clawboo-pack-'))
  log('packing apps/cli (pnpm pack)...')
  const packed = await runTool('pnpm', ['pack', '--pack-destination', packDir], {
    cwd: CLI_PACKAGE_DIR,
    timeoutMs: 180_000,
  })
  if (packed.code !== 0) {
    fail(`pnpm pack failed (exit ${packed.code})\n${packed.stderr || packed.stdout}`)
    return null
  }
  const tarballs = (await fs.readdir(packDir)).filter((f) => f.endsWith('.tgz'))
  if (tarballs.length !== 1) {
    fail(`expected exactly one tarball in ${packDir}, found ${JSON.stringify(tarballs)}`)
    return null
  }
  const tarball = path.join(packDir, tarballs[0])
  const { size } = await fs.stat(tarball)
  log(`packed ${tarballs[0]} (${(size / 1024 / 1024).toFixed(1)} MB)`)

  // A fresh directory under the OS temp dir: no workspace `node_modules` above
  // it, so every module the CLI loads must come from the tarball's own declared
  // dependency closure.
  installDir = await fs.mkdtemp(path.join(os.tmpdir(), 'clawboo-install-'))
  await fs.writeFile(
    path.join(installDir, 'package.json'),
    JSON.stringify(
      { name: 'clawboo-clean-install-host', version: '0.0.0', private: true },
      null,
      2,
    ) + '\n',
  )
  log(`installing the tarball into ${installDir} (npm install)...`)
  const installed = await runTool(
    'npm',
    ['install', tarball, '--no-audit', '--no-fund', '--loglevel', 'error'],
    { cwd: installDir, timeoutMs: INSTALL_TIMEOUT_MS },
  )
  if (installed.code !== 0) {
    fail(`npm install of the tarball failed (exit ${installed.code})\n${installed.stderr}`)
    return null
  }
  const packageDir = path.join(installDir, 'node_modules', 'clawboo')
  if (!(await pathExists(packageDir))) {
    fail(`npm install reported success but ${packageDir} does not exist`)
    return null
  }
  log(`installed clawboo → ${packageDir}`)
  return packageDir
}

/**
 * The installed tree must carry everything the published manifest promises:
 * every `bin` target, the UI, the MCP stdio bins, the third-party notices, and
 * the `.bin` shims npm generated from the `bin` map.
 */
async function assertInstalledTree(packageDir) {
  const pkg = JSON.parse(await fs.readFile(path.join(packageDir, 'package.json'), 'utf8'))
  let ok = true

  // `bin` is either a map or a bare path (which npm names after the package).
  const bins = typeof pkg.bin === 'string' ? { [pkg.name]: pkg.bin } : (pkg.bin ?? {})
  // Guard the loop's own premise: with no `bin` at all it would iterate zero
  // times and report success, so a manifest that lost its `bin` map (no `npx
  // clawboo`, no MCP commands) would sail through this check.
  if (Object.keys(bins).length === 0) {
    fail('the published manifest declares no "bin" entries — `npx clawboo` would not exist')
    return false
  }
  for (const [binName, relPath] of Object.entries(bins)) {
    const target = path.join(packageDir, relPath)
    if (!(await pathExists(target))) {
      fail(`published "bin" entry '${binName}' points at ${relPath}, which the tarball omits`)
      ok = false
    }
    // npm materializes one shim per bin; a missing shim means `npx clawboo` (or
    // an MCP client spawning `clawboo-mcp-tasks`) resolves to nothing.
    const shim = path.join(installDir, 'node_modules', '.bin', binName)
    const shimPresent =
      (await pathExists(shim)) || (IS_WINDOWS && (await pathExists(`${shim}.cmd`)))
    if (!shimPresent) {
      fail(`npm did not create a node_modules/.bin shim for '${binName}'`)
      ok = false
    }
  }

  for (const rel of ['dist/ui/index.html', 'dist/THIRD_PARTY_NOTICES.md']) {
    if (!(await pathExists(path.join(packageDir, rel)))) {
      fail(`the tarball is missing ${rel} (check apps/cli "files" and scripts/assemble-cli.sh)`)
      ok = false
    }
  }

  if (ok) {
    log(
      `✓ installed tree carries every published bin (${Object.keys(bins).length}), ` +
        'the UI, and the third-party notices',
    )
  }
  return ok
}

// ─── Runtime dispatch ────────────────────────────────────────────────────────

/**
 * The "an agent run can start" assertion: create a native agent routed at the
 * local stub provider, create a board task, then drive
 * `POST /api/runtimes/clawboo-native/run` to a terminal `done`.
 *
 * This is the product's main path (assign a task → it runs), and it exercises
 * the whole server-side chain out of the installed tarball: the runtime
 * registry, the adapter contract, the executor runner's claim → execution row →
 * event stream → report-up, and the provider client. `kind: 'research'` keeps
 * isolation at `none`, so it needs no git repo or worktree.
 */
async function assertRuntimeDispatch(baseUrl, stubState) {
  const agent = await httpPostJson(`${baseUrl}/api/agents`, {
    name: 'Clean Install Smoke',
    sourceId: 'clawboo-native',
    execConfig: {
      // Keyless routing: the native harness treats `ollama` as an
      // OpenAI-compatible endpoint at OLLAMA_BASE_URL with no credential.
      primaryProvider: 'ollama',
      primaryModel: 'clawboo-clean-install-stub',
      // No MCP spine for this run — the handshake is covered separately and a
      // dispatch smoke should not depend on the broker being reachable.
      tools: { memory: false, tools: false, tasks: false, teamchat: false },
      maxTurns: 2,
    },
  })
  const agentId = agent.json?.agent?.id
  if (!agentId) {
    fail(`POST /api/agents → HTTP ${agent.status}: ${agent.text.slice(0, 300)}`)
    return false
  }

  const task = await httpPostJson(`${baseUrl}/api/board`, {
    title: 'clean-install smoke: dispatch a runtime run',
    description: 'Reply with a one-line confirmation. No tools needed.',
  })
  const taskId = task.json?.task?.id
  if (!taskId) {
    fail(`POST /api/board → HTTP ${task.status}: ${task.text.slice(0, 300)}`)
    return false
  }

  const run = await httpPostJson(
    `${baseUrl}/api/runtimes/clawboo-native/run`,
    {
      taskId,
      assigneeAgentId: agentId,
      // research ⇒ isolation 'none': no repo, no worktree, no git.
      kind: 'research',
      // Keep the prompt deterministic — a fresh install has no memory anyway.
      disableMemoryAutoInject: true,
    },
    { timeout: DISPATCH_TIMEOUT_MS },
  )
  if (!run.ok || !run.json?.ok) {
    fail(
      `POST /api/runtimes/clawboo-native/run → HTTP ${run.status}: ${run.text.slice(0, 500)}\n` +
        '    (an agent run could not start from the installed tarball)',
    )
    return false
  }
  if (run.json.doneReason !== 'success' || run.json.status !== 'done') {
    fail(
      `runtime dispatch did not complete cleanly: doneReason=${run.json.doneReason} ` +
        `status=${run.json.status} summary=${JSON.stringify(run.json.summary)}`,
    )
    return false
  }
  if (!String(run.json.summary ?? '').includes(DISPATCH_MARKER)) {
    fail(
      `the run's report-up summary does not carry the stub provider's reply ` +
        `(expected to contain ${DISPATCH_MARKER}): ${JSON.stringify(run.json.summary)}`,
    )
    return false
  }
  if (stubState.chatCompletions < 1) {
    fail('the run reported success but never called the stub provider — the round-trip was faked')
    return false
  }

  // The board is the durable record: a run that "succeeded" without moving the
  // task would be a silent half-failure.
  const board = await httpGet(`${baseUrl}/api/board/${taskId}`)
  let boardStatus = null
  try {
    boardStatus = JSON.parse(board.text)?.task?.status
  } catch {
    /* reported below */
  }
  if (boardStatus !== 'done') {
    fail(`task ${taskId} is '${boardStatus}' on the board after a successful run, expected 'done'`)
    return false
  }

  log(
    `✓ dispatched a board task to clawboo-native and it ran to done ` +
      `(execId ${run.json.execId}, ${stubState.chatCompletions} provider call(s))`,
  )
  return true
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  // 1. Verify `pnpm assemble` has run — we pack what it produced.
  for (const rel of REQUIRED_BUILD_ARTIFACTS) {
    if (!(await pathExists(path.join(CLI_PACKAGE_DIR, rel)))) {
      fail(`missing build artifact apps/cli/${rel}. Run \`pnpm assemble\` first.`)
      return
    }
  }

  // 2. Nothing may already be answering as Clawboo in the discovery window —
  //    the CLI would (correctly) attach to it and every assertion below would
  //    silently test that server instead of the packed tarball.
  const preexisting = await findExistingClawbooPorts()
  if (preexisting.length > 0) {
    fail(
      `a Clawboo dashboard is already running on :${preexisting.join(', :')} — the CLI would ` +
        'attach to it instead of booting the packed tarball, so this gate cannot prove anything. ' +
        'Stop it (e.g. the `pnpm dev` server or a leftover from an aborted run) and re-run.',
    )
    return
  }

  // 3. Pack + install into a throwaway dir (no workspace symlinks in sight).
  const packageDir = await packAndInstall()
  if (!packageDir) return
  const cliPath = path.join(packageDir, 'dist', 'index.js')
  const tasksBin = path.join(packageDir, 'dist', 'bin', 'tasks.js')

  // 4. The installed tree must carry everything the manifest promises.
  if (!(await assertInstalledTree(packageDir))) return

  // 5. Static check: every module the installed bundles still load must be
  //    declared, a Node builtin, or a documented optional external. This is the
  //    dependency-closure half of the packaging guarantee — the boot below only
  //    exercises what a fresh install happens to touch, never the lazy imports.
  const externals = await checkBundleExternals({
    packageDir,
    log: (msg) => log(`externals: ${msg}`),
  })
  if (!externals.ok) {
    for (const err of externals.errors) fail(err)
    return
  }
  log('✓ the installed bundles load nothing beyond their declared dependency closure')

  // 6. Start the fake "Gateway-aux" listener (retry + sibling-port fallback
  //    so a just-finished e2e run's dying server can't false-fail the gate).
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

  // 7. Start the stub provider on an ephemeral port, before the CLI spawns, so
  //    its URL can ride into the server's env.
  const stub = createStubProvider()
  stubProvider = stub.server
  await new Promise((resolve, reject) => {
    stubProvider.once('error', reject)
    stubProvider.listen(0, '127.0.0.1', resolve)
  })
  const stubBaseUrl = `http://127.0.0.1:${stubProvider.address().port}/v1`
  log(`Stub OpenAI-compatible provider on ${stubBaseUrl}`)

  // 8. Create isolated state dir + isolated $HOME so the developer's real
  //    ~/.openclaw/ is never touched.
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'clawboo-clean-install-'))
  await fs.mkdir(path.join(tmpDir, '.openclaw', 'clawboo'), { recursive: true })
  log(`Isolated state: ${tmpDir}`)

  // 9. Build a shadow PATH that includes node + npm + which (Clawboo needs
  //    them) but NOT `open` / `xdg-open` — that way the CLI's browser-open
  //    fails silently and we don't get a real browser launch during tests.
  //
  //    Windows: symlinking system binaries requires admin in some setups,
  //    and `start` (the Windows browser-open shim) on a headless CI runner
  //    won't open anything anyway. Skip the shadow PATH on Windows and let
  //    the CLI inherit the system PATH.
  const useShadowPath = !IS_WINDOWS
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

  // 10. Spawn the INSTALLED CLI, from the install dir (what a user's shell does).
  log(`Booting the installed CLI: ${cliPath}`)
  cliProc = spawn('node', [cliPath], {
    cwd: installDir,
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
      // Points the native runtime's keyless `ollama` provider at the local stub
      // so the dispatch assertion needs no API key and no network.
      OLLAMA_BASE_URL: stubBaseUrl,
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

  // 11. Wait for the CLI to print an "opened at http://localhost:<port>" URL.
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

  // The server writes its listening port to `<clawboo home>/api-port.txt`, and
  // its home comes from the isolated $HOME we spawned it with. If the file is
  // missing or disagrees, the CLI attached to some OTHER Clawboo instead of
  // booting the tarball, and nothing below would be testing the new bundle.
  // (Structural, so it survives any wording change in the CLI's banner.)
  const apiPortFile = path.join(tmpDir, '.clawboo', 'api-port.txt')
  let recordedPort = null
  try {
    recordedPort = Number((await fs.readFile(apiPortFile, 'utf8')).trim())
  } catch {
    /* reported below */
  }
  if (recordedPort !== clawbooPort) {
    fail(
      `the dashboard on :${clawbooPort} is not the server we spawned — ` +
        `${apiPortFile} says ${recordedPort ?? 'nothing'}. The CLI attached to a foreign ` +
        'Clawboo instance, so the packed tarball was never booted.',
    )
    return
  }
  log(`✓ the dashboard on :${clawbooPort} is the server this run spawned (api-port.txt agrees)`)

  // 12. Test 1: GET / returns SPA HTML
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

  // 13. Test 2: deep SPA route falls through to index.html
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

  // 14. Test 3: /api/settings returns Clawboo JSON
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

  // 15. Test 4: /api/system/status returns object with expected keys
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

  // 16. Test 5: spawn the INSTALLED stdio MCP bin and call a tool (CLAWBOO_MCP
  //     attach surface) — proves an external runtime can spawn it from the tarball.
  const mcpDbDir = await fs.mkdtemp(path.join(os.tmpdir(), 'clawboo-mcp-bin-'))
  try {
    const tools = await mcpStdioListTools(tasksBin, mcpDbDir)
    if (!tools.includes('list_tasks')) {
      fail(`Stdio MCP bin tools/list did not include list_tasks: ${JSON.stringify(tools)}`)
      return
    }
    log('✓ spawned the installed stdio MCP bin (tasks) and listed its tools')
  } catch (err) {
    fail(`Stdio MCP bin handshake failed: ${err?.message ?? err}`)
    return
  } finally {
    await fs.rm(mcpDbDir, { recursive: true, force: true }).catch(() => {})
  }

  // 17. Test 6: an agent run can actually start from the installed tarball.
  if (!(await assertRuntimeDispatch(openedUrl, stub.state))) return

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

// Cleanup runs as a fire-and-forget detached chain, capped at 15s — enough to
// also remove the throwaway npm install tree (a few thousand files) without
// hanging the gate. Whatever doesn't finish in that window is "good enough":
// the detached server gets reaped by the OS when its parent exits, and the temp
// dirs are under the OS temp dir.
const cleanupDone = Promise.race([cleanup(), new Promise((resolve) => setTimeout(resolve, 15_000))])

// Set the exit code IMMEDIATELY so any signal (SIGTERM from the OS or
// detached server's death cascade) gets the right code.
process.exitCode = succeeded ? 0 : 1
await cleanupDone
log(`Done (total ${Date.now() - startedAt}ms)`)
process.exit(process.exitCode)
