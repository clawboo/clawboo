// One browser per agent, so two Boos can hold different logins on the same site.
//
// WHY A PROCESS AND NOT A CONTEXT
//
// The obvious design is one server with a browser context per caller, and it is
// not reachable with the two connectors that ship. playwright-mcp derives its
// default profile from the client's working directory and refuses a second
// instance against a profile already in use; chrome-devtools-mcp has no HTTP
// transport at all, so it cannot take a second client. The one cheap option,
// `--isolated` over HTTP, keeps the profile in memory, which is exactly the
// durability this exists to provide. So: a child per agent with its own profile
// directory, and a hard ceiling to pay for it.
//
// DURABILITY IS WHAT COSTS. Isolation on its own is cheap. Persisting each
// agent's cookies across restarts is what forces a real profile on disk and
// therefore a real process, and it is the one decision here still cheap to
// reverse.
//
// WHAT THIS DELIBERATELY DOES NOT OWN
//
// The canonical `live` entry in `supervisor` stays exactly as it was: it owns
// the descriptors, the `connectors` row, specHash/toolsHash, the grant re-pin,
// the boot sweep and everything that reads them. A per-agent child is an
// execution target and nothing else. That is what keeps the connector id, the
// tool names, the grant pins and the graph identical to before, and it is why
// this needs no migration.

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { resolveClawbooDir } from '@clawboo/config'
import { createLogger } from '@clawboo/logger'
import {
  connectorChildEnv,
  ConnectorHandshakeError,
  connectStdioConnector,
  type ConnectorSession,
} from '@clawboo/mcp'

import { killProcessTreeByPid } from '../runtimes/killTree'
import { registerConnectorPid, unregisterConnectorPid } from '../runtimes/subprocess'
import { resolveConnectorCredentials, type DeclaredInput } from './credentials'
import { forgetConnectorPid, recordConnectorPid } from './pidFile'
import { planConnectorSpawn } from './spawnPlan'

const log = createLogger('agent-browsers')

/**
 * How many agent browsers may exist at once.
 *
 * A ceiling is not optional. Every agent is auto-granted every browser connector
 * (`ensureBrowserGrantsForAgent`), so the population is the FLEET, not the
 * agents someone chose to give a browser to. At roughly 400MB resident each, a
 * board run that fans out to eight Boos would open eight headed browsers within
 * seconds, well inside any idle timeout: a reaper bounds the tail, never the
 * peak. Only a cap bounds the peak.
 */
const MAX_AGENT_BROWSERS = Number(process.env['CLAWBOO_MAX_AGENT_BROWSERS']) || 4

/** How long an untouched browser is kept before it is closed. */
const IDLE_TTL_MS = Number(process.env['CLAWBOO_AGENT_BROWSER_IDLE_MS']) || 10 * 60_000

/** How long a queued call waits for a slot before giving the model an answer. */
const QUEUE_TIMEOUT_MS = 60_000

export interface AgentBrowserSpawn {
  slug: string
  command: string
  args: string[]
  profileFlag: string
  authInputs?: readonly DeclaredInput[]
}

interface AgentBrowser {
  session: ConnectorSession
  pid: number | null
  profileDir: string
  /** In-flight calls. A browser with none is QUIESCENT and may be evicted. */
  calls: number
  lastUsedAt: number
  idleTimer: NodeJS.Timeout | null
}

/** connectorId then agentId. */
const browsers = new Map<string, Map<string, AgentBrowser>>()

/**
 * Creates in flight, keyed by connector AND agent.
 *
 * Keyed by both on purpose. The canonical registry keys its in-flight map by
 * connector alone, which is right when there is one session to share; reusing
 * that shape here would collapse two agents' first calls onto ONE browser under
 * a race, silently reinstating the bug this module exists to remove, in the one
 * case no test would think to look at.
 */
const creating = new Map<string, Promise<AgentBrowser>>()

/** Callers waiting for a slot, oldest first. */
const waiting: { resolve: () => void; timer: NodeJS.Timeout }[] = []

const keyOf = (connectorId: string, agentId: string): string => `${connectorId}::${agentId}`

/**
 * The profile directory for one agent.
 *
 * Hashed for the same reason frames are: an agent id arrives from the database
 * and from the OpenClaw sync, and neither constrains it to characters that are
 * safe in a path. Hashing removes the question rather than answering it.
 */
export function profileDirFor(slug: string, agentId: string): string {
  const stem = createHash('sha256').update(agentId).digest('hex').slice(0, 16)
  return path.join(resolveClawbooDir(), 'browser-profiles', slug, stem)
}

/**
 * The child's working directory, which is a containment boundary rather than a
 * detail.
 *
 * playwright-mcp bounds `browser_file_upload` to the child's cwd, and the
 * canonical connect path never sets one, so a child inherits the SERVER's cwd:
 * the repository. Pointing each agent's child at its own empty scratch directory
 * is what stops one agent's browser being asked to upload another agent's
 * profile, whose cookie database is decryptable offline because both bundled
 * browsers launch with `--password-store=basic`.
 */
function scratchDirFor(slug: string, agentId: string): string {
  return path.join(profileDirFor(slug, agentId), 'scratch')
}

function browsersFor(connectorId: string): Map<string, AgentBrowser> {
  const existing = browsers.get(connectorId)
  if (existing) return existing
  const fresh = new Map<string, AgentBrowser>()
  browsers.set(connectorId, fresh)
  return fresh
}

function totalOpen(): number {
  let n = 0
  for (const perAgent of browsers.values()) n += perAgent.size
  return n
}

/**
 * Slots granted but not yet filled.
 *
 * `totalOpen()` alone counts browsers that EXIST, and a browser does not exist
 * until `spawnFor` records it — which is on the far side of
 * `connectStdioConnector`, i.e. after `npx` has been fetched and a cold Chromium
 * has launched against an empty profile. That window is seconds wide, and every
 * caller inside it reads the same stale count. A board fan-out where each agent's
 * first browser call lands together therefore put ALL of them past a cap of four,
 * each launching a real Chromium: the exact memory exhaustion the cap exists to
 * prevent, arrived at through the cap's own check.
 *
 * Counting a grant at the moment it is GRANTED closes it. The reservation is held
 * across the spawn and released only once the browser is in `browsers`, so there
 * is no instant in which a slot is counted by neither.
 */
let reserved = 0

/** Slots in use: browsers that exist, plus browsers on their way. */
function capacityUsed(): number {
  return totalOpen() + reserved
}

/** The least recently used browser with nothing in flight, or null. */
function oldestQuiescent(): { connectorId: string; agentId: string } | null {
  let best: { connectorId: string; agentId: string; at: number } | null = null
  for (const [connectorId, perAgent] of browsers) {
    for (const [agentId, browser] of perAgent) {
      if (browser.calls > 0) continue
      if (!best || browser.lastUsedAt < best.at) {
        best = { connectorId, agentId, at: browser.lastUsedAt }
      }
    }
  }
  return best ? { connectorId: best.connectorId, agentId: best.agentId } : null
}

/**
 * Close one agent's browser and let go of its process.
 *
 * `session.close()` first, then the tree. The graceful path is what flushes
 * cookies: Chromium writes its cookie database on shutdown, and killing it
 * outright is how a durable profile quietly stops being durable. The tree kill
 * signals SIGTERM before it escalates, so a connector with no close tool of its
 * own still gets a chance to write.
 */
export async function closeAgentBrowser(connectorId: string, agentId: string): Promise<void> {
  const perAgent = browsers.get(connectorId)
  const browser = perAgent?.get(agentId)
  if (!perAgent || !browser) return
  perAgent.delete(agentId)
  if (perAgent.size === 0) browsers.delete(connectorId)
  if (browser.idleTimer) clearTimeout(browser.idleTimer)
  await browser.session.close().catch(() => {})
  if (typeof browser.pid === 'number') {
    killProcessTreeByPid(browser.pid)
    unregisterConnectorPid(browser.pid)
    forgetConnectorPid(browser.pid)
  }
  drainWaiting()
}

/**
 * Close every browser for a connector.
 *
 * Called by Disconnect and by the test reset. It must be reachable even when the
 * canonical entry is already gone: that entry is removed by its own `onClose` on
 * any crash or external kill, and a sweep that ran only for a live connector
 * would leave N headed browsers that no route could address.
 */
export async function closeAllForConnector(connectorId: string): Promise<void> {
  const pending = [...creating.entries()]
    .filter(([key]) => key.startsWith(`${connectorId}::`))
    .map(([, p]) => p.catch(() => undefined))
  await Promise.all(pending)
  const perAgent = browsers.get(connectorId)
  if (!perAgent) return
  await Promise.all([...perAgent.keys()].map((agentId) => closeAgentBrowser(connectorId, agentId)))
}

/** Close everything. The test seam, and the shutdown path. */
export async function closeAllAgentBrowsers(): Promise<void> {
  await Promise.all([...browsers.keys()].map((id) => closeAllForConnector(id)))
  browsers.clear()
  creating.clear()
  // The counter is module state like the maps, so a suite that tore down mid-spawn
  // would otherwise leak a reservation into the next one and starve it.
  reserved = 0
}

/** Wake queued callers, now that a slot may exist. */
function drainWaiting(): void {
  while (waiting.length > 0 && capacityUsed() < MAX_AGENT_BROWSERS) {
    const next = waiting.shift()
    if (!next) return
    clearTimeout(next.timer)
    // CLAIMED HERE, not by the woken caller. `resolve()` only schedules the
    // continuation, so the loop condition would otherwise re-read an unchanged
    // count and wake every waiter on a single freed slot.
    reserved += 1
    next.resolve()
  }
}

/**
 * Wait until the fleet is under the cap.
 *
 * Evicts an idle browser when there is one, and otherwise QUEUES rather than
 * failing: a call arriving while every browser is mid-navigation is almost
 * always a board fan-out, and making the model retry is worse than making it
 * wait a moment. Bounded, so one wedged browser cannot hang a run forever.
 */
async function waitForSlot(): Promise<void> {
  if (capacityUsed() < MAX_AGENT_BROWSERS) {
    reserved += 1
    return
  }
  const idle = oldestQuiescent()
  if (idle) {
    await closeAgentBrowser(idle.connectorId, idle.agentId)
    reserved += 1
    return
  }
  // The queued path claims in `drainWaiting` at the moment it is woken, so a
  // caller that reaches here and later resumes must NOT claim again. A caller
  // that times out never claimed, which is why the reject path needs no release.
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      const i = waiting.findIndex((w) => w.timer === timer)
      if (i >= 0) waiting.splice(i, 1)
      reject(
        new Error(
          `every browser is busy (${MAX_AGENT_BROWSERS} open). Try again shortly, or run fewer agents in parallel.`,
        ),
      )
    }, QUEUE_TIMEOUT_MS)
    timer.unref()
    waiting.push({ resolve, timer })
  })
}

function armIdleTimer(connectorId: string, agentId: string, browser: AgentBrowser): void {
  if (browser.idleTimer) clearTimeout(browser.idleTimer)
  const timer = setTimeout(() => {
    // Re-checked rather than trusted: a call may have started since the timer
    // was armed, and closing mid-navigation would fail it.
    if (browser.calls > 0) {
      armIdleTimer(connectorId, agentId, browser)
      return
    }
    void closeAgentBrowser(connectorId, agentId)
  }, IDLE_TTL_MS)
  // Unref'd so an idle browser never holds the process open at shutdown.
  timer.unref()
  browser.idleTimer = timer
}

async function spawnFor(
  spec: AgentBrowserSpawn,
  connectorId: string,
  agentId: string,
): Promise<AgentBrowser> {
  await waitForSlot()
  // HOLD THE RESERVATION ACROSS THE WHOLE SPAWN, and release it in a `finally`
  // that covers every throw in it: the unresolved-command error, the handshake
  // rethrow, an EACCES from either mkdir. A leaked reservation is strictly worse
  // than the race being fixed here, because the counter only ever climbs — once
  // it reaches the cap every later call queues and then fails with "every browser
  // is busy" while zero browsers are open, and nothing short of a restart
  // recovers it.
  //
  // On success the release runs AFTER the browser is in `browsers`, so it is
  // already counted by `totalOpen()` and no slot is momentarily uncounted. On
  // failure the slot genuinely frees, and `drainWaiting` is what stops a queued
  // caller sitting out its full timeout beside it — a failed spawn emits no close
  // event, so nothing else would wake it.
  try {
    return await spawnReservedBrowser(spec, connectorId, agentId)
  } finally {
    reserved -= 1
    drainWaiting()
  }
}

/** The spawn itself. Runs holding a reservation; see {@link spawnFor}. */
async function spawnReservedBrowser(
  spec: AgentBrowserSpawn,
  connectorId: string,
  agentId: string,
): Promise<AgentBrowser> {
  const profileDir = profileDirFor(spec.slug, agentId)
  const scratchDir = scratchDirFor(spec.slug, agentId)
  fs.mkdirSync(profileDir, { recursive: true })
  fs.mkdirSync(scratchDir, { recursive: true })

  const plan = planConnectorSpawn({ command: spec.command, args: spec.args })
  if (plan.unresolved) throw new Error(`cannot resolve ${spec.command}`)

  // APPENDED AFTER the plan, and deliberately absent from the hashed spec. The
  // digest covers transport, command and args as the CATALOG states them, and a
  // profile directory is clawboo's own isolation mechanism rather than something
  // the operator chose. Hashing it would give every agent a different specHash
  // for one row under UNIQUE(slug), and every other agent's pin would then read
  // as spec drift with no way to recover, because the boot restore skips the
  // re-pin.
  const args = [...plan.args, spec.profileFlag, profileDir]

  let session: ConnectorSession
  try {
    session = await connectStdioConnector({
      command: plan.command,
      args,
      cwd: scratchDir,
      onSpawn: (spawned) => {
        recordConnectorPid({
          pid: spawned,
          slug: spec.slug,
          startedAt: Date.now(),
          command: plan.command,
        })
      },
      env: connectorChildEnv({
        declared: resolveConnectorCredentials(spec.slug, spec.authInputs ?? []),
      }),
    })
  } catch (err) {
    // A handshake failure still SPAWNED something. This path is likelier here
    // than on the canonical connect: it runs inside a tool call, against a fresh
    // profile directory, and a profile lock or a cold npx can hold the handshake
    // past its budget.
    if (err instanceof ConnectorHandshakeError && typeof err.pid === 'number') {
      killProcessTreeByPid(err.pid)
      forgetConnectorPid(err.pid)
    }
    throw err
  }

  const pid = session.pid
  registerConnectorPid(pid)

  const browser: AgentBrowser = {
    session,
    pid,
    profileDir,
    calls: 0,
    lastUsedAt: Date.now(),
    idleTimer: null,
  }

  // One agent's browser dying is NOT the connector being down. The canonical
  // entry owns that verdict, and marking it here would take the tools away from
  // every other agent because one Boo's Chrome crashed.
  session.onClose(() => {
    const perAgent = browsers.get(connectorId)
    if (perAgent?.get(agentId) === browser) {
      perAgent.delete(agentId)
      if (perAgent.size === 0) browsers.delete(connectorId)
    }
    if (browser.idleTimer) clearTimeout(browser.idleTimer)
    if (typeof browser.pid === 'number') {
      unregisterConnectorPid(browser.pid)
      forgetConnectorPid(browser.pid)
    }
    drainWaiting()
  })

  browsersFor(connectorId).set(agentId, browser)
  armIdleTimer(connectorId, agentId, browser)
  log.info({ slug: spec.slug, agentId, open: totalOpen() }, 'opened a browser for an agent')
  return browser
}

/**
 * The session this agent's browser calls should go to.
 *
 * `create: false` is a LOOKUP, and it exists because one caller must never be
 * able to start a browser: the Browser panel photographs what is already on
 * screen, and a panel opening must not be what puts a headed Chrome on someone's
 * desktop. Only an agent's own tool call creates.
 */
export async function agentBrowserSession(
  spec: AgentBrowserSpawn,
  connectorId: string,
  agentId: string,
  opts: { create: boolean },
): Promise<ConnectorSession | null> {
  const existing = browsers.get(connectorId)?.get(agentId)
  if (existing) return existing.session
  if (!opts.create) return null

  const key = keyOf(connectorId, agentId)
  const pending = creating.get(key)
  if (pending) return (await pending).session

  const attempt = spawnFor(spec, connectorId, agentId).finally(() => creating.delete(key))
  creating.set(key, attempt)
  return (await attempt).session
}

/** Mark a call in flight, so eviction and the idle timer can see it. */
export function noteCallStart(connectorId: string, agentId: string): void {
  const browser = browsers.get(connectorId)?.get(agentId)
  if (!browser) return
  browser.calls += 1
  browser.lastUsedAt = Date.now()
}

/** Mark a call finished. Always paired with `noteCallStart` in a `finally`. */
export function noteCallEnd(connectorId: string, agentId: string): void {
  const browser = browsers.get(connectorId)?.get(agentId)
  if (!browser) return
  browser.calls = Math.max(0, browser.calls - 1)
  browser.lastUsedAt = Date.now()
  if (browser.calls === 0) armIdleTimer(connectorId, agentId, browser)
}

/**
 * Call a tool on an agent's browser ONLY if it already has one.
 *
 * The panel's capture path. It never creates, because a panel opening must not
 * be what puts a headed Chrome on someone's desktop, and it does not go through
 * the broker's executor precisely because that one does create.
 */
export async function callIfRunning(
  connectorId: string,
  agentId: string,
  rawToolName: string,
): Promise<{ text: string; images?: { data: string; mimeType: string }[] } | null> {
  const browser = browsers.get(connectorId)?.get(agentId)
  if (!browser) return null
  noteCallStart(connectorId, agentId)
  try {
    return await browser.session.callTool(rawToolName, {})
  } finally {
    noteCallEnd(connectorId, agentId)
  }
}

/** For the panel and for tests: does this agent have a browser running now? */
export function hasAgentBrowser(connectorId: string, agentId: string): boolean {
  return !!browsers.get(connectorId)?.get(agentId)
}

/** Open browsers, for observability. */
export function openAgentBrowserCount(): number {
  return totalOpen()
}
