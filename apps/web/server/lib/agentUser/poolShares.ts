// The work folder with a user per agent (CLAWBOO_AGENT_USERS): shares.
//
// A share is the folders of one team, or of one agent with no team. Each has a
// root the server makes itself, in a folder no agent can write, so nothing an
// agent planted is on the way:
//
//   <work>/                       server, 0711: agents pass through, never list
//     teams/<share>/              the team folder (task folders inside)
//     mirrors/<share>/            the share's copies of repositories
//     team-history/<share>.git    the team work check's history
//     reviews/<install>/<share>/  review checkouts
//     worktrees/<repo>/<task>/    one task's checkout (the task's share)
//
// A share root is owned by the server, its group is the share's (the team's
// group, or the agent user's own), mode 2770, with an inherited ACL that gives
// that group every file made inside whatever the maker's umask: so teammates
// read and write each other's files, and nobody else reaches them. Everything
// inside a root goes through an agent host of that share.
//
// The folders above the roots (`teams/`, `worktrees/<repo>/`, ...) are the
// server's, 0711, and hold nothing but roots, so the server lists and makes them
// itself.

import fs from 'node:fs'
import path from 'node:path'

import { sanitizeAgentId } from '../runtimes/identityHome'
import type { AgentHostClient } from './client'
import { AGENT_SHARE_PREFIX, ownerOfPathNow, type ShareOwner } from './poolRoute'
import { poolUserForAgent } from './poolRoute'
import { teamGroupNameFor } from './poolAssignments'
import { activeAgentPool } from './state'

/** The structural folders of the work folder, under which share roots sit. */
export const SHARE_TOPS = ['teams', 'mirrors', 'team-history', 'reviews', 'worktrees'] as const

/** The segment a share's roots are named by. */
export function shareSegment(owner: ShareOwner): string {
  return owner.kind === 'agent'
    ? `${AGENT_SHARE_PREFIX}${sanitizeAgentId(owner.agentId)}`
    : sanitizeAgentId(owner.teamId)
}

function under(child: string, parent: string): boolean {
  const rel = path.relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

export interface ShareLayout {
  workDir: string
  /** The install's own folder name under `reviews/`. */
  reviewsSegment: string
}

/**
 * Where `p` sits: a structural folder (the server's), inside or at a share
 * root, or outside the work folder (null). `root` is the share root holding it.
 */
export function shareSpot(
  p: string,
  layout: ShareLayout,
): { kind: 'structural' } | { kind: 'share'; root: string } | null {
  const work = path.resolve(layout.workDir)
  const abs = path.resolve(p)
  if (!under(abs, work)) return null
  const parts = path.relative(work, abs).split(path.sep).filter(Boolean)
  if (parts.length === 0) return { kind: 'structural' }
  const top = parts[0]!
  // How many segments down a root is, per top folder.
  let depth: number
  switch (top) {
    case 'teams':
    case 'mirrors':
    case 'team-history':
      depth = 2
      break
    case 'reviews':
      if (parts.length >= 2 && parts[1] !== layout.reviewsSegment) return null
      depth = 3
      break
    case 'worktrees':
      depth = 3
      break
    default:
      return null
  }
  if (parts.length < depth) return { kind: 'structural' }
  return { kind: 'share', root: path.join(work, ...parts.slice(0, depth)) }
}

/** The gid a share's root carries. */
export function shareGid(owner: ShareOwner): number {
  if (owner.kind === 'agent') return poolUserForAgent(owner.agentId).gid
  const name = teamGroupNameFor(owner.teamId)
  const group = activeAgentPool().group(name)
  if (!group) throw new Error(`the team group ${name} is not in CLAWBOO_AGENT_GROUPS`)
  return group.gid
}

export interface ShareFsDeps {
  serverUid: number
  /** Give `dir` the share's inherited ACL for `gid`. */
  setAcl(dir: string, gid: number): Promise<void>
}

/** Fail unless `dir` is a real folder of the server's, never a link. */
function assertServerFolder(dir: string, serverUid: number): fs.Stats {
  const st = fs.lstatSync(dir)
  if (!st.isDirectory() || st.isSymbolicLink()) {
    throw Object.assign(new Error(`${dir} is not a folder`), { code: 'ENOTDIR' })
  }
  if (serverUid >= 0 && st.uid !== serverUid) {
    throw Object.assign(
      new Error(`${dir} is not the server's: the work folder's own folders must be`),
      { code: 'EACCES' },
    )
  }
  return st
}

/** Make the structural folders down to `dir` (all the server's, 0711). */
export function ensureStructural(dir: string, layout: ShareLayout, deps: ShareFsDeps): void {
  const work = path.resolve(layout.workDir)
  const abs = path.resolve(dir)
  if (!under(abs, work)) throw new Error(`${dir} is outside the work folder`)
  assertServerFolder(work, deps.serverUid)
  let cur = work
  for (const seg of path.relative(work, abs).split(path.sep).filter(Boolean)) {
    cur = path.join(cur, seg)
    try {
      fs.mkdirSync(cur, { mode: 0o711 })
    } catch (err) {
      if ((err as { code?: string }).code !== 'EEXIST') throw err
    }
    const st = assertServerFolder(cur, deps.serverUid)
    if ((st.mode & 0o7777) !== 0o711) fs.chmodSync(cur, 0o711)
  }
}

/**
 * Make a share root: the server's, the share's group, 2770, the inherited ACL.
 * Its parent is a structural folder no agent can write, so the folder made here
 * is the one checked.
 */
export async function ensureShareRoot(
  root: string,
  owner: ShareOwner,
  layout: ShareLayout,
  deps: ShareFsDeps,
): Promise<void> {
  ensureStructural(path.dirname(root), layout, deps)
  const gid = shareGid(owner)
  let made = false
  try {
    fs.mkdirSync(root, { mode: 0o700 })
    made = true
  } catch (err) {
    if ((err as { code?: string }).code !== 'EEXIST') throw err
  }
  const st = assertServerFolder(root, deps.serverUid)
  // A root a crash left between its mkdir and its chown: still the server's
  // group, and empty. Finished now, as if just made.
  const serverGid = typeof process.getgid === 'function' ? process.getgid() : -1
  if (!made && st.gid !== gid && st.gid === serverGid && fs.readdirSync(root).length === 0) {
    made = true
  }
  if (st.gid !== gid) {
    if (!made) {
      // A root of another share's group: a team that was deleted and whose
      // folders were not wiped, or a folder put there by hand. Never handed
      // over with whatever is inside.
      throw Object.assign(
        new Error(
          `${root} belongs to another group (gid ${st.gid}), not this share's (gid ${gid}). Move it away and try again.`,
        ),
        { code: 'EACCES' },
      )
    }
    fs.chownSync(root, -1, gid)
  }
  if ((st.mode & 0o7777) !== 0o2770 || made) fs.chmodSync(root, 0o2770)
  // Once per root per server life (and at once for a new one): a root whose
  // ACL a crash or a failed setfacl left out gets it here, rather than keeping
  // every file in it private to its maker.
  const key = `${path.resolve(root)}:${gid}`
  if (made || !aclApplied.has(key)) {
    await deps.setAcl(root, gid)
    aclApplied.add(key)
  }
}

const aclApplied = new Set<string>()

/** The share that owns a root, read from its path. */
export function ownerOfRoot(root: string): ShareOwner | null {
  const owner = ownerOfPathNow(root)
  return owner && owner.kind !== 'user' ? owner : null
}

// ── What the agent-space file verbs ask in pool mode ────────────────────

let shareCtx: { layout: () => ShareLayout; deps: ShareFsDeps } | null = null

/** Set at boot; null with no pool. */
export function setShareContext(
  next: { layout: () => ShareLayout; deps: ShareFsDeps } | null,
): void {
  shareCtx = next
}

/** Where `p` sits in the work folder, or null outside it (or with no pool). */
export function poolSpot(p: string): ReturnType<typeof shareSpot> {
  return shareCtx ? shareSpot(p, shareCtx.layout()) : null
}

function ctx(): { layout: ShareLayout; deps: ShareFsDeps } {
  if (!shareCtx) throw new Error('agent isolation has not started')
  return { layout: shareCtx.layout(), deps: shareCtx.deps }
}

/**
 * Make what the server makes for `dir`: the structural folders, and the share
 * root that holds it. Returns whether `dir` is now fully made (it was one of
 * those), or the rest is for a host of the share.
 */
export async function ensurePoolFolder(dir: string): Promise<'made' | 'host'> {
  const spot = poolSpot(dir)
  if (!spot) return 'host'
  const { layout, deps } = ctx()
  if (spot.kind === 'structural') {
    ensureStructural(dir, layout, deps)
    return 'made'
  }
  const owner = ownerOfRoot(spot.root)
  if (!owner) {
    throw Object.assign(new Error(`${spot.root} belongs to no team or agent`), { code: 'EACCES' })
  }
  await ensureShareRoot(spot.root, owner, layout, deps)
  return path.resolve(dir) === spot.root ? 'made' : 'host'
}

/** A structural folder's entries (names of share roots): read by the server. */
export function listStructural(
  rawDir: string,
  max: number,
): {
  entries: {
    name: string
    type: 'file' | 'dir' | 'link' | 'other'
    size: number
    mtimeMs: number
  }[]
  truncated: boolean
} {
  const dir = path.resolve(rawDir)
  let names: fs.Dirent[]
  try {
    names = fs.readdirSync(dir, { withFileTypes: true })
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT') return { entries: [], truncated: false }
    throw err
  }
  names.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  const entries = names.slice(0, max).map((d) => {
    const type = d.isSymbolicLink()
      ? 'link'
      : d.isDirectory()
        ? 'dir'
        : d.isFile()
          ? 'file'
          : 'other'
    let size = 0
    let mtimeMs = 0
    try {
      const st = fs.lstatSync(path.join(dir, d.name))
      size = st.size
      mtimeMs = st.mtimeMs
    } catch {
      /* gone meanwhile */
    }
    return { name: d.name, type: type as 'file' | 'dir' | 'link' | 'other', size, mtimeMs }
  })
  return { entries, truncated: names.length > max }
}

/** After a host emptied a share root (it cannot remove the root itself, whose
 *  folder is the server's), remove the empty root. A root an agent filled again
 *  meanwhile stays, and that is reported. */
export function removeEmptiedRoot(root: string): void {
  try {
    fs.rmdirSync(path.resolve(root))
  } catch (err) {
    const c = (err as { code?: string }).code
    if (c === 'ENOENT') return
    throw err
  }
}

/** Remove an empty structural folder. */
export function removeEmptyStructural(dir: string): void {
  const { layout } = ctx()
  if (path.resolve(dir) === path.resolve(layout.workDir)) {
    throw Object.assign(new Error('the work folder itself is never removed'), { code: 'EPERM' })
  }
  fs.rmdirSync(path.resolve(dir))
}

/**
 * Empty `dir` through `client`, a host of its share, entry by entry: the host
 * cannot remove the root (its folder is the server's), and a recursive remove
 * stops at that refusal before it reaches what is inside.
 */
export async function emptyFolderVia(
  client: { request: AgentHostClient['request'] },
  dir: string,
  /** A share root every path must stay inside (the host checks). */
  within?: string,
): Promise<void> {
  const o = within ? { within } : {}
  for (let round = 0; round < 100; round++) {
    let listing
    try {
      listing = await client.request({ op: 'fs.list', path: dir, max: 10_000 }, o)
    } catch (err) {
      if ((err as { code?: string }).code === 'ENOENT') return
      throw err
    }
    const entries = Array.isArray(listing.entries) ? listing.entries : []
    if (entries.length === 0) return
    for (const e of entries) {
      if (
        !e ||
        typeof e.name !== 'string' ||
        e.name.includes('/') ||
        e.name === '..' ||
        e.name === '.'
      )
        continue
      await client.request(
        { op: 'fs.rm', path: path.join(dir, e.name) },
        { timeoutMs: 10 * 60_000, ...o },
      )
    }
  }
  throw Object.assign(new Error(`${dir} could not be emptied`), { code: 'ENOTEMPTY' })
}
