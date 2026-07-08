// The persistent, per-team SERVER orchestrator — the host that makes the pure
// engine (`createBoardOrchestrator`) run server-side, survive client disconnect,
// and resume after a restart. A process-singleton `Map<teamId, …>` lazily builds
// ONE long-lived engine per active team and holds its timers (the idle watchdog +
// the engine's internal reflect window) across REST requests.
//
// This is the deps RE-BINDING of the pure engine: every dep the (now-retired) browser
// binding used to wire from React/Zustand is here bound to a server source —
// `serverBoardClient` (direct DB), `serverDeliver` (adapter run + event drain),
// `persistTeamChatEntry` (chat-history). After the OpenClaw cutover this is the ONLY
// team-orchestration engine (native, OpenClaw, and mixed all run here). The engine's
// cascade invariants (sessionToTask 1:1, idle watchdog, reflect batching, stop-release,
// loop breakers) are UNCHANGED — they live inside the ported engine.

import { compactToolResultMarkdown } from '@clawboo/compaction'
import { agents, createDb, teams, type ClawbooDb } from '@clawboo/db'
import { createLogger } from '@clawboo/logger'
import {
  agentIdFromSessionKey,
  buildTeamSessionKey,
  createBoardOrchestrator,
  createNudgeQueue,
  type BoardOrchestrator,
  type KnownAgent,
} from '@clawboo/team-orchestration'
import { eq } from 'drizzle-orm'

import { resolveDelegationApproval } from '../../api/delegationApproval'
import { getRegistry } from '../agentSource/registry'
import { getDbPath } from '../db'
import { publishBoardChange } from './boardChangeBus'
import { booZeroForTeam, ensureNativeBooZero } from './booZero'
import { publishChatDelta } from './chatDeltaBus'
import { persistTeamChatEntry } from './persistTeamChatEntry'
import { isRiskyDelegation } from './riskyDelegation'
import { createServerBoardClient } from './serverBoardClient'
import { createServerDeliver, type RunEntry } from './serverDeliver'

const log = createLogger('team-orchestrator')

const DEFAULT_MAX_FANOUT = 8
const SWEEP_INTERVAL_MS = 30_000
const IDLE_TTL_MS = 30 * 60_000
const EVICT_SCAN_MS = 5 * 60_000

export interface EnqueueUserMessageInput {
  stimulus: string
  targetAgentId?: string | null
  /** Optional client-provided entryId for the persisted user message, so the thin
   *  client's optimistic bubble and the SSE-replayed user entry dedup by entryId. */
  userEntryId?: string
}

export interface TeamOrchestrator {
  readonly teamId: string
  /** Ingest a user message (202-style fire-and-forget): resolve the target, persist
   *  the user message, then run the target's turn — the engine reacts to its events. */
  enqueueUserMessage(input: EnqueueUserMessageInput): Promise<void>
  /** User Stop: bump the stop generation + abort in-flight runs → clean release. */
  stop(): void
  /** Tear down timers + the engine (idle eviction / shutdown). */
  dispose(): void
}

interface Instance {
  orchestrator: TeamOrchestrator
  touch(): void
  getLastActivity(): number
  dispose(): void
}

const instances = new Map<string, Instance>()

function activeTeamAgents(
  db: ClawbooDb,
  teamId: string,
): Array<{ id: string; name: string; archivedAt?: number | null }> {
  const rows = db.select().from(agents).where(eq(agents.teamId, teamId)).all() as Array<{
    id: string
    name: string
    archivedAt?: number | null
  }>
  return rows.filter((a) => !a.archivedAt)
}

function knownAgents(db: ClawbooDb, teamId: string): KnownAgent[] {
  const members = activeTeamAgents(db, teamId).map((a) => ({ id: a.id, name: a.name }))
  const bz = booZeroForTeam(db, teamId)
  if (bz && !members.some((a) => a.id === bz.id)) members.push(bz)
  return members
}

/** Resolve the team's reduce point: Boo Zero for an OpenClaw team (the universal
 *  leader, preserved from the browser path); else the explicit leader (when an active
 *  member), else the first active member. */
function resolveLeaderId(db: ClawbooDb, teamId: string): string | null {
  const bz = booZeroForTeam(db, teamId)
  if (bz) return bz.id
  const team = db.select().from(teams).where(eq(teams.id, teamId)).get() as
    | { leaderAgentId?: string | null }
    | undefined
  const members = activeTeamAgents(db, teamId)
  if (team?.leaderAgentId && members.some((a) => a.id === team.leaderAgentId))
    return team.leaderAgentId
  return members[0]?.id ?? null
}

/** Server-side @mention resolution (longest-prefix match), replicating the
 *  browser's `parseMention` — which stays browser-only (it has several SPA-feature
 *  consumers; duplicating this tiny pure routing here avoids moving it + 3 shims). */
function mentionTarget(message: string, roster: KnownAgent[]): string | null {
  if (!message.startsWith('@')) return null
  const afterAt = message.slice(1)
  const sorted = [...roster].sort((a, b) => b.name.length - a.name.length)
  for (const a of sorted) {
    if (afterAt.toLowerCase().startsWith(a.name.toLowerCase())) {
      const rest = afterAt.slice(a.name.length)
      if (rest.length === 0 || /^\s/.test(rest)) return a.id
    }
  }
  return null
}

function buildInstance(teamId: string, mcpBaseUrl: string | null): Instance {
  const db = createDb(getDbPath())
  let serverStopGen = 0
  let lastActivityAt = Date.now()
  const touch = (): void => {
    lastActivityAt = Date.now()
  }

  const abortMap = new Map<string, RunEntry>()
  const nudge = createNudgeQueue({
    onWedge: (sk) => {
      // A session whose turn boundary was never observed (a lost terminal): abort
      // its genuinely-still-running run so the nudge's force-idle flush can't start
      // a SECOND concurrent run on it.
      const e = abortMap.get(sk)
      if (e) void e.adapter.abort(e.run).catch(() => undefined)
    },
  })

  // Forward ref: `serverDeliver`'s drain calls back into the engine (created just
  // below). The closures run only at delivery time — long after `engineRef.current`
  // is set — so the non-null assertion is safe.
  const engineRef: { current: BoardOrchestrator | null } = { current: null }

  const deliver = createServerDeliver({
    db,
    teamId,
    mcpBaseUrl,
    nudge,
    abortMap,
    onEvent: (sk, ev) => engineRef.current!.onEvent(sk, ev),
    onSessionClosed: (sk) => engineRef.current!.onSessionClosed(sk),
    taskForSession: (sk) => engineRef.current!.taskForSession(sk),
    persistTurn: (sk, text) => {
      const agentId = agentIdFromSessionKey(sk)
      if (agentId)
        persistTeamChatEntry(db, { teamId, agentId, text, role: 'assistant', kind: 'assistant' })
    },
    // Tier-2 live tokens: fan a run's running assistant text to the team's in-memory
    // delta bus, which each open team-chat SSE stream forwards as a `delta` event.
    publishDelta: (sk, runId, text) => publishChatDelta(teamId, { sessionKey: sk, runId, text }),
  })

  const engine = createBoardOrchestrator({
    teamId,
    board: createServerBoardClient(db),
    known: () => knownAgents(db, teamId),
    leaderAgentId: () => resolveLeaderId(db, teamId),
    sessionKeyForAgent: (id) => buildTeamSessionKey(id, teamId),
    agentIdForSession: (sk) => agentIdFromSessionKey(sk),
    deliver,
    stopGen: () => serverStopGen,
    narrate: (sk, text) => {
      // Board→leader reflections (the per-task "✓ <agent> completed" marker + the
      // batched "[Task Update]" envelope) are INTERNAL orchestration signals, not
      // user-facing chat. The board task CARD is the completion surface (its status
      // pill + the report-up output), and the leader turns the "[Task Update]" into
      // a real chat message — so persisting these to the transcript only produced the
      // noisy per-task duplication (every delegate's reply shown 3×). Log them to the
      // tracelog for debugging instead of the chat. Errors are NOT lost: a failed
      // task shows on its card as a Blocked status + a board comment, and the leader
      // still reports it. The engine's essential leader DELIVERY (`deps.deliver`, the
      // separate call that feeds the "[Task Update]" to the leader as its next turn)
      // is untouched, so the synthesis cascade is unaffected.
      const agentId = agentIdFromSessionKey(sk)
      log.debug({ teamId, agentId, reflect: text }, 'team reflect (tracelog only, not chat)')
    },
    onBoardChange: (change) => {
      // Live-push each board mutation to the team's in-memory board bus; each open
      // team-chat SSE stream forwards it as a `board` event so the thin client's
      // BoardTaskCards update live during a cascade. SEPARATE from obs (which is fed
      // by serverBoardClient's emitEvent) — no double-emit.
      publishBoardChange(teamId, change)
    },
    // Compact a child's report-up summary before it's recorded/relayed (pure,
    // pass-through-safe, failure-preserving). Mirrors the browser binding.
    compact: (text: string) => compactToolResultMarkdown(text).text,
    caps: { maxFanout: DEFAULT_MAX_FANOUT },
    // Risky-delegation approval gate (parity with the retired browser binding): a
    // destructive/secret-touching delegation is surfaced on the leader's approval
    // queue (the DB-mediated `tool_call_approvals` handshake) before it runs; on
    // deny/timeout/expired the engine skips it + reflects to the leader. FAIL-CLOSED
    // (a transport error resolves to `timeout` → skip). Resolvable with NO Gateway
    // (native mode) via the REST ToolApprovalQueue.
    isRiskyDelegation,
    requestDelegationApproval: (input) => resolveDelegationApproval(db, input),
  })
  engineRef.current = engine

  // Ensure the DEFAULT-NATIVE Boo Zero exists BEFORE the first delivery so a native
  // team's `resolveLeaderId` / `knownAgents` can inject it as the reduce-point (created
  // once, shared teamless across all native teams; idempotent + a no-op for an OpenClaw
  // team, which keeps the Gateway Boo Zero). Then re-attach to durable in-flight work +
  // fire any ready plan step (mirrors the browser mounting resume() before its event
  // consumers), so a restart / team re-open resumes a stalled cascade.
  const ready = ensureNativeBooZero(db, getRegistry().nativeSource)
    .catch((err: unknown) => log.error({ err, teamId }, 'team-orchestrator ensure Boo Zero failed'))
    .then(() => engine.resume())
    .catch((err: unknown) => log.error({ err, teamId }, 'team-orchestrator resume failed'))

  // Idle watchdog: fail a delegate gone silent past the engine's
  // DELEGATION_IDLE_TIMEOUT_MS so the leader is never left standing.
  const sweep = setInterval(() => void engine.sweepStaleSessions(), SWEEP_INTERVAL_MS)
  sweep.unref?.()

  const orchestrator: TeamOrchestrator = {
    teamId,
    async enqueueUserMessage(input: EnqueueUserMessageInput): Promise<void> {
      touch()
      // Ensure the DEFAULT-NATIVE Boo Zero exists BEFORE resolving the roster/leader.
      // `ready` runs `ensureNativeBooZero`, so `knownAgents` / `resolveLeaderId` see it
      // and a native team's user turn routes to the native Boo Zero — NOT the OpenClaw
      // `main` fallback. (Resolving first, then awaiting, sent the first message to
      // `main` and orphaned it the moment the native Boo Zero materialized — the "I
      // chatted and the native team went empty" bug.)
      await ready
      const stimulus = input.stimulus
      const roster = knownAgents(db, teamId)
      if (roster.length === 0) return
      // Target priority: explicit targetAgentId > @mention > leader > first member.
      // For an OpenClaw team the leader IS Boo Zero (the universal reduce-point,
      // injected into the roster by `knownAgents`); a native team routes to its own
      // leader.
      const explicit =
        input.targetAgentId && roster.some((a) => a.id === input.targetAgentId)
          ? input.targetAgentId
          : null
      const targetId =
        explicit ?? mentionTarget(stimulus, roster) ?? resolveLeaderId(db, teamId) ?? roster[0]!.id
      // Persist the user message under the target's team key (observability seed).
      persistTeamChatEntry(db, {
        teamId,
        agentId: targetId,
        text: stimulus,
        role: 'user',
        kind: 'user',
        entryId: input.userEntryId,
      })
      // Run the target's turn through the SAME deliver primitive: it streams the
      // agent's events into the engine, which reacts to any `<delegate>`/`<plan>`.
      const sk = buildTeamSessionKey(targetId, teamId)
      // The user's own turn has no delegator to reflect a failure to, so on a failed
      // deliver we RECOVER in place rather than dumping the burden on the user: if the
      // cause is a down OpenClaw operator connection (the Gateway process can be up while
      // the operator socket is mid-reconnect after a restart/blip), reconnect + WAIT,
      // then retry the SAME turn ONCE. Only if that still fails do we surface a message —
      // so a transient down-state is invisible to the user, not a dead send + a resend.
      const isOperatorDown = (err: unknown): boolean =>
        err instanceof Error && /operator client unavailable|OpenClaw operator/i.test(err.message)
      const persistDeliverFailure = (operatorStillDown: boolean): void => {
        persistTeamChatEntry(db, {
          teamId,
          agentId: targetId,
          text: operatorStillDown
            ? 'Could not reach your OpenClaw agents — the Gateway may not be running. Start it from System settings, then send again.'
            : 'Could not reach the team right now. Please try again in a moment.',
          role: 'system',
          kind: 'meta',
        })
      }
      await deliver(sk, targetId, stimulus).catch(async (err: unknown) => {
        log.error({ err, teamId, targetId }, 'team-orchestrator user-turn delivery failed')
        if (isOperatorDown(err)) {
          const recovered = await getRegistry()
            .reconnectAndWaitOperator()
            .catch(() => false)
          if (recovered) {
            // Operator is back — retry the SAME turn transparently.
            await deliver(sk, targetId, stimulus).catch((retryErr: unknown) => {
              log.error({ err: retryErr, teamId, targetId }, 'team-orchestrator retry after reconnect failed')
              persistDeliverFailure(isOperatorDown(retryErr))
            })
            return
          }
          persistDeliverFailure(true)
          return
        }
        persistDeliverFailure(false)
      })
    },
    stop(): void {
      // Bump the stop generation SYNCHRONOUSLY before any await — the engine's
      // in-flight work bails at its next checkpoint, and the resulting `done:aborted`
      // events are seen as a clean Stop (release to `todo`, never block / reflect a
      // failure).
      serverStopGen++
      for (const [, e] of abortMap) void e.adapter.abort(e.run).catch(() => undefined)
      touch()
    },
    dispose(): void {
      clearInterval(sweep)
      serverStopGen++
      for (const [, e] of abortMap) void e.adapter.abort(e.run).catch(() => undefined)
      abortMap.clear()
      engine.reset()
      nudge.reset()
    },
  }

  return {
    orchestrator,
    touch,
    getLastActivity: () => lastActivityAt,
    dispose: () => orchestrator.dispose(),
  }
}

/** Get (or lazily build) the persistent orchestrator for a team. Concurrent first
 *  calls get the same instance (the Map set is synchronous); the nudge queue
 *  serializes their deliveries. */
export function getTeamOrchestrator(
  teamId: string,
  opts?: { mcpBaseUrl?: string | null },
): TeamOrchestrator {
  let inst = instances.get(teamId)
  if (!inst) {
    inst = buildInstance(teamId, opts?.mcpBaseUrl ?? null)
    instances.set(teamId, inst)
  }
  inst.touch()
  return inst.orchestrator
}

/** True when a team has a live orchestrator (introspection / tests). */
export function hasTeamOrchestrator(teamId: string): boolean {
  return instances.has(teamId)
}

/** Test/shutdown helper: dispose + drop all live orchestrators. */
export function resetTeamOrchestrators(): void {
  for (const [, inst] of instances) inst.dispose()
  instances.clear()
}

// Soft idle-TTL eviction: a team orchestrator idle past IDLE_TTL_MS is disposed
// (timers cleared, engine reset); a later message re-instantiates it + re-resumes.
const evictScan = setInterval(() => {
  const now = Date.now()
  for (const [teamId, inst] of instances) {
    if (now - inst.getLastActivity() > IDLE_TTL_MS) {
      try {
        inst.dispose()
      } catch (err) {
        log.error({ err, teamId }, 'team-orchestrator eviction dispose failed')
      }
      instances.delete(teamId)
    }
  }
}, EVICT_SCAN_MS)
evictScan.unref?.()
