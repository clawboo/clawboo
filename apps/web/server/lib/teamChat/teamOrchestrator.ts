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
import { agents, enqueueInbox, teams, type ClawbooDb } from '@clawboo/db'
import { createLogger } from '@clawboo/logger'
import {
  agentIdFromSessionKey,
  buildTeamSessionKey,
  createBoardOrchestrator,
  createNudgeQueue,
  HUMAN_TURN,
  type BoardOrchestrator,
  type KnownAgent,
} from '@clawboo/team-orchestration'
import { eq } from 'drizzle-orm'

import { resolveDelegationApproval } from '../../api/delegationApproval'
import { getRegistry } from '../agentSource/registry'
import { getDb } from '../db'
import { publishAgentStatus } from './agentStatusBus'
import { publishBoardChange } from './boardChangeBus'
import { booZeroForTeam, ensureNativeBooZero } from './booZero'
import { auditCapHit } from './capHitAudit'
import { publishChatDelta } from './chatDeltaBus'
import { persistTeamChatEntry } from './persistTeamChatEntry'
import { NATIVE_SIGNAL_CONTEXT_KEY } from '../runtimes/native/nativeDriver'
import { isRiskyDelegation } from './riskyDelegation'
import { createServerBoardClient } from './serverBoardClient'
import { createServerDeliver, type RunEntry } from './serverDeliver'

const log = createLogger('team-orchestrator')

const DEFAULT_MAX_FANOUT = 8
const SWEEP_INTERVAL_MS = 30_000
const IDLE_TTL_MS = 30 * 60_000
const EVICT_SCAN_MS = 5 * 60_000
/**
 * Hard ceiling for the quiescence gate. A run registers itself for its whole
 * lifetime, so "a run is in flight" normally protects a working cascade from
 * eviction — but a run that HANGS (no terminal, no events, nothing to time it
 * out yet) would keep that registration forever and make the instance immortal:
 * never evicted, holding its sweep interval and engine for the life of the
 * process. Past this ceiling an instance is evicted even while it looks busy.
 *
 * Safe because the idle clock is refreshed by every observed run event: a
 * genuinely-working cascade never ages toward this at all, so the only thing it
 * can reap is a run that has been completely silent for two hours.
 */
const HARD_TTL_MS = 4 * IDLE_TTL_MS
/** Window in which an identical alert for the same agent is logged but not
 *  re-posted to the transcript (one problem ⇒ one chat line). */
const ALERT_DEDUPE_MS = 60_000

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
  /** Re-attach durable in-flight work + fire anything ready (the engine's
   *  `resume()`): the server dispatch pump's entry point. Idempotent — tracked
   *  sessions are skipped and the atomic claim-409 arbitrates double-fires. */
  pump(): Promise<void>
  /** Ambient mid-run push: deliver a short signal INTO an agent's live run via
   *  the adapter's writeContext seam (the native driver routes the reserved key
   *  into the conversation's input queue, read at its next turn iteration).
   *  Best-effort no-op when the agent has no live run — durable delivery is the
   *  mailbox's job, not this seam's. */
  signalAgent(agentId: string, text: string): void
  /** An out-of-band release (stale sweep, orphan reap, a human moving the card)
   *  freed a task this engine may still have mapped to a session. Forget it, so
   *  the ready-pump can re-fire the work and the idle watchdog stops owning a run
   *  nobody is driving. Refused while a live run still holds the session. */
  detachTask(taskId: string): boolean
  /** Tear down timers + the engine (idle eviction / shutdown). */
  dispose(): void
}

interface Instance {
  orchestrator: TeamOrchestrator
  touch(): void
  getLastActivity(): number
  /** No run in flight — safe to evict. A cascade the user walked away from is
   *  NOT quiescent, so the idle-TTL scan can never dispose it mid-work. */
  isQuiescent(): boolean
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
    { leaderAgentId?: string | null } | undefined
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
  const db = getDb()
  let serverStopGen = 0
  let lastActivityAt = Date.now()
  const touch = (): void => {
    lastActivityAt = Date.now()
  }

  const abortMap = new Map<string, RunEntry>()
  /** `(agent, alert text)` → last surfaced-at, so one problem is one chat line. */
  const alertsSeen = new Map<string, number>()
  const nudge = createNudgeQueue({
    onWedge: (sk) => {
      // A session whose turn boundary was never observed (a lost terminal): abort
      // its genuinely-still-running run so the nudge's force-idle flush can't start
      // a SECOND concurrent run on it.
      const e = abortMap.get(sk)
      if (e) {
        // Not a user Stop: mark it so the drain reports the kill instead of
        // reading the resulting clean `done: aborted` as a deliberate silence.
        e.serverAbortReason = 'the run stopped responding and was ended'
        void e.adapter.abort(e.run).catch(() => undefined)
      }
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
    onEvent: (sk, ev) => {
      // ENGINE ACTIVITY IS ACTIVITY. The idle clock used to advance only on a
      // USER message, so a long autonomous cascade — the exact "kick it off and
      // walk away" case — looked idle and was evicted mid-flight at IDLE_TTL_MS.
      // Every observed run event now refreshes it, so an instance ages out only
      // when the TEAM is genuinely quiet, not when the human is.
      touch()
      return engineRef.current!.onEvent(sk, ev)
    },
    // Deliberately does NOT `touch()`: a closing session is the END of activity,
    // and refreshing the clock here would push out the eviction of an instance
    // whose runs have all finished — the case the idle TTL exists to reclaim.
    onSessionClosed: (sk) => engineRef.current!.onSessionClosed(sk),
    taskForSession: (sk) => engineRef.current!.taskForSession(sk),
    // The SAME resolution the engine uses for its reduce point, so "who leads" has
    // one answer whether the question comes from the reflection router or from the
    // prompt builder.
    leaderAgentId: () => resolveLeaderId(db, teamId),
    persistTurn: (sk, text) => {
      const agentId = agentIdFromSessionKey(sk)
      if (!agentId) return false
      // Report back whether the entry actually reached the transcript — a `false`
      // makes the drain publish a CLEARING delta so a streamed-but-uncommitted turn
      // never leaves a lingering StreamingCard.
      return persistTeamChatEntry(db, {
        teamId,
        agentId,
        text,
        role: 'assistant',
        kind: 'assistant',
      })
    },
    // A system notice, not the agent's turn: `role: 'system'` also keeps it clear
    // of the assistant-only control-token drop, so a failure reason can never be
    // mistaken for a refusal and silently discarded.
    persistMeta: (sk, text) => {
      const agentId = agentIdFromSessionKey(sk)
      if (!agentId) return false
      return persistTeamChatEntry(db, {
        teamId,
        agentId,
        text,
        role: 'system',
        kind: 'meta',
      })
    },
    // Tier-2 live tokens: fan a run's running assistant text to the team's in-memory
    // delta bus, which each open team-chat SSE stream forwards as a `delta` event.
    publishDelta: (sk, runId, text) => publishChatDelta(teamId, { sessionKey: sk, runId, text }),
    // Left-pane liveness: fan run-boundary working/idle signals to the team's status
    // bus, which each open team-chat SSE stream forwards as a `status` event; the
    // thin client patches the fleet store so the sidebar badges track the cascade.
    publishStatus: (agentId, status) => publishAgentStatus(teamId, { agentId, status }),
  })

  // A run registers in `abortMap` only AFTER `adapter.start` resolves — behind a
  // mkdir, a mutex acquire and process spawn. `touch()`ing at the CALL means the
  // clock is fresh for that whole window, so an eviction scan can't land on a
  // delivery that is in flight but not yet trackable.
  const trackedDeliver: typeof deliver = (sk, agentId, task, origin) => {
    touch()
    return deliver(sk, agentId, task, origin)
  }

  const engine = createBoardOrchestrator({
    teamId,
    board: createServerBoardClient(db),
    known: () => knownAgents(db, teamId),
    leaderAgentId: () => resolveLeaderId(db, teamId),
    sessionKeyForAgent: (id) => buildTeamSessionKey(id, teamId),
    // "A live run owns this session" answered from the map that already tracks
    // exactly that, rather than a marker kept for this one question: `abortMap`
    // is populated only after `adapter.start` resolves and cleared on BOTH the
    // terminal and the no-terminal paths, so it cannot strand a permanent busy
    // that would make `detachTask` refuse forever.
    isSessionBusy: (sk) => abortMap.has(sk),
    agentIdForSession: (sk) => agentIdFromSessionKey(sk),
    deliver: trackedDeliver,
    stopGen: () => serverStopGen,
    narrate: (sk, text, kind) => {
      // An `alert` is a coordination FAILURE the recipient will never otherwise
      // learn about (task updates whose delivery exhausted its retries). It is
      // exempt from the tracelog-only rule below — a dropped update that only
      // ever reached `log.debug` is precisely how a cascade goes quiet without
      // anyone noticing. Surface it in the transcript.
      if (kind === 'alert') {
        const alertAgentId = agentIdFromSessionKey(sk)
        // One line per problem, not per victim: a fan-out that fails delivery to
        // several sessions raises the same alert repeatedly, and a wall of
        // identical notices is its own kind of silence. Log every occurrence,
        // persist the first of each within the window.
        const dedupeKey = `${alertAgentId ?? '?'}::${text}`
        const now = Date.now()
        const lastAt = alertsSeen.get(dedupeKey)
        const isRepeat = lastAt !== undefined && now - lastAt < ALERT_DEDUPE_MS
        alertsSeen.set(dedupeKey, now)
        for (const [k, ts] of alertsSeen) if (now - ts > ALERT_DEDUPE_MS) alertsSeen.delete(k)
        if (alertAgentId && !isRepeat) {
          try {
            persistTeamChatEntry(db, {
              teamId,
              agentId: alertAgentId,
              text,
              role: 'system',
              kind: 'meta',
            })
          } catch (err) {
            log.error({ err, teamId, agentId: alertAgentId }, 'team alert persist failed')
          }
          // Durable copy: the chat line informs the HUMAN; the mailbox row makes
          // the AGENT hear it too (next digest / MCP piggyback), and it survives
          // eviction and restarts.
          try {
            enqueueInbox(db, { agentId: alertAgentId, teamId, kind: 'alert', body: text })
          } catch (err) {
            log.error({ err, teamId, agentId: alertAgentId }, 'team alert inbox write failed')
          }
        }
        log.warn(
          { teamId, agentId: alertAgentId, alert: text, suppressed: isRepeat },
          'team coordination alert',
        )
        return
      }
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
    // Write the `cap_hit` audit row the Governance dashboard documents. The engine
    // has fired this callback since the caps shipped; nothing was wired to it, so
    // `eventType=cap_hit` was always empty in the audit feed.
    onCapHit: (info) => auditCapHit(db, teamId, info, DEFAULT_MAX_FANOUT),
    // Failed-delegation runs are ABORTED, not just board-failed: the watchdog /
    // session-close path kills the live process so a failed task never leaves a
    // zombie run behind it.
    abortSession: (sk) => {
      const e = abortMap.get(sk)
      if (e) void e.adapter.abort(e.run).catch(() => undefined)
    },
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
  const sweep = setInterval(() => {
    // A rejected sweep used to be a bare `void` — an unhandled rejection with no
    // trace. The watchdog is the only thing that fails a silent delegate, so its
    // failing silently is precisely the case an operator needs to see.
    engine
      .sweepStaleSessions()
      .catch((err: unknown) => log.error({ err, teamId }, 'idle-watchdog sweep failed'))
  }, SWEEP_INTERVAL_MS)
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
      await deliver(sk, targetId, stimulus, HUMAN_TURN).catch(async (err: unknown) => {
        log.error({ err, teamId, targetId }, 'team-orchestrator user-turn delivery failed')
        if (isOperatorDown(err)) {
          const recovered = await getRegistry()
            .reconnectAndWaitOperator()
            .catch(() => false)
          if (recovered) {
            // Operator is back — retry the SAME turn transparently.
            await deliver(sk, targetId, stimulus, HUMAN_TURN).catch((retryErr: unknown) => {
              log.error(
                { err: retryErr, teamId, targetId },
                'team-orchestrator retry after reconnect failed',
              )
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
      // Queued (not-yet-started) deliveries must die with the Stop too: a
      // markIdle after the aborts would otherwise FLUSH them into brand-new
      // post-Stop runs. Dropping them loses nothing durable — task updates and
      // alerts live in the mailbox now, and stopped work is tombstoned below.
      nudge.reset()
      // Durable Stop: write the cancelled markers NOW, independent of whether the
      // aborts' terminals ever land (a restart mid-stop must not let the pump
      // refire the halted cascade as "infra death").
      void engine.markStopped().catch((err: unknown) => {
        log.error({ err, teamId }, 'team-orchestrator markStopped failed')
      })
      touch()
    },
    async pump(): Promise<void> {
      await ready // never race the Boo-Zero bootstrap / initial resume
      await engine.resume()
    },
    detachTask(taskId: string): boolean {
      return engine.detachTask(taskId)
    },
    signalAgent(agentId: string, text: string): void {
      const sk = buildTeamSessionKey(agentId, teamId)
      const entry = abortMap.get(sk)
      if (!entry) return // no live run — the mailbox/digest covers delivery
      // ASK, don't hope. On a non-steerable runtime `writeContext` still resolves,
      // it just writes somewhere no model reads: a cwd file for the spawned CLIs,
      // a Gateway agent file for OpenClaw. Calling it there looks like delivery in
      // the logs while delivering nothing, which is worse than not calling it —
      // the durable mailbox is what actually reaches those runtimes, and it has
      // already recorded this notice by the time we get here.
      if (!entry.adapter.capabilities().steerable) return
      void entry.adapter
        .writeContext(entry.run, NATIVE_SIGNAL_CONTEXT_KEY, text)
        .catch(() => undefined)
    },
    dispose(): void {
      clearInterval(sweep)
      serverStopGen++
      // Tearing down with runs still in flight (process shutdown — idle eviction
      // is now quiescence-gated and cannot land here) parks work rather than
      // vaporizing it: the aborts below are async, and `engine.reset()` clears
      // `sessionToTask` synchronously, so the resulting `done:aborted` terminals
      // arrive at an engine that no longer knows their task and no-op. Nobody
      // would ever learn the cascade stopped. Say so in the transcript FIRST —
      // the board rows stay `in_progress` and the engine's `resume()` re-attaches
      // them when the team is next opened.
      const stranded = [...abortMap.keys()]
        .map((sk) => agentIdFromSessionKey(sk))
        .filter((id): id is string => id !== null)
      if (stranded.length > 0) {
        // Whole block in the try: `knownAgents` / `resolveLeaderId` are DB reads,
        // and dispose runs during shutdown (and from the eviction loop, where a
        // throw would skip every remaining team). A best-effort notice must never
        // be the thing that breaks teardown.
        try {
          const roster = knownAgents(db, teamId)
          const names = stranded.map((id) => roster.find((a) => a.id === id)?.name ?? id)
          persistTeamChatEntry(db, {
            teamId,
            agentId: resolveLeaderId(db, teamId) ?? stranded[0]!,
            text:
              `Parked mid-task work for ${names.join(', ')}. ` +
              'Their tasks stay on the board and resume when you reopen this team.',
            role: 'system',
            kind: 'meta',
          })
        } catch (err) {
          log.error({ err, teamId }, 'team-orchestrator park notice failed')
        }
      }
      for (const [, e] of abortMap) void e.adapter.abort(e.run).catch(() => undefined)
      abortMap.clear()
      engine.reset()
      // NOT `nudge.drain()`. The queue's drain fires each queued `send` closure,
      // and in THIS host a send is `serverDeliver`'s closure — it builds an
      // adapter and starts a brand-new agent run. Draining here would spawn runs
      // whose events reach an already-reset engine and whose handles are absent
      // from the just-cleared abort map: unobservable, unstoppable work started
      // by teardown. A queued `[Task Update]` is dropped instead; making it
      // survive requires the durable mailbox (it must outlive the process, which
      // an in-memory flush can't do regardless).
      nudge.reset()
    },
  }

  return {
    orchestrator,
    touch,
    getLastActivity: () => lastActivityAt,
    // A live run registers itself in `abortMap` for its whole lifetime, so an
    // empty map is exactly "nothing running".
    isQuiescent: () => abortMap.size === 0,
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

/**
 * One pass of the soft idle-TTL eviction: a team orchestrator idle past
 * `IDLE_TTL_MS` is disposed (timers cleared, engine reset); a later message
 * re-instantiates it and re-resumes from the board.
 *
 * QUIESCENCE-GATED: an instance with a run in flight is never evicted, however
 * long the HUMAN has been away — eviction is for abandoned instances, not busy
 * ones. Previously only a user message refreshed the clock, so kicking off a
 * long cascade and walking away (the product's whole premise) got every
 * delegate aborted mid-work at the 30-minute mark with nobody told. `onEvent`
 * now also refreshes it, making this gate belt-and-braces: it holds even if a
 * run somehow emits no events at all.
 *
 * Exported for tests; the interval below is the only production caller.
 */
export function evictIdleOrchestrators(now: number = Date.now()): number {
  let evicted = 0
  for (const [teamId, inst] of instances) {
    if (!shouldEvictInstance(now - inst.getLastActivity(), inst.isQuiescent())) continue
    try {
      inst.dispose()
    } catch (err) {
      log.error({ err, teamId }, 'team-orchestrator eviction dispose failed')
    }
    instances.delete(teamId)
    evicted++
  }
  return evicted
}

/**
 * The eviction policy, as a pure predicate.
 *
 * - Under the idle TTL: keep. (Every observed run event refreshes the clock, so
 *   a working cascade never gets here.)
 * - Over the TTL and quiescent: evict — the normal reclaim of an abandoned team.
 * - Over the TTL but busy: keep, UNTIL `HARD_TTL_MS`. Sparing busy instances is
 *   what stops a walked-away-from cascade being killed mid-flight; the ceiling is
 *   what stops a hung run (no terminal, no events) from pinning its orchestrator
 *   forever. Reaching it means total silence for `HARD_TTL_MS`, which a live run
 *   cannot do.
 */
export function shouldEvictInstance(idleForMs: number, quiescent: boolean): boolean {
  if (idleForMs <= IDLE_TTL_MS) return false
  return quiescent || idleForMs > HARD_TTL_MS
}

const evictScan = setInterval(() => evictIdleOrchestrators(), EVICT_SCAN_MS)
evictScan.unref?.()
