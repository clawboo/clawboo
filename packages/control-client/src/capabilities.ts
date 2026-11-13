// What an engine says about itself: `GET /api/system/capabilities`. A client reads
// it before using a feature instead of probing routes, and checks that the engine
// still serves a client of its age.
//
// The support window is the engine's current minor release plus the previous one.
// An engine at 0.6.x keeps every route, field and event a client built for 0.5.x
// relies on; a client built for 0.4.x is outside the window. `apiRevision` moves
// only when a client-facing route, field or event is removed or renamed, so a
// client can compare one integer instead of parsing versions.

import { z } from 'zod'

import { apiFetch } from './config'

/**
 * The client-facing API revision this package describes. Bumped together with
 * the engine's contract test whenever a route, response field or stream event a
 * client may use is removed or renamed. Adding one never bumps it.
 */
export const ENGINE_API_REVISION = 1

/**
 * Every feature flag name this revision defines. Names are stable: a flag is
 * never renamed, and one that goes away is reported `false` until the next API
 * revision. An engine older than a flag does not send it, so a client treats a
 * missing flag as `false`.
 */
export const ENGINE_FEATURES = [
  // Runtimes this engine can drive. Whether one is installed and signed in on the
  // machine is state, not a feature: read it from GET /api/runtimes.
  'runtime.openclaw',
  'runtime.clawboo-native',
  'runtime.claude-code',
  'runtime.codex',
  'runtime.hermes',
  // Chat: rooms inside a team, and 1:1 chats the engine runs itself.
  'chat.rooms',
  'chat.direct',
  // Boo Zero's one-to-one chat hands work to a team on a runtime the server runs.
  // Part of that chat's turn and its stream's `board` frames, so it has no route of
  // its own.
  'chat.handOffs',
  // Board: the check on finished worktree work, a team-chat check waiting for the
  // team folder (`checkHeldSince` on a task), a comment reaching a live run,
  // readable task ids, team labels, and the agent waking when something happens on
  // its task (a saved wake).
  'board.verification',
  'board.checkHold',
  'board.reportResult',
  'board.parentWaits',
  'board.steering',
  // Moves, Retry, Assign, approval answers and a team's work check take a person's
  // authority only from a request the person check lets through (the dashboard's
  // page, or a person a sign-in proxy vouched for). Others get 403 or, on a move,
  // no authority. A client acting for a person reads this first.
  'board.personCheck',
  'board.readableIds',
  'board.labels',
  // A person's inbox: read state per task on the server, and the small read behind
  // the badge. The event stream says when to read it (`?activity=1`).
  'board.inbox',
  'board.mainTasks',
  'board.wakes',
  'board.agentWakes',
  // A job's count of runs it started by itself, and a person's answer at its limit.
  'board.jobLimit',
  // Run endings told apart: empty replies, provider retries, budget and breaker stops.
  'board.endings',
  // A person's writes on the board: Reopen, tasks assigned to a person, and questions
  // an agent asks a person.
  'board.reopen',
  'board.personAssignees',
  'board.questions',
  'board.planDocuments',
  'board.planApproval',
  // The read-only view of a task's worktree, and its built-page preview.
  'workspace.view',
  'workspace.preview',
  // Per-agent surfaces.
  'agent.nativeShell',
  'agent.screenshots',
  'routines',
  // Shared memory, and whether similarity search may run at all.
  'memory',
  'memory.embeddings',
  'connectors',
  'connectors.custom',
  'connectors.broker',
  // Event streams that resume from Last-Event-ID (see RESUMABLE_STREAMS).
  'stream.teamChat.resume',
  'stream.agentChat.resume',
  'stream.events.resume',
  // The in-place update (POST /api/system/self-update) can succeed here.
  'system.selfUpdate',
  // Drain and hold (/api/system/hold): stop starting new agent runs, then wait
  // for the ones in flight before a stop or an update.
  'system.hold',
  // For a host that stops this engine when idle and starts it again on demand
  // (GET /api/system/idle): whether a person is here, whether work is going, and
  // when the next scheduled work is due. A client reports a person with
  // POST /api/system/presence.
  'system.idle',
  // Pause an agent, a team or a task tree, durably, until a person resumes it
  // (/api/pauses).
  'board.pause',
  // A sign-in proxy's signed identity tokens are verified, and the person each
  // names is recorded on approvals, chat messages and task edits. Who a request
  // is signed in as: GET /api/access/identity.
  'auth.proxyIdentity',
  // The app that started this engine (a desktop app) can name its own people on
  // the requests it signs, as `account:` people (CLAWBOO_APP_LINK_PUBLIC_KEY).
  'auth.appLink',
] as const
export type EngineFeature = (typeof ENGINE_FEATURES)[number]

const MINOR_RE = /^\d+\.\d+$/

export const engineCapabilitiesSchema = z.object({
  /** The running engine version, e.g. `0.6.0` (`0.0.0-dev` from a checkout). */
  version: z.string().min(1),
  /** The client-facing API revision (see `ENGINE_API_REVISION`). */
  apiRevision: z.number().int().positive(),
  /** The oldest `major.minor` whose clients this engine still serves. */
  supportFloor: z.string().regex(MINOR_RE),
  /** Feature flags by name. Unknown names are kept, so a newer engine's flags
   *  reach a client that does not know them yet. */
  features: z.record(z.string(), z.boolean()),
})
export type EngineCapabilities = z.infer<typeof engineCapabilitiesSchema>

/** `major.minor`, an optional `.patch`, then an optional prerelease and build. */
const VERSION_RE = /^v?(\d+)\.(\d+)(?:\.\d+)?(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

/** `[major, minor]` of a whole version string, or null when it is not one. */
function majorMinor(version: string): [number, number] | null {
  const m = VERSION_RE.exec(version.trim())
  return m ? [Number(m[1]), Number(m[2])] : null
}

/**
 * The support floor for an engine version: the previous minor of the same major.
 * A `x.0` release starts a new window, so its floor is itself. A version that is
 * not semver-shaped gets `0.0`, the widest floor.
 */
export function supportFloorFor(version: string): string {
  const parsed = majorMinor(version)
  if (!parsed) return '0.0'
  const [major, minor] = parsed
  return `${major}.${Math.max(0, minor - 1)}`
}

/**
 * Whether the engine described by `caps` still serves a client built against
 * engine version `clientVersion`: the client's `major.minor` is at or above the
 * engine's floor and not above the engine's own version. A newer client talking
 * to an older engine reads the feature flags instead.
 */
export function engineSupportsClient(caps: EngineCapabilities, clientVersion: string): boolean {
  const client = majorMinor(clientVersion)
  const floor = majorMinor(caps.supportFloor)
  const engine = majorMinor(caps.version)
  if (!client || !floor || !engine) return false
  const atLeast = (a: [number, number], b: [number, number]): boolean =>
    a[0] > b[0] || (a[0] === b[0] && a[1] >= b[1])
  return atLeast(client, floor) && atLeast(engine, client)
}

/** Whether `caps` reports `feature` on. False for a missing flag or no answer. */
export function engineHasFeature(
  caps: EngineCapabilities | null,
  feature: EngineFeature | (string & {}),
): boolean {
  return caps?.features[feature] === true
}

/**
 * GET /api/system/capabilities. Defensive: null on a network error, a non-2xx
 * answer or a body that does not match the schema. An engine older than the
 * route answers 404 in dev but its dashboard page (200, HTML) once built, so the
 * body check is what catches it there.
 */
export async function fetchEngineCapabilities(): Promise<EngineCapabilities | null> {
  try {
    const res = await apiFetch('/api/system/capabilities')
    if (!res.ok) return null
    const parsed = engineCapabilitiesSchema.safeParse(await res.json())
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}
