// An agent's computer: its screen, live, who controls it, and links to it.
//
// Two ways in, the same live view behind both:
//
// - From the dashboard: `/api/agents/:agentId/computer/*`, behind the access
//   gate like every other route. Taking over and making or revoking links are a
//   person's acts (`refuseUnlessPerson`).
// - Through a link: `/api/computer-link/*`, where the link itself is the
//   credential (sent in the `x-clawboo-computer-link` header, never in the URL).
//   The access gate admits these paths when the link is good (see
//   `carriesComputerLink`), and a link reaches only its own agent's screen, with
//   what its kind allows.
//
// The live view is a Server-Sent Events stream. Input comes back as POSTed
// batches from the one watcher in control.
//
// With the verified person check (lib/personCheck.ts), every route here, both
// ways in, needs a person a verified token names, as well as a link where one is
// used: the link narrows what, the token proves who. Each view is bound to the
// person who opened it, and a view stream ends after VERIFIED_STREAM_MS so the
// page comes back with a fresh signed request (the reconnect keeps control).
//
// With the take-over claim required (`proxyIdentityControlClaim`), taking over
// and every batch of input need a sign-in proxy token whose `control` claim
// names the agent. A batch without one hands the screen back to the agent.

import type { IncomingMessage } from 'node:http'

import { connectorsByCategory } from '@clawboo/connector-catalog'
import { agents } from '@clawboo/db'
import { createLogger } from '@clawboo/logger'
import { eq } from 'drizzle-orm'
import type { Request, Response } from 'express'

import { isAgentUserMode } from '../lib/agentUser/config'
import {
  controlClaimFor,
  personOf,
  refuseUnlessPerson,
  refuseUnlessVerifiedPerson,
} from '../lib/auth'
import { connectorInstanceIdForSlug } from '../lib/capabilitySource/connectorIdentity'
import { hasAgentBrowser } from '../lib/connectors/agentBrowsers'
import { getRegistry } from '../lib/agentSource'
import { getDb } from '../lib/db'
import {
  DesktopToolsError,
  desktopToolsPlan,
  installDesktopTools,
  ownedCuaDriver,
} from '../lib/desktop/tools'
import { controllerOf, dropControl, isPersonInControl } from '../lib/desktop/control'
import {
  displayFor,
  displayHolders,
  displayProblem,
  displaySupport,
  stopDisplayNow,
  type DisplaySupport,
} from '../lib/desktop/displays'
import {
  LINK_HEADER,
  LinkLimitError,
  linkAgentStamp,
  listLinks,
  MAX_LINK_TTL_MS,
  mintLink,
  resolveLink,
  revokeAllLinks,
  revokeLink,
  type LinkKind,
  type PublicLink,
} from '../lib/desktop/links'
import {
  closeAllViewers,
  LiveViewLimitError,
  openViewer,
  parseInputEvents,
  sendInput,
  setControl,
  viewerCount,
  type ViewerSink,
  type ViewerVia,
} from '../lib/desktop/liveView'
import { controlClaimRequired, personCheckMode } from '../lib/personCheck'

const log = createLogger('computer')

/** A comment line on the stream this often, so a proxy does not close it. */
const HEARTBEAT_MS = 15_000

/** The header a reconnecting live view names its previous id in. */
const VIEWER_HEADER = 'x-clawboo-viewer'

/** Under the verified person check, how long one view stream lasts before the
 *  page asks again with a fresh signed request. A person the sign-in proxy stops
 *  vouching for loses the view within this, not when they close the tab. */
export const VERIFIED_STREAM_MS = 5 * 60_000

interface AgentRow {
  id: string
  name: string
  createdAt: number
  archivedAt: number | null
}

/** The agent's row, or null when there is none or it is archived. An archived
 *  agent that comes back is live again, but its old links were revoked when it
 *  was archived (watchAgentArchives). */
function agentRow(agentId: string): AgentRow | null {
  const row =
    getDb()
      .select({
        id: agents.id,
        name: agents.name,
        createdAt: agents.createdAt,
        archivedAt: agents.archivedAt,
      })
      .from(agents)
      .where(eq(agents.id, agentId))
      .get() ?? null
  return row && row.archivedAt == null ? row : null
}

/**
 * The link a token names, if it still works AND its agent is still the agent
 * it was made for: the same row (by its creation time), not archived. An id
 * that came back on another agent does not inherit the old agent's links.
 */
function workingLink(token: string | null | undefined): PublicLink | null {
  const link = resolveLink(token)
  if (!link) return null
  const row = agentRow(link.agentId)
  return row && row.createdAt === linkAgentStamp(link.id) ? link : null
}

/** Whether a request carries a link that still works. The access gate's hook. */
export function carriesComputerLink(req: IncomingMessage): boolean {
  const raw = req.headers[LINK_HEADER]
  if (typeof raw !== 'string') return false
  try {
    return workingLink(raw) !== null
  } catch {
    // The database could not be read: the link cannot be checked, so it is
    // not admitted. The gate answers 401 rather than an error page.
    return false
  }
}

function linkOf(req: Request): PublicLink | null {
  return workingLink(req.get(LINK_HEADER) ?? null)
}

/**
 * Why control links cannot be made here, or null when they can.
 *
 * A person who takes over an agent's screen can do whatever its browser's OS
 * user can do on this machine: a file dialog, a `file:` address or another
 * program reaches that user's files. Through the dashboard that is the operator,
 * who has all of it anyway. Through a link it is someone with no other way in,
 * so control links are only made when agents run as their own OS user, which
 * cannot open Clawboo's database, vault or access token.
 */
export function controlLinkRefusal(): string | null {
  return isAgentUserMode()
    ? null
    : "Control links need agents to run as their own OS user (CLAWBOO_AGENT_USER). Whoever takes over an agent's screen can reach what its browser's user can on this machine, which otherwise includes Clawboo's own files. Make a view link, or take over from here yourself."
}

/** A link's answers are about one link: never kept by a cache in between. */
function noStore(res: Response): void {
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Vary', LINK_HEADER)
}

function headerString(req: Request, name: string): string | null {
  const v = req.get(name)
  return typeof v === 'string' && v.length > 0 && v.length <= 100 ? v : null
}

// ─── Who may watch and take over ─────────────────────────────────────────────

/** The way a request watches, bound under the verified check to its person, so
 *  nobody else resumes, takes over or types into that view. */
function boundVia(req: Request, via: ViewerVia): ViewerVia {
  const person = personOf(req)
  return personCheckMode() === 'verified' && person ? { ...via, person: person.id } : via
}

/** The person control is bound to, when it is (the verified check, or the
 *  take-over claim required): the request's verified person, or null for none.
 *  Undefined when control is bound to no one, as in `page` mode. */
function controlHolder(req: Request): string | null | undefined {
  if (personCheckMode() !== 'verified' && !controlClaimRequired()) return undefined
  return personOf(req)?.id ?? null
}

/** With the take-over claim required, refuse a take over or a batch of input
 *  whose token does not name `agentId` in its `control` claim: 403 `control_claim`. */
function refuseWithoutControlClaim(req: Request, res: Response, agentId: string): boolean {
  if (!controlClaimRequired() || controlClaimFor(req, agentId)) return false
  log.warn({ method: req.method, path: req.path }, 'refused a take over without a control claim')
  res.status(403).json({ ok: false, error: 'control_claim' })
  return true
}

// ─── Status ──────────────────────────────────────────────────────────────────

/**
 * Whether agents get displays here, and what a person can do about it. Each
 * install offer stands only where installing would help: Xvnc is what is
 * missing and Clawboo has a build of it for this machine (TigerVNC's own,
 * x86_64), or displays work and Cua Driver is not installed yet. Never on a
 * Mac or Windows, never where an operator turned displays off.
 */
export function displaysStatus(
  support: DisplaySupport,
  plan: ReturnType<typeof desktopToolsPlan>,
  problem: string | null,
  driverInstalled: boolean,
  agentUserMode: boolean = isAgentUserMode(),
) {
  return support.ok
    ? {
        available: true as const,
        windowManager: support.tools.windowManager !== null,
        // Why the last display failed to start, when it did (a missing library).
        problem,
        // Cua Driver runs only with agents on their own OS user (driverPolicy).
        driverInstallable: plan.cuaDriver !== null && !driverInstalled && agentUserMode,
      }
    : {
        available: false as const,
        code: support.code,
        reason: support.reason,
        installable: support.code === 'no-xvnc' && plan.tigervnc !== null,
      }
}

/** GET /api/agents/:agentId/computer */
export function computerStatusGET(req: Request, res: Response): void {
  if (refuseUnlessVerifiedPerson(req, res)) return
  const agentId = String(req.params['agentId'] ?? '')
  if (!agentRow(agentId)) {
    res.status(404).json({ ok: false, error: 'no such agent' })
    return
  }
  const display = displayFor(agentId)
  res.json({
    ok: true,
    displays: displaysStatus(
      displaySupport(),
      desktopToolsPlan(),
      displayProblem(),
      ownedCuaDriver() !== null,
    ),
    display: display
      ? {
          running: true,
          width: display.width,
          height: display.height,
          holders: displayHolders(agentId),
        }
      : { running: false },
    control: isPersonInControl(agentId)
      ? { by: 'person', via: controllerOf(agentId)?.via.kind ?? 'dashboard' }
      : { by: 'agent' },
    // Whether one of the agent's own browsers is open now (never starts one).
    browserOpen: connectorsByCategory('browser').some((def) =>
      hasAgentBrowser(connectorInstanceIdForSlug(def.slug), agentId),
    ),
    watchers: viewerCount(agentId),
    links: listLinks(agentId),
    controlLinks: { allowed: controlLinkRefusal() === null, reason: controlLinkRefusal() },
    // Whether a take over needs the sign-in proxy's say-so for this agent, and
    // whether this request's token has it.
    controlClaim: controlClaimRequired()
      ? { required: true, granted: controlClaimFor(req, agentId) }
      : { required: false, granted: false },
  })
}

// ─── Live view ───────────────────────────────────────────────────────────────

function streamTo(
  req: Request,
  res: Response,
  agentId: string,
  via: ViewerVia,
  stillValid: () => boolean,
): void {
  // The connection went while the request waited (the identity lane checks a
  // token asynchronously first): its 'close' has already fired, so a view opened
  // now would never be closed and would hold a watcher's place for good.
  if (res.destroyed || res.writableEnded) return
  const holder = controlHolder(req)
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  res.flushHeaders?.()
  let ended = false
  const sink: ViewerSink = {
    send(event, data) {
      if (ended) return true
      return res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    },
    onDrain(cb) {
      res.once('drain', cb)
    },
    end() {
      if (ended) return
      ended = true
      res.end()
    },
  }
  let viewer: { viewerId: string; close: () => void }
  try {
    viewer = openViewer(agentId, via, sink, headerString(req, VIEWER_HEADER), holder)
  } catch (err) {
    // Full is for now, not for good: the page tries again a little later.
    if (err instanceof LiveViewLimitError) sink.send('busy', { reason: err.message })
    else sink.send('end', { reason: 'Could not open the live view.' })
    sink.end()
    return
  }
  // Ending the response is not enough to close the view: a connection that is
  // already gone emits no 'close'. So each ending here closes it too.
  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    clearInterval(heartbeat)
    if (renewal) clearTimeout(renewal)
    viewer.close()
  }
  const heartbeat = setInterval(() => {
    // A link can be revoked or expire while its view is open.
    if (!stillValid()) {
      sink.send('end', { reason: 'This link was revoked or has expired.' })
      sink.end()
      close()
      return
    }
    if (!ended) res.write(': ping\n\n')
  }, HEARTBEAT_MS)
  heartbeat.unref()
  // Under the verified check a stream lasts a few minutes: `renew` tells the page
  // to come back at once, naming this view, with a fresh signed request.
  const renewal =
    personCheckMode() === 'verified'
      ? setTimeout(() => {
          sink.send('renew', { afterMs: 0 })
          sink.end()
          close()
        }, VERIFIED_STREAM_MS)
      : null
  renewal?.unref()
  req.on('close', close)
  res.on('close', close)
}

/** GET /api/agents/:agentId/computer/live */
export function computerLiveGET(req: Request, res: Response): void {
  if (refuseUnlessVerifiedPerson(req, res)) return
  const agentId = String(req.params['agentId'] ?? '')
  if (!agentRow(agentId)) {
    res.status(404).json({ ok: false, error: 'no such agent' })
    return
  }
  streamTo(
    req,
    res,
    agentId,
    boundVia(req, { kind: 'dashboard' }),
    () => agentRow(agentId) !== null,
  )
}

/** GET /api/computer-link/live */
export function computerLinkLiveGET(req: Request, res: Response): void {
  noStore(res)
  const link = linkOf(req)
  if (!link) {
    res.status(401).json({ ok: false, error: 'This link does not work any more.' })
    return
  }
  if (refuseUnlessVerifiedPerson(req, res)) return
  const via = boundVia(req, { kind: 'link', linkId: link.id, linkKind: link.kind })
  streamTo(req, res, link.agentId, via, () => {
    const now = workingLink(req.get(LINK_HEADER) ?? null)
    return now !== null && now.id === link.id
  })
}

// ─── Take over and input ─────────────────────────────────────────────────────

function controlAction(raw: unknown): 'take' | 'release' | null {
  return raw === 'take' || raw === 'release' ? raw : null
}

function viewerIdOf(body: unknown): string | null {
  const id = (body as { viewerId?: unknown } | null)?.viewerId
  return typeof id === 'string' && id.length > 0 && id.length <= 100 ? id : null
}

function answer(
  res: Response,
  result: ReturnType<typeof setControl> | ReturnType<typeof sendInput>,
): void {
  if (result.ok) res.json({ ok: true, control: result.state })
  else res.status(result.status).json({ ok: false, error: result.error })
}

/** POST /api/agents/:agentId/computer/control { viewerId, action } */
export function computerControlPOST(req: Request, res: Response): void {
  const agentId = String(req.params['agentId'] ?? '')
  const viewerId = viewerIdOf(req.body)
  const action = controlAction((req.body as { action?: unknown } | null)?.action)
  if (!viewerId || !action) {
    res.status(400).json({ ok: false, error: 'viewerId and action (take or release) are required' })
    return
  }
  // Taking over stops an agent's work: a person's act. Handing back is not,
  // except that under the verified check nobody else reaches the screen at all.
  if (action === 'take' ? refuseUnlessPerson(req, res) : refuseUnlessVerifiedPerson(req, res)) {
    return
  }
  if (action === 'take' && refuseWithoutControlClaim(req, res, agentId)) return
  answer(
    res,
    setControl(agentId, viewerId, boundVia(req, { kind: 'dashboard' }), action, controlHolder(req)),
  )
}

/** POST /api/computer-link/control { viewerId, action } */
export function computerLinkControlPOST(req: Request, res: Response): void {
  noStore(res)
  const link = linkOf(req)
  if (!link) {
    res.status(401).json({ ok: false, error: 'This link does not work any more.' })
    return
  }
  const viewerId = viewerIdOf(req.body)
  const action = controlAction((req.body as { action?: unknown } | null)?.action)
  if (!viewerId || !action) {
    res.status(400).json({ ok: false, error: 'viewerId and action (take or release) are required' })
    return
  }
  if (refuseUnlessVerifiedPerson(req, res)) return
  // A control link is made only where it may be (see controlLinkRefusal);
  // checked again here, before anyone takes over through one.
  const refusal = action === 'take' ? controlLinkRefusal() : null
  if (refusal) {
    res.status(403).json({ ok: false, error: refusal })
    return
  }
  if (action === 'take' && refuseWithoutControlClaim(req, res, link.agentId)) return
  answer(
    res,
    setControl(
      link.agentId,
      viewerId,
      boundVia(req, { kind: 'link', linkId: link.id, linkKind: link.kind }),
      action,
      controlHolder(req),
    ),
  )
}

/** POST /api/agents/:agentId/computer/input { viewerId, events } */
export function computerInputPOST(req: Request, res: Response): void {
  const agentId = String(req.params['agentId'] ?? '')
  const viewerId = viewerIdOf(req.body)
  const events = parseInputEvents((req.body as { events?: unknown } | null)?.events)
  if (!viewerId || !events) {
    res.status(400).json({ ok: false, error: 'viewerId and a list of input events are required' })
    return
  }
  if (refuseUnlessVerifiedPerson(req, res)) return
  const via = boundVia(req, { kind: 'dashboard' })
  if (refuseInputWithoutClaim(req, res, agentId, viewerId, via)) return
  answer(res, sendInput(agentId, viewerId, via, events, controlHolder(req)))
}

/**
 * With the take-over claim required, a batch of input without it is refused
 * (403 `control_claim`), and the screen goes back to the agent from this view,
 * if it held it: the proxy no longer allows this person to drive it. Control
 * held by anyone else is left alone.
 */
function refuseInputWithoutClaim(
  req: Request,
  res: Response,
  agentId: string,
  viewerId: string,
  via: ViewerVia,
): boolean {
  if (!refuseWithoutControlClaim(req, res, agentId)) return false
  setControl(agentId, viewerId, via, 'release', controlHolder(req))
  return true
}

/** POST /api/computer-link/input { viewerId, events } */
export function computerLinkInputPOST(req: Request, res: Response): void {
  noStore(res)
  const link = linkOf(req)
  if (!link) {
    res.status(401).json({ ok: false, error: 'This link does not work any more.' })
    return
  }
  const viewerId = viewerIdOf(req.body)
  const events = parseInputEvents((req.body as { events?: unknown } | null)?.events)
  if (!viewerId || !events) {
    res.status(400).json({ ok: false, error: 'viewerId and a list of input events are required' })
    return
  }
  if (refuseUnlessVerifiedPerson(req, res)) return
  const via = boundVia(req, { kind: 'link', linkId: link.id, linkKind: link.kind })
  if (refuseInputWithoutClaim(req, res, link.agentId, viewerId, via)) return
  answer(res, sendInput(link.agentId, viewerId, via, events, controlHolder(req)))
}

// ─── Links ───────────────────────────────────────────────────────────────────

/** GET /api/computer-link/info: what the link is for, for its page. */
export function computerLinkInfoGET(req: Request, res: Response): void {
  noStore(res)
  // A link whose agent is gone, archived or replaced does not work (workingLink).
  const link = linkOf(req)
  if (!link) {
    res.status(401).json({ ok: false, error: 'This link does not work any more.' })
    return
  }
  if (refuseUnlessVerifiedPerson(req, res)) return
  const name = agentRow(link.agentId)?.name ?? ''
  res.json({ ok: true, kind: link.kind, expiresAt: link.expiresAt, agent: { name } })
}

/** POST /api/agents/:agentId/computer/links { kind, ttlMinutes? } */
export function computerLinksPOST(req: Request, res: Response): void {
  if (refuseUnlessPerson(req, res)) return
  const agentId = String(req.params['agentId'] ?? '')
  const row = agentRow(agentId)
  if (!row) {
    res.status(404).json({ ok: false, error: 'no such agent' })
    return
  }
  const body = (req.body ?? {}) as { kind?: unknown; ttlMinutes?: unknown }
  const kind: LinkKind | null = body.kind === 'view' || body.kind === 'control' ? body.kind : null
  if (!kind) {
    res.status(400).json({ ok: false, error: 'kind must be view or control' })
    return
  }
  const refusal = kind === 'control' ? controlLinkRefusal() : null
  if (refusal) {
    res.status(409).json({ ok: false, error: refusal })
    return
  }
  let ttlMs: number | undefined
  if (body.ttlMinutes !== undefined) {
    const minutes = Number(body.ttlMinutes)
    if (!Number.isFinite(minutes) || minutes < 1 || minutes * 60_000 > MAX_LINK_TTL_MS) {
      res.status(400).json({ ok: false, error: 'ttlMinutes must be between 1 and 1440' })
      return
    }
    ttlMs = minutes * 60_000
  }
  let minted: ReturnType<typeof mintLink>
  try {
    minted = mintLink(agentId, kind, ttlMs, row.createdAt)
  } catch (err) {
    if (!(err instanceof LinkLimitError)) throw err
    res.status(409).json({ ok: false, error: err.message })
    return
  }
  // The token is answered once and kept nowhere but as a hash. Not cached.
  res.setHeader('Cache-Control', 'no-store')
  res.status(201).json({ ok: true, token: minted.token, link: minted.link })
}

/** DELETE /api/agents/:agentId/computer/links/:linkId */
export function computerLinkDELETE(req: Request, res: Response): void {
  if (refuseUnlessPerson(req, res)) return
  const agentId = String(req.params['agentId'] ?? '')
  const linkId = String(req.params['linkId'] ?? '')
  if (!revokeLink(agentId, linkId)) {
    res.status(404).json({ ok: false, error: 'no such link' })
    return
  }
  res.json({ ok: true })
}

/** DELETE /api/agents/:agentId/computer/links */
export function computerLinksDELETE(req: Request, res: Response): void {
  if (refuseUnlessPerson(req, res)) return
  const agentId = String(req.params['agentId'] ?? '')
  res.json({ ok: true, revoked: revokeAllLinks(agentId) })
}

/**
 * POST /api/computer/tools/install: install the pinned desktop tools (TigerVNC's
 * Xvnc, Cua Driver) into Clawboo's runtimes folder. A person's act; Linux only.
 * Downloads each release, checks it against its pinned SHA-256 before it is
 * unpacked, and switches to it only when everything worked.
 */
export async function computerToolsInstallPOST(req: Request, res: Response): Promise<void> {
  if (refuseUnlessPerson(req, res)) return
  try {
    const done = await installDesktopTools()
    res.json({ ok: true, xvnc: done.tigervnc !== null, cuaDriver: done.cuaDriver !== null })
  } catch (err) {
    const code = err instanceof DesktopToolsError ? err.code : 'INSTALL_FAILED'
    res.status(code === 'UNSUPPORTED' ? 422 : 502).json({
      ok: false,
      code,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

/**
 * End an agent's links, live views, control and display the moment any agent
 * source archives it (an OpenClaw agent gone from the Gateway, say), not only
 * when it is deleted here. Archived then brought back, it keeps its id and its
 * row, so a link made before would otherwise work again. Called once at boot.
 */
export function watchAgentArchives(): void {
  for (const source of getRegistry().registry.list()) {
    void (async () => {
      try {
        for await (const event of source.events()) {
          if (event.kind === 'agent-archived') forgetAgentComputer(event.agentId)
        }
      } catch {
        // A source whose events end or fail stops being watched; deleting the
        // agent still forgets it.
      }
    })()
  }
}

/** An agent was deleted: nothing of its computer may outlive it. */
export function forgetAgentComputer(agentId: string): void {
  revokeAllLinks(agentId)
  closeAllViewers(agentId)
  dropControl(agentId)
  stopDisplayNow(agentId)
}
