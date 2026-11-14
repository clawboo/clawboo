// Links to one agent's computer: a view link, or a control link.
//
// A link lets someone who has no way into this Clawboo watch one agent's screen,
// or take it over, and nothing else: the person who must type their own
// password into a site the agent is signed into, a teammate who wants to watch
// a run. So a link is a CAPABILITY. Whoever holds it has exactly what it names,
// for one agent, until it expires or someone revokes it.
//
// - Unguessable: 32 random bytes.
// - Kept only as a SHA-256 of the token. The token itself is shown once, to the
//   person who made it.
// - Scoped to one agent and one kind. A view link can never send input; nothing
//   here or in the live view turns one into the other.
// - Expiring (`MAX_LINK_TTL_MS` at most) and revocable, one at a time or all of
//   an agent's at once. Bound to the agent row it was made for, so an agent id
//   that comes back on another agent does not inherit its links. Revoking ends every live view open through the link at
//   once and hands back control held through it.
// - In memory: a restart revokes every link. That is the safe direction to fail.
// - Never logged. The token travels in the URL's fragment (which a browser never
//   sends) and in a request header (which the request log does not record),
//   never in a path or a query string.

import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'

export type LinkKind = 'view' | 'control'

/** The header a link's page sends its token in. */
export const LINK_HEADER = 'x-clawboo-computer-link'

/** Every token starts with this, so a log scanner or a person can tell one. */
export const LINK_TOKEN_PREFIX = 'cbcl_'

export const DEFAULT_LINK_TTL_MS: Record<LinkKind, number> = {
  view: 8 * 60 * 60_000,
  control: 60 * 60_000,
}

/** No link lives longer than a day. */
export const MAX_LINK_TTL_MS = 24 * 60 * 60_000

/** No agent has more than this many links at once; the oldest goes first. */
const MAX_LINKS_PER_AGENT = 20

/** What anyone listing links may see: never the token or its hash. */
export interface PublicLink {
  id: string
  agentId: string
  kind: LinkKind
  createdAt: number
  expiresAt: number
}

interface LinkRecord extends PublicLink {
  /**
   * Which agent row the link was made for, beyond its id: the row's own
   * creation time. An agent id can come back on a different agent (OpenClaw
   * names ids after agents, and a deleted name can be reused), and a link must
   * never reach that one.
   */
  agentStamp: number
}

const publicOf = (r: LinkRecord): PublicLink => ({
  id: r.id,
  agentId: r.agentId,
  kind: r.kind,
  createdAt: r.createdAt,
  expiresAt: r.expiresAt,
})

/** The agent already has the most links it may hold. */
export class LinkLimitError extends Error {
  constructor() {
    super(`This agent already has ${MAX_LINKS_PER_AGENT} links. Revoke one first.`)
    this.name = 'LinkLimitError'
  }
}

const byHash = new Map<string, LinkRecord>()
const events = new EventEmitter()
events.setMaxListeners(0)
let now: () => number = () => Date.now()

const hashOf = (token: string): string => createHash('sha256').update(token).digest('hex')

/** Called with a link's id when it stops working (revoked or expired). */
export function onLinkEnded(listener: (linkId: string) => void): () => void {
  events.on('ended', listener)
  return () => events.off('ended', listener)
}

function end(hash: string): void {
  const rec = byHash.get(hash)
  if (!rec) return
  byHash.delete(hash)
  events.emit('ended', rec.id)
}

/** Ends links as they expire, so a live view open through one closes on time
 *  even when nothing asks about links. Runs only while a link exists. */
let sweep: NodeJS.Timeout | null = null
const SWEEP_MS = 15_000

function dropExpired(): void {
  const t = now()
  for (const [hash, rec] of byHash) if (rec.expiresAt <= t) end(hash)
  if (byHash.size === 0 && sweep) {
    clearInterval(sweep)
    sweep = null
  } else if (byHash.size > 0 && !sweep) {
    sweep = setInterval(dropExpired, SWEEP_MS)
    sweep.unref()
  }
}

/**
 * Make a link to the agent row `agentId` whose creation time is `agentStamp`.
 * Returns the token once; it cannot be read back later. Throws
 * `LinkLimitError` when the agent holds the most links it may: an existing link
 * is never revoked behind someone's back to make room.
 */
export function mintLink(
  agentId: string,
  kind: LinkKind,
  ttlMs: number = DEFAULT_LINK_TTL_MS[kind],
  agentStamp = 0,
): { token: string; link: PublicLink } {
  dropExpired()
  const ttl = Math.min(Math.max(Math.floor(ttlMs), 60_000), MAX_LINK_TTL_MS)
  const mine = [...byHash.values()].filter((r) => r.agentId === agentId)
  if (mine.length >= MAX_LINKS_PER_AGENT) throw new LinkLimitError()
  const token = LINK_TOKEN_PREFIX + randomBytes(32).toString('base64url')
  const t = now()
  const link: LinkRecord = {
    id: randomUUID(),
    agentId,
    kind,
    createdAt: t,
    expiresAt: t + ttl,
    agentStamp,
  }
  byHash.set(hashOf(token), link)
  dropExpired()
  return { token, link: publicOf(link) }
}

/** The agent row a link was made for: its id and creation time. */
export function linkAgentStamp(linkId: string): number | null {
  for (const r of byHash.values()) if (r.id === linkId) return r.agentStamp
  return null
}

/** The link this token names, if it still works. Looked up by hash, so the
 *  token itself is never compared character by character. */
export function resolveLink(token: string | undefined | null): PublicLink | null {
  if (typeof token !== 'string' || !token.startsWith(LINK_TOKEN_PREFIX) || token.length > 200) {
    return null
  }
  const hash = hashOf(token)
  const rec = byHash.get(hash)
  if (!rec) return null
  if (rec.expiresAt <= now()) {
    end(hash)
    return null
  }
  return publicOf(rec)
}

/** The agent's working links, newest first. */
export function listLinks(agentId: string): PublicLink[] {
  dropExpired()
  return [...byHash.values()]
    .filter((r) => r.agentId === agentId)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(publicOf)
}

/** Revoke one of this agent's links. False when it is not one of them. */
export function revokeLink(agentId: string, linkId: string): boolean {
  for (const [hash, rec] of byHash) {
    if (rec.id === linkId && rec.agentId === agentId) {
      end(hash)
      return true
    }
  }
  return false
}

/** Revoke every link to this agent's computer. Returns how many. */
export function revokeAllLinks(agentId: string): number {
  let n = 0
  for (const [hash, rec] of byHash) {
    if (rec.agentId === agentId) {
      end(hash)
      n += 1
    }
  }
  return n
}

/** Test seam. */
export function resetLinksForTests(clock?: () => number): void {
  byHash.clear()
  if (sweep) clearInterval(sweep)
  sweep = null
  events.removeAllListeners()
  now = clock ?? (() => Date.now())
}
