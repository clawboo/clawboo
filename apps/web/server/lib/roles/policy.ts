// Roles that a sign-in proxy's signed token can carry, and what each one lets a
// person do.
//
// OFF BY DEFAULT. Only an administrator turns this on, with the operator setting
// `proxyIdentityRoles: enforce`, and it needs `proxyIdentity: required`, so every
// request that reaches a route names a person whose token verified. With the
// setting off, nothing here runs: everyone who gets in can do everything, as
// before, and a role in a token is only recorded.
//
// THE ROLES. A token names one or more of them in its role claim:
//
//   owner     the person the workspace's work is for. Sees and does the work,
//             answers approvals, makes standing ones ("Allow always", a grant
//             that never asks), sees the connected accounts and removes access,
//             and reads the record of who did what.
//   operator  sets up and runs the workspace: agents, teams, routines,
//             connectors, providers, runtimes, settings and costs. Never answers
//             an approval and never makes one standing, so the person the
//             workspace runs for keeps the last word on what acts for them.
//   member    sees and does the work. Answers approvals only when the token also
//             says `approve: true`.
//   guest     sees and does the work of the teams the token's `teams` claim
//             lists, and only until its `access_until`. Never answers approvals.
//
// Several roles add up: a token naming owner and operator can do what both can.
// A guest's limits hold only while guest is the person's one role, because a
// broader role already sees the whole workspace.
//
// PURE. No Express, no database: the route rules (./rules) and the guard
// (./guard) apply what this file decides.

/** The roles, as the token spells them. */
export const ROLES = ['owner', 'operator', 'member', 'guest'] as const
export type Role = (typeof ROLES)[number]

/**
 * What a route needs. Each route names one (./rules); a role is a set of them.
 *
 *   see       read the workspace's work: teams, agents, tasks, chats, results
 *   work      ask for work, chat, comment, create, move, assign, pause or stop
 *   tighten   make agents ask more, or take access away
 *   accounts  see which outside accounts are connected, and remove them
 *   approve   answer an approval: allow once, or deny
 *   standing  answer "Allow always", or let a grant act without asking
 *   setup     agents, teams, routines, rules, connectors, skills and tools
 *   costs     usage, spend and budgets
 *   system    providers, keys, runtimes, settings, updates and health
 *   records   the audit log, the approval history and the event log
 */
export const PERMISSIONS = [
  'see',
  'work',
  'tighten',
  'accounts',
  'approve',
  'standing',
  'setup',
  'costs',
  'system',
  'records',
] as const
export type Permission = (typeof PERMISSIONS)[number]

const BUNDLES: Readonly<Record<Role, readonly Permission[]>> = {
  owner: ['see', 'work', 'tighten', 'accounts', 'approve', 'standing', 'records'],
  operator: ['see', 'work', 'tighten', 'accounts', 'setup', 'costs', 'system', 'records'],
  member: ['see', 'work'],
  guest: ['see', 'work'],
}

/** What a request's token grants: read once, by the identity lane. A service
 *  token (`svc: true`) is a program acting for the sign-in front itself: it gets
 *  its role's permissions but never answers or makes an approval, and it is never
 *  a person. */
export interface PersonAccess {
  /** The roles the token names that this engine knows, in ROLES order. */
  roles: readonly Role[]
  /** `approve: true`: a member may answer approvals too. */
  approve: boolean
  /** The teams a guest may reach. Null when the token names none. */
  teams: readonly string[] | null
  /** When a guest's access ends, in seconds since 1970. Null: no end. */
  until: number | null
  /** How the person's role reads on screen, when the token gives one. */
  label: string | null
  /** A program, not a person (`svc: true`). */
  service: boolean
}

/** The claims a token carries beside its role. */
export const APPROVE_CLAIM = 'approve'
export const TEAMS_CLAIM = 'teams'
/** Not `until` or `exp`: it is when a guest's access ends, not the token. */
export const ACCESS_UNTIL_CLAIM = 'access_until'
export const ROLE_LABEL_CLAIM = 'roleLabel'
export const SERVICE_CLAIM = 'svc'
/** The version of these claims. A token may leave it out, which reads as 1; one
 *  that names a version this engine does not know is refused, so a later change
 *  to what the claims mean is never read as this one. */
export const ROLES_VERSION_CLAIM = 'rv'
export const ROLES_VERSION = 1

/** The token rides in a header on every request, so the list stays short. */
export const MAX_TEAMS = 64
/** With 64 of them, the claim stays well inside the 16 KiB a token may take. */
const MAX_TEAM_ID_CHARS = 128
const MAX_LABEL_CHARS = 64

/** Printable text, trimmed and capped, or null. */
function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  // eslint-disable-next-line no-control-regex
  const text = value.replace(/[\u0000-\u001f\u007f]/g, '').trim()
  return text ? text.slice(0, max) : null
}

/** The known roles a role claim names. An unknown word is ignored, so a sign-in
 *  provider's other roles (`offline_access`, say) do no harm. */
export function rolesOf(value: unknown): Role[] {
  const words = Array.isArray(value) ? value : [value]
  const named = new Set<string>()
  for (const word of words) {
    if (typeof word === 'string') named.add(word.trim().toLowerCase())
  }
  return ROLES.filter((role) => named.has(role))
}

/**
 * The access a token's claims grant, or null when a claim beside the role is
 * there but malformed. A malformed claim refuses the token (the lane answers
 * `claims`), rather than being read as no limit: a `teams` claim that is not a
 * list must never open every team.
 */
export function accessFromClaims(
  roleValue: unknown,
  claims: Readonly<Record<string, unknown>>,
): PersonAccess | null {
  const roles = rolesOf(roleValue)

  const rawVersion = claims[ROLES_VERSION_CLAIM]
  if (rawVersion !== undefined && rawVersion !== ROLES_VERSION) return null

  const rawService = claims[SERVICE_CLAIM]
  if (rawService !== undefined && typeof rawService !== 'boolean') return null
  const service = rawService === true

  const rawApprove = claims[APPROVE_CLAIM]
  if (rawApprove !== undefined && typeof rawApprove !== 'boolean') return null
  const approve = rawApprove === true

  let teams: string[] | null = null
  const rawTeams = claims[TEAMS_CLAIM]
  if (rawTeams !== undefined) {
    if (!Array.isArray(rawTeams) || rawTeams.length > MAX_TEAMS) return null
    teams = []
    for (const id of rawTeams) {
      // An id must arrive exactly as the engine stores it: no trimming that
      // could turn one id into another.
      if (typeof id !== 'string' || id === '' || id.length > MAX_TEAM_ID_CHARS) return null
      // eslint-disable-next-line no-control-regex
      if (/[\u0000-\u001f\u007f]/.test(id) || id !== id.trim()) return null
      teams.push(id)
    }
  }

  let until: number | null = null
  const rawUntil = claims[ACCESS_UNTIL_CLAIM]
  if (rawUntil !== undefined) {
    if (typeof rawUntil !== 'number' || !Number.isFinite(rawUntil)) return null
    until = rawUntil
  }

  // A guest's access always ends: a guest-only token without its end is refused,
  // rather than read as access for as long as the sign-in front keeps minting.
  if (roles.length === 1 && roles[0] === 'guest' && until === null) return null

  const label = cleanText(claims[ROLE_LABEL_CLAIM], MAX_LABEL_CHARS)
  return { roles, approve, teams, until, label, service }
}

/** True when guest is the person's one role, so its limits hold. */
export function isGuestOnly(access: PersonAccess): boolean {
  return access.roles.length === 1 && access.roles[0] === 'guest'
}

/** True when a guest's `access_until` has passed, or a guest has none (which the
 *  token check already refuses). Never true for anyone else. */
export function accessEnded(access: PersonAccess, nowMs: number): boolean {
  return isGuestOnly(access) && (access.until === null || nowMs >= access.until * 1000)
}

/** Everything the person may do right now. Empty for a token with no known role
 *  and for a guest whose access has ended. */
export function permissionsOf(access: PersonAccess, nowMs: number): ReadonlySet<Permission> {
  const out = new Set<Permission>()
  if (accessEnded(access, nowMs)) return out
  for (const role of access.roles) {
    for (const permission of BUNDLES[role]) out.add(permission)
  }
  if (access.approve && access.roles.includes('member')) out.add('approve')
  // A program acting for the sign-in front never answers for a person.
  if (access.service) {
    out.delete('approve')
    out.delete('standing')
  }
  return out
}

/** The teams a guest may reach, or null for a person the guest limits do not
 *  hold for. A guest whose token names no teams reaches none. */
export function guestTeams(access: PersonAccess): ReadonlySet<string> | null {
  return isGuestOnly(access) ? new Set(access.teams ?? []) : null
}

/** The permissions in a fixed order, for an answer a client reads. */
export function sortedPermissions(set: ReadonlySet<Permission>): Permission[] {
  return PERMISSIONS.filter((p) => set.has(p))
}
