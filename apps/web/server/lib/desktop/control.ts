// Who is in control of an agent's computer: the agent, or one person.
//
// A person takes over an agent's screen to do what the agent should not or
// cannot: sign in, answer a two-factor prompt, get past a check meant for
// humans. While they do, the agent must not be clicking in the same window, so
// its browser and desktop-driver calls are refused with a sentence that says
// why (`personInControlMessage`), and the agent gets its computer back when the
// person hands it back or walks away.
//
// ONE controller per agent, and the most recent take over wins: someone who
// takes over from a person who left their tab open must not have to find them
// first. The displaced person's view says so.
//
// Control is held by a VIEWER (one open live view), never by a person in the
// abstract, so it ends when that view goes: closing a tab must not hold an
// agent's tools hostage. A view that drops comes back within `RECONNECT_GRACE_MS`
// without losing control (a network blip); after that, or after `IDLE_LAPSE_MS`
// with no input from the holder, control returns to the agent.

import { EventEmitter } from 'node:events'

/** How long control survives its live view closing, for a reconnect. */
export const RECONNECT_GRACE_MS = 30_000

/** How long control survives with no input from whoever holds it. */
export const IDLE_LAPSE_MS = 10 * 60_000

/** How often lapses are checked. */
const SWEEP_MS = 5_000

export interface Controller {
  /** The live view that holds control. */
  viewerId: string
  /** Where that view came from: the dashboard, or a control link (by its id). */
  via: { kind: 'dashboard' } | { kind: 'link'; linkId: string }
  /** When control was taken. */
  since: number
  /** The holder's last input, or `since`. */
  lastInputAt: number
  /** When the holder's view closed, while it may still come back. */
  detachedAt: number | null
}

const controllers = new Map<string, Controller>()
const events = new EventEmitter()
events.setMaxListeners(0)
let sweep: NodeJS.Timeout | null = null
let now: () => number = () => Date.now()

export type ControlChange = { agentId: string; controller: Controller | null }

/** Called with every change of who controls an agent. Returns an unsubscribe. */
export function onControlChange(listener: (change: ControlChange) => void): () => void {
  events.on('change', listener)
  return () => events.off('change', listener)
}

function emit(agentId: string): void {
  events.emit('change', { agentId, controller: controllers.get(agentId) ?? null })
}

function ensureSweep(): void {
  if (sweep || controllers.size === 0) return
  sweep = setInterval(sweepLapsed, SWEEP_MS)
  sweep.unref()
}

/** Return control to the agent wherever its holder has gone or gone quiet. */
export function sweepLapsed(): void {
  const t = now()
  for (const [agentId, c] of controllers) {
    const gone = c.detachedAt !== null && t - c.detachedAt >= RECONNECT_GRACE_MS
    const idle = t - c.lastInputAt >= IDLE_LAPSE_MS
    if (gone || idle) {
      controllers.delete(agentId)
      emit(agentId)
    }
  }
  if (controllers.size === 0 && sweep) {
    clearInterval(sweep)
    sweep = null
  }
}

/** The person in control of this agent's computer, or null when the agent is. */
export function controllerOf(agentId: string): Controller | null {
  return controllers.get(agentId) ?? null
}

/** Whether a person holds this agent's computer, so its own tools must wait. */
export function isPersonInControl(agentId: string): boolean {
  return controllers.has(agentId)
}

/** What an agent's tool call is told while a person has its computer. */
export function personInControlMessage(): string {
  return "A person has taken over this agent's computer (its screen and browser) and is using it now. Do not retry at once: wait for them to hand it back, or ask them in chat what they need."
}

/** Take control for `viewerId`, from the agent or from whoever held it. */
export function takeControl(agentId: string, viewerId: string, via: Controller['via']): Controller {
  const t = now()
  const c: Controller = { viewerId, via, since: t, lastInputAt: t, detachedAt: null }
  controllers.set(agentId, c)
  ensureSweep()
  emit(agentId)
  return c
}

/** Hand control back to the agent, if `viewerId` holds it. */
export function releaseControl(agentId: string, viewerId: string): boolean {
  const c = controllers.get(agentId)
  if (!c || c.viewerId !== viewerId) return false
  controllers.delete(agentId)
  emit(agentId)
  return true
}

/** Whether `viewerId` holds control of this agent now. Counts as its input. */
export function holdsControl(agentId: string, viewerId: string): boolean {
  const c = controllers.get(agentId)
  if (!c || c.viewerId !== viewerId || c.detachedAt !== null) return false
  c.lastInputAt = now()
  return true
}

/** The holder's live view closed: start the reconnect grace. */
export function viewerDetached(agentId: string, viewerId: string): void {
  const c = controllers.get(agentId)
  if (c && c.viewerId === viewerId && c.detachedAt === null) c.detachedAt = now()
}

/** The holder's live view came back within the grace. */
export function viewerReattached(agentId: string, viewerId: string): boolean {
  const c = controllers.get(agentId)
  // Only a view that went away comes back: a second view naming the id of one
  // still open does not share its control.
  if (!c || c.viewerId !== viewerId || c.detachedAt === null) return false
  c.detachedAt = null
  return true
}

/** Return control to the agent from every holder that came through this link
 *  (the link was revoked or expired). */
export function releaseControlByLink(linkId: string): void {
  for (const [agentId, c] of controllers) {
    if (c.via.kind === 'link' && c.via.linkId === linkId) {
      controllers.delete(agentId)
      emit(agentId)
    }
  }
}

/** Return control of this agent to it, whoever holds it (the agent is gone). */
export function dropControl(agentId: string): void {
  if (controllers.delete(agentId)) emit(agentId)
}

/** Test seam. */
export function resetControlForTests(clock?: () => number): void {
  controllers.clear()
  if (sweep) clearInterval(sweep)
  sweep = null
  now = clock ?? (() => Date.now())
  events.removeAllListeners()
}
