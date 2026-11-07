// ─── runTeamExchange: the production trigger for the peer-chat engine ─────────
// The invokable entry point that turns the unit-proven exchange engine into a
// running production path. It assembles the team's members into chat
// participants, drives the bounded ping-pong (`runExchange`) with REAL runtime
// adapters via `dispatchChatTurn`, and projects the speaker-selection +
// turn-bound lifecycle into the obs event log.
//
// EXPLICIT KICKOFF ONLY — this runs when something calls it (the REST endpoint /
// a future UI "start discussion" button). It is NOT an autonomous loop: nothing
// fires real model turns on its own, so the cascade-prevention guardrails stay
// intact. The board-reflection lifecycle stimulus (re-invoke the leader when a
// specialist report lands) is a deliberate, documented future opt-in.
//
// CAPABILITY-DRIVEN, never by runtime name (the contract `dispatchChatTurn`'s
// header used to over-claim): each participant's adapter is constructed for its
// class — a connected-substrate runtime (OpenClaw) over the operator connection,
// an ephemeral/persistent runtime (native + wrapped-oneshot) over its driver
// factory — and `resolveRuntimeIntegration(...).home.kind` decides whether a
// vault key set rides the run. A turn itself runs through `dispatchChatTurn`
// (the one-shot heartbeat-restore path); a persistent runtime resumes its prior
// session via the stored native id, so it is not re-initialized.

import {
  agents,
  resolveRoomForTeam,
  teams,
  pauseFor,
  startRefusedBy,
  type ClawbooDb,
  type DbAgent,
  type DbTeam,
} from '@clawboo/db'
import { resolveRuntimeIntegration, type RuntimeAdapter } from '@clawboo/executor'
import { createLogger } from '@clawboo/logger'
import { eq } from 'drizzle-orm'

import { getRegistry } from '../agentSource'
import { budgetPreflight } from '../budgetPreflight'
import { MutexAcquireTimeoutError } from '@clawboo/worktrees'
import { HOME_MUTEX_ACQUIRE_MS, homeDispatchMutex } from '../executorRunner'
import { emitEvent } from '../obs'
import { pauseRefusalText } from '../pauseBus'
import { RunQueueAbortedError, withRunSlot, PERSON_TURN } from '../runSlots'
import type { RuntimeRunContext } from '../runtimes/types'
import { adapterFactoryFor } from '../runtimes'
import { getDescriptor, isRuntimeId } from '../runtimes/descriptor'
import { runtimeIdentityHomePath } from '../runtimes/identityHome'
import { startFolderRun } from '../runtimes/teamFolderActivity'
import { teamWorkdirFor } from '../runtimes/teamWorkdir'
import { buildOpenClawServerAdapter } from '../runtimes/serverAdapter'
import { resolveRuntimeKeyForRuntime } from '../secretsVault'
import { dispatchChatTurn } from './dispatchChatTurn'
import {
  DEFAULT_MAX_EXCHANGE_TURNS,
  runExchange,
  type ChatTurnDispatcher,
  type ChatTurnOutcome,
  type ExchangeEmit,
  type ExchangeResult,
} from './exchange'
import {
  connectedAgentKey,
  connectedAgentMutex,
  type OperatorClientLike,
} from '../routines/openclawDispatch'
import type { ChatParticipant } from './selectNextSpeaker'

/** The minimal logging surface (a pino logger satisfies it). */
interface ExchangeLogger {
  warn(obj: Record<string, unknown>, msg: string): void
}

const defaultLog: ExchangeLogger = createLogger('team-chat')

type ChatAdapterFactory = (ctx: RuntimeRunContext) => RuntimeAdapter

export interface RunTeamExchangeDeps {
  db: ClawbooDb
  teamId: string
  /** The initiating message for the first speaker's turn (e.g. the user's prompt). */
  stimulus?: string | null
  /** Agent ids seeded to speak first (defaults to the team leader). */
  firstSpeakers?: string[]
  maxExchangeTurns?: number
  mcpBaseUrl?: string | null
  /** Aborts the exchange between turns (client disconnect). */
  signal?: AbortSignal
  // ── Test seams ──────────────────────────────────────────────────────────
  /** Override adapter construction per participant (tests inject fakes). Default:
   *  capability-driven — operator client for OpenClaw, driver factory otherwise. */
  makeAdapterFor?: (participant: ChatParticipant) => ChatAdapterFactory | null
  /** The live operator client for the connected-substrate (OpenClaw) path. */
  getOperatorClient?: () => OperatorClientLike | null
  /** Override the obs projection (tests). Default: emit speaker_selected/turn_bound_hit. */
  emit?: ExchangeEmit
  log?: ExchangeLogger
}

export interface RunTeamExchangeResult {
  ok: boolean
  roomId?: string
  result?: ExchangeResult
  error?: string
}

/**
 * Enforce the single-reduce-point invariant: at most ONE participant may be the
 * leader. A mis-assembled team with two leaders silently degraded before (the
 * `find(isLeader)` only ever saw the first); warn + normalize to the first so
 * the problem surfaces instead of a second "leader" being treated as an ordinary
 * obligated speaker.
 */
export function normalizeSingleLeader(
  participants: ChatParticipant[],
  log: ExchangeLogger = defaultLog,
): ChatParticipant[] {
  const leaders = participants.filter((p) => p.isLeader)
  if (leaders.length <= 1) return participants
  const keep = leaders[0]!.agentId
  log.warn(
    { leaderIds: leaders.map((p) => p.agentId), keeping: keep },
    'team-chat: multiple leaders flagged; keeping the first (single-reduce-point invariant)',
  )
  return participants.map((p) => (p.isLeader && p.agentId !== keep ? { ...p, isLeader: false } : p))
}

/** Vault → spawned-run env, mirroring the runtimes REST run handler / wake-bridge.
 *  A connected-substrate runtime needs no vault key (it rides the operator conn). */
function buildApiKeyEnv(runtime: string): Record<string, string> {
  const env: Record<string, string> = {}
  if (!isRuntimeId(runtime)) return env
  const d = getDescriptor(runtime)
  for (const v of [d.envVar, ...(d.altEnvVars ?? [])]) {
    if (!v) continue
    const key = resolveRuntimeKeyForRuntime(runtime, v)
    if (key) env[v] = key
  }
  return env
}

/** Default capability-driven adapter construction (never by runtime name beyond
 *  the connected/spawned split the registry itself draws). */
function defaultAdapterFactoryFor(
  participant: ChatParticipant,
  deps: { getOperatorClient: () => OperatorClientLike | null; log: ExchangeLogger },
): ChatAdapterFactory | null {
  const runtime = participant.runtime
  if (isRuntimeId(runtime)) return adapterFactoryFor(runtime)
  if (runtime === 'openclaw') {
    // Shared with serverDeliver's openclaw arm so the connected-substrate construction
    // can't drift between the two server-side team paths.
    const adapter = buildOpenClawServerAdapter(deps.getOperatorClient)
    if (!adapter) {
      deps.log.warn(
        { runtime, agentId: participant.agentId },
        'team-chat: operator client unavailable; skipping openclaw participant',
      )
      return null
    }
    return () => adapter
  }
  // Fail CLOSED for an unrecognized runtime (a data typo / a future runtime) —
  // never silently dispatch it; just drop it from this exchange.
  deps.log.warn(
    { runtime, agentId: participant.agentId },
    'team-chat: unknown runtime; skipping participant',
  )
  return null
}

/** The exchanges running now, so a pause can end the ones it covers. */
interface LiveExchange {
  teamId: string
  agentIds: string[]
  stop: () => void
}
const liveExchanges = new Set<LiveExchange>()

/**
 * A pause covers a team or an agent speaking in these exchanges: end them. Its abort
 * reaches a turn running or waiting for a slot, so none goes on holding the room
 * for a resume that may be days away. The next exchange skips a paused speaker.
 */
export function stopPausedExchanges(
  covers: (run: { agentId: string; teamId: string }) => boolean,
): void {
  for (const live of liveExchanges) {
    if (live.agentIds.some((agentId) => covers({ agentId, teamId: live.teamId }))) live.stop()
  }
}

/**
 * Run a bounded team-chat exchange. PRECONDITION: the caller MUST hold the room lock
 * (`tryAcquireRoom`/`releaseRoom` from `./roomLock`) for this team's room. Today the
 * REST endpoint (`teamChatExchangePOST`) is the sole caller and acquires it; a future
 * internal trigger (the board-reflection lifecycle stimulus) MUST acquire it too — two
 * concurrent exchanges on one room would race the leader-state KV + double-post.
 */
export async function runTeamExchange(deps: RunTeamExchangeDeps): Promise<RunTeamExchangeResult> {
  const { db, teamId } = deps
  const log = deps.log ?? defaultLog
  // The caller's own cancel, or a pause (see `stopPausedExchanges`).
  const stop = new AbortController()
  const onCallerAbort = (): void => stop.abort()
  if (deps.signal?.aborted) stop.abort()
  else deps.signal?.addEventListener('abort', onCallerAbort, { once: true })
  const signal = stop.signal

  const team =
    (db.select().from(teams).where(eq(teams.id, teamId)).get() as DbTeam | undefined) ?? null
  if (!team) return { ok: false, error: 'team not found' }

  const rows = db.select().from(agents).where(eq(agents.teamId, teamId)).all() as DbAgent[]
  const active = rows.filter((a) => !a.archivedAt)
  if (active.length === 0) return { ok: false, error: 'team has no agents' }
  const agentRowById = new Map(active.map((a) => [a.id, a]))

  const participants = normalizeSingleLeader(
    active.map((a) => ({
      agentId: a.id,
      runtime: a.runtime,
      isLeader: a.id === team.leaderAgentId,
    })),
    log,
  )

  // Reject a firstSpeaker that isn't a team member (no silent ignore — the caller
  // gets a clear refusal instead of a turn that never happens).
  if (deps.firstSpeakers && deps.firstSpeakers.length) {
    const memberIds = new Set(participants.map((p) => p.agentId))
    const foreign = deps.firstSpeakers.find((s) => !memberIds.has(s))
    if (foreign) return { ok: false, error: `unknown first speaker: ${foreign}` }
  }

  // Pre-flight cap gate: a paused CAP budget refuses the whole exchange before any
  // real model turn runs. The team scope gates every speaker; then each agent that
  // will actually speak (the leader by default + any seeded firstSpeakers) is checked
  // on its own behalf — mirroring the executor's per-assignee gate so a paused
  // specialist isn't dispatched one billed turn before the reactive halt.
  const leaderId = participants.find((p) => p.isLeader)?.agentId ?? null
  const teamPre = budgetPreflight(db, { teamId })
  if (teamPre.blocked) return { ok: false, error: `budget_paused:${teamPre.scope}` }
  // A paused or archived team starts no exchange. A paused agent only loses its
  // own turns (see `dispatch`).
  const refused = startRefusedBy(db, { teamId })
  if (refused) return { ok: false, error: pauseRefusalText(refused) }
  const speakerIds = new Set<string>([
    ...(deps.firstSpeakers ?? []),
    ...(leaderId ? [leaderId] : []),
  ])
  for (const id of speakerIds) {
    const pre = budgetPreflight(db, { agentId: id })
    if (pre.blocked) return { ok: false, error: `budget_paused:${pre.scope}` }
  }

  // Clamp the caller's turn cap to a sane server-side ceiling — it drives REAL model
  // turns, so an unbounded value is a cost hazard. Unset ⇒ runExchange's default.
  const clampedMaxTurns =
    deps.maxExchangeTurns != null
      ? Math.max(
          1,
          Math.min(deps.maxExchangeTurns, DEFAULT_MAX_EXCHANGE_TURNS * participants.length),
        )
      : undefined

  const roomId = resolveRoomForTeam(teamId)
  const getOperatorClient = deps.getOperatorClient ?? (() => getRegistry().source.operatorClient())
  const resolveFactory =
    deps.makeAdapterFor ??
    ((p: ChatParticipant) => defaultAdapterFactoryFor(p, { getOperatorClient, log }))

  // Resolve each participant's adapter factory once + read its runtime CLASS from
  // the capabilities seam (the capability-driven branch). An unresolved runtime
  // is dropped (logged above); a probe adapter is never started, so construction
  // is cheap + side-effect-free.
  const resolved = new Map<string, { factory: ChatAdapterFactory; homeKind: string }>()
  for (const p of participants) {
    const factory = resolveFactory(p)
    if (!factory) continue
    let homeKind = 'ephemeral'
    try {
      homeKind = resolveRuntimeIntegration(factory({}).capabilities()).home.kind
    } catch {
      /* can't read caps → treat as a one-shot (the conservative default) */
    }
    resolved.set(p.agentId, { factory, homeKind })
  }

  const dispatchTurn: ChatTurnDispatcher = async (participant, turnIndex) => {
    const r = resolved.get(participant.agentId)
    if (!r) return { obligations: [] } // unresolved runtime → no post, no obligation
    const apiKeyEnv = r.homeKind === 'connected' ? {} : buildApiKeyEnv(participant.runtime)
    // A persistent runtime reuses its per-identity home AND serializes through the
    // SHARED home mutex, so a chat turn and an executor run for the same (runtime,
    // agent) never write one native state.db concurrently.
    const homeDir =
      r.homeKind === 'persistent'
        ? runtimeIdentityHomePath(participant.runtime, participant.agentId)
        : null
    // Claude Code / Codex / Hermes / Native start in the team's shared folder.
    const cwd = teamWorkdirFor(participant.runtime, teamId)
    const runTurn = () =>
      dispatchChatTurn(
        {
          db,
          participant,
          roomId,
          teamId,
          makeAdapter: r.factory,
          stimulus: turnIndex === 1 ? (deps.stimulus ?? null) : null,
          mcpBaseUrl: deps.mcpBaseUrl ?? null,
          ...(homeDir ? { homeDir } : {}),
          ...(cwd ? { cwd } : {}),
          signal,
          ...(Object.keys(apiKeyEnv).length ? { apiKeyEnv } : {}),
        },
        turnIndex,
      )
    // A turn in the team folder reports it, so a team-chat work check waits for it
    // (see teamFolderActivity).
    const turn = async () => {
      const folderRun = cwd ? startFolderRun(cwd, participant.agentId) : null
      try {
        return await runTurn()
      } finally {
        folderRun?.release()
      }
    }
    // Persistent runtimes serialize on the per-home mutex (shared with the executor).
    if (homeDir)
      return homeDispatchMutex
        .run(homeDir, turn, { acquireTimeoutMs: HOME_MUTEX_ACQUIRE_MS })
        .catch((err: unknown) => {
          // ONE participant's home being wedged must not end the exchange for
          // everyone else. `runExchange` awaits this without a catch, so an
          // acquire timeout rejected before the remaining participants were ever
          // dispatched. Same shape as the unresolved-runtime case above: this
          // speaker contributes nothing and the round carries on.
          if (err instanceof MutexAcquireTimeoutError) return { obligations: [] }
          throw err
        })
    // A CONNECTED (OpenClaw) turn serializes on the SAME per-gateway-agent mutex the
    // routine dispatcher uses, so a chat turn and a routine fire never open two
    // overlapping Gateway sessions on one physical agent. Ephemeral runtimes need none.
    if (r.homeKind === 'connected') {
      const row = agentRowById.get(participant.agentId)
      if (row) return connectedAgentMutex.run(connectedAgentKey(row), turn)
    }
    return turn()
  }
  // Every turn takes one of the process's run slots BEFORE its agent's lock (see
  // runSlots). A client that leaves while a turn waits for its slot ends the wait:
  // that speaker contributes nothing, and the exchange stops at its abort check.
  const dispatch: ChatTurnDispatcher = (participant, turnIndex) => {
    const r = resolved.get(participant.agentId)
    // An unresolved runtime runs nothing, so its turn does not wait for a slot.
    if (!r) return Promise.resolve({ obligations: [] })
    // Nor does a paused speaker: it contributes nothing, and waiting for its resume
    // would hold the room.
    const speaker = { agentId: participant.agentId, teamId }
    if (pauseFor(db, speaker)) return Promise.resolve({ obligations: [] })
    // The lock dispatchTurn takes, so two turns of one agent never hold two slots.
    const row = agentRowById.get(participant.agentId)
    const key =
      r.homeKind === 'persistent'
        ? runtimeIdentityHomePath(participant.runtime, participant.agentId)
        : r.homeKind === 'connected' && row
          ? connectedAgentKey(row)
          : null
    return withRunSlot(() => dispatchTurn(participant, turnIndex), {
      key,
      signal,
      rank: PERSON_TURN,
      paused: () => pauseFor(db, speaker) !== null,
    }).catch((err: unknown): ChatTurnOutcome => {
      if (err instanceof RunQueueAbortedError) return { obligations: [] }
      throw err
    })
  }

  const emit: ExchangeEmit = deps.emit ?? {
    speakerSelected: (d) =>
      emitEvent(db, {
        kind: 'speaker_selected',
        teamId,
        agentId: d.speakerAgentId,
        data: {
          roomId: d.roomId,
          speakerAgentId: d.speakerAgentId,
          policy: d.policy,
          exchangeTurn: d.exchangeTurn,
        },
      }),
    turnBoundHit: (d) =>
      emitEvent(db, {
        kind: 'turn_bound_hit',
        teamId,
        data: {
          roomId: d.roomId,
          reason: d.reason,
          maxExchangeTurns: d.maxExchangeTurns,
          turnsTaken: d.turnsTaken,
        },
      }),
  }

  const live: LiveExchange = {
    teamId,
    agentIds: participants.map((p) => p.agentId),
    stop: () => stop.abort(),
  }
  liveExchanges.add(live)
  try {
    const result = await runExchange({
      roomId,
      participants,
      ...(deps.firstSpeakers ? { firstSpeakers: deps.firstSpeakers } : {}),
      dispatch,
      emit,
      ...(clampedMaxTurns != null ? { maxExchangeTurns: clampedMaxTurns } : {}),
      signal,
    })
    return { ok: true, roomId, result }
  } finally {
    liveExchanges.delete(live)
    deps.signal?.removeEventListener('abort', onCallerAbort)
  }
}
