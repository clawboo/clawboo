import crypto from 'node:crypto'
import { rm } from 'node:fs/promises'
import type { Request, Response } from 'express'
import { chatMessages, setSetting, teams, agents, settings } from '@clawboo/db'
import { eq, inArray, like, sql } from 'drizzle-orm'
import { getDb } from '../lib/db'
import { teamWorkdirPath } from '../lib/runtimes/teamWorkdir'
import { getRegistry } from '../lib/agentSource/registry'
import { pendingUpstreamDeletes } from '../lib/agentSource/openClawAgentSource'
import { ensureNativeBooZero } from '../lib/teamChat/booZero'
import {
  nativeTeamSessionKeysForTeamLike,
  nativeTeamSessionRoomKeysForTeamLike,
  nativeTeamSessionSettingKey,
} from '../lib/teamChat/nativeTeamSession'
import { resolveTeamSessionKeys } from './teamChatStream'
import { chatClearedAt, chatClearedSettingKey } from '../lib/teamChat/chatCleared'
import { getTenantId } from '../lib/tenant'
import { loopbackMcpBaseUrl } from '../lib/mcpBaseUrl'
import {
  resolveServerOrchestrated,
  serverOrchestratedSettingKey,
} from '../lib/teamChat/resolveServerOrchestrated'
import {
  getTeamOrchestrator,
  hasTeamOrchestrator,
  isActiveTeamRoom,
} from '../lib/teamChat/teamOrchestrator'

/** The chat room a request names (`roomId` in the body or query); null = the
 *  team's own group chat. Anything that is not a non-empty string is the default. */
function requestedRoomId(raw: unknown): string | null {
  return typeof raw === 'string' && raw.length > 0 ? raw : null
}

// ─── GET /api/teams ──────────────────────────────────────────────────────────
// Returns all teams with an agentCount for each, plus agent→team assignments.

export function teamsGET(req: Request, res: Response): void {
  try {
    const db = getDb()
    const includeArchived = req.query['includeArchived'] === 'true'

    const rows = db
      .select({
        id: teams.id,
        name: teams.name,
        icon: teams.icon,
        color: teams.color,
        colorCollectionId: teams.colorCollectionId,
        templateId: teams.templateId,
        leaderAgentId: teams.leaderAgentId,
        isArchived: teams.isArchived,
        createdAt: teams.createdAt,
        updatedAt: teams.updatedAt,
        agentCount: sql<number>`(SELECT COUNT(*) FROM agents WHERE agents.team_id = teams.id)`,
      })
      .from(teams)
      .where(includeArchived ? undefined : eq(teams.isArchived, 0))
      .all()

    // Return agent→team assignments so the client can patch fleet store after hydration
    const assignments = db
      .select({ agentId: agents.id, teamId: agents.teamId })
      .from(agents)
      .all()
      .filter((a) => a.teamId !== null) as { agentId: string; teamId: string }[]

    // Tell the client which teams the SERVER orchestrator owns (native, Gateway-free)
    // so `GroupChatPanel` renders them via the REST + SSE thin-client path instead of
    // the browser board-orchestration path. OpenClaw teams read false → legacy path.
    const teamsWithFlag = rows.map((t) => ({
      ...t,
      serverOrchestrated: resolveServerOrchestrated(db, t.id),
      chatClearedAt: chatClearedAt(db, t.id),
    }))

    res.json({ teams: teamsWithFlag, assignments })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
}

// ─── POST /api/teams ─────────────────────────────────────────────────────────
// Body: { name: string, icon: string, color: string, templateId?: string }

interface CreateBody {
  name: string
  icon: string
  color: string
  colorCollectionId?: string
  templateId?: string
  leaderAgentId?: string
  /** Optional client-provided UUID so the create-team preview can seed the
   *  Boo palette with the SAME id the deployed team will use (per-team color
   *  rotation). Validated as a UUID; ignored otherwise. */
  id?: string
  /** When true, write the explicit `team-server-orchestrated:<id>` flag so the
   *  team runs the persistent SERVER engine from the moment it exists — set by
   *  CreateTeamModal for a native/mixed team. Relying on runtime inference is
   *  racy at create time (0 agents ⇒ inferred false) and for keyword-less
   *  leaders (leaderAgentId never set). Absent/false ⇒ inference (OpenClaw). */
  serverOrchestrated?: boolean
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function teamsPOST(req: Request, res: Response): void {
  const body = req.body as CreateBody | undefined
  if (!body || typeof body !== 'object') {
    res.status(400).json({ error: 'invalid JSON' })
    return
  }

  const { name, icon, color, colorCollectionId, templateId, leaderAgentId } = body
  if (!name || !icon || !color) {
    res.status(400).json({ error: 'name, icon, and color are required' })
    return
  }

  const now = Date.now()
  // Honor a valid client-provided id; otherwise mint one server-side.
  const id = typeof body.id === 'string' && UUID_RE.test(body.id) ? body.id : crypto.randomUUID()

  try {
    const db = getDb()

    db.insert(teams)
      .values({
        id,
        name,
        icon,
        color,
        colorCollectionId: colorCollectionId ?? null,
        templateId: templateId ?? null,
        leaderAgentId: leaderAgentId ?? null,
        tenantId: getTenantId(req),
        createdAt: now,
        updatedAt: now,
      })
      .run()

    // Deterministic server-orchestration for native/mixed teams (see CreateBody).
    if (body.serverOrchestrated === true) {
      setSetting(db, serverOrchestratedSettingKey(id), 'true')
    }

    res.json({
      team: {
        id,
        name,
        icon,
        color,
        colorCollectionId: colorCollectionId ?? null,
        templateId: templateId ?? null,
        leaderAgentId: leaderAgentId ?? null,
        isArchived: 0,
        agentCount: 0,
        serverOrchestrated: resolveServerOrchestrated(db, id),
        createdAt: now,
        updatedAt: now,
      },
    })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
}

// ─── PATCH /api/teams/:id ────────────────────────────────────────────────────
// Body: partial { name?, icon?, color?, isArchived? }

interface PatchBody {
  name?: string
  icon?: string
  color?: string
  colorCollectionId?: string | null
  isArchived?: number
  leaderAgentId?: string | null
}

export function teamsPATCH(req: Request, res: Response): void {
  const teamId = req.params['id'] as string | undefined
  if (!teamId) {
    res.status(400).json({ error: 'team id required' })
    return
  }

  const body = req.body as PatchBody | undefined
  if (!body || typeof body !== 'object') {
    res.status(400).json({ error: 'invalid JSON' })
    return
  }

  try {
    const db = getDb()

    const existing = db.select().from(teams).where(eq(teams.id, teamId)).get()
    if (!existing) {
      res.status(404).json({ error: 'team not found' })
      return
    }

    const now = Date.now()
    const patch: Record<string, unknown> = { updatedAt: now }
    if (body.name !== undefined) patch['name'] = body.name
    if (body.icon !== undefined) patch['icon'] = body.icon
    if (body.color !== undefined) patch['color'] = body.color
    if (body.colorCollectionId !== undefined) patch['colorCollectionId'] = body.colorCollectionId
    if (body.isArchived !== undefined) patch['isArchived'] = body.isArchived ? 1 : 0
    if (body.leaderAgentId !== undefined) patch['leaderAgentId'] = body.leaderAgentId

    db.update(teams).set(patch).where(eq(teams.id, teamId)).run()

    const updated = db
      .select({
        id: teams.id,
        name: teams.name,
        icon: teams.icon,
        color: teams.color,
        colorCollectionId: teams.colorCollectionId,
        templateId: teams.templateId,
        leaderAgentId: teams.leaderAgentId,
        isArchived: teams.isArchived,
        createdAt: teams.createdAt,
        updatedAt: teams.updatedAt,
        agentCount: sql<number>`(SELECT COUNT(*) FROM agents WHERE agents.team_id = teams.id)`,
      })
      .from(teams)
      .where(eq(teams.id, teamId))
      .get()

    res.json({ team: updated })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
}

// ─── DELETE /api/teams/:id ───────────────────────────────────────────────────
// Deletes the team and orphans its agents (sets teamId = null). Also cleans
// up any team-scoped settings rows so deleted teams don't leave durable rows
// behind in the key/value store:
//   - `team-rules:<teamId>`     — user-captured rules
//   - `team-onboarding:<teamId>` — onboarding flags + user intro text
//   - `native-team-session:<agentId>:<teamId>` — native leader session-resume
//     pointers (one per team member; the amnesia-fix continuity handles), and the
//     same pointers for the team's chat rooms (`...:<teamId>:room:<roomId>`)
// The `boo_zero_team_briefs` and `rooms` tables FK-cascade on team delete (see
// schema; room memberships cascade with their rooms), so those clean themselves.
// The team's working folder (`<clawboo home>/workspaces/<teamId>`, where its
// agents' runs start) is removed with it, files included.
// Archiving a team keeps it.

export async function teamsDELETE(req: Request, res: Response): Promise<void> {
  const teamId = req.params['id'] as string | undefined
  if (!teamId) {
    res.status(400).json({ error: 'team id required' })
    return
  }

  try {
    const db = getDb()

    // Orphan agents belonging to this team
    db.update(agents).set({ teamId: null }).where(eq(agents.teamId, teamId)).run()

    // Clean up team-scoped settings rows. Drizzle's `inArray` matches the
    // exact keys we wrote in `teamRules.ts` + `teamOnboarding.ts`. Safe to
    // run unconditionally — `delete ... where` is a no-op when no row
    // matches.
    db.delete(settings)
      .where(
        inArray(settings.key, [
          `team-rules:${teamId}`,
          `team-onboarding:${teamId}`,
          chatClearedSettingKey(teamId),
        ]),
      )
      .run()

    // Sweep every member's native leader session-resume pointer for this team
    // (`native-team-session:<agentId>:<teamId>`) — team ids are UUIDs so a stale
    // pointer would never be re-read, but drop it for hygiene.
    db.delete(settings)
      .where(like(settings.key, nativeTeamSessionKeysForTeamLike(teamId)))
      .run()
    db.delete(settings)
      .where(like(settings.key, nativeTeamSessionRoomKeysForTeamLike(teamId)))
      .run()

    // Delete the team (boo_zero_team_briefs and rooms FK-cascade).
    const existed = db.delete(teams).where(eq(teams.id, teamId)).run().changes > 0

    // After the row, so a failed delete never loses the files, and only for a
    // team that existed: a made-up id must not remove another folder under
    // workspaces/ (the shared `_no-team` one, say). The path is pinned under
    // workspaces/, and `rm` removes a symlink, never its target.
    let folderRemoved = false
    if (existed) {
      try {
        await rm(teamWorkdirPath(teamId), { recursive: true, force: true })
        folderRemoved = true
      } catch {
        folderRemoved = false
      }
    }

    res.json({ ok: true, folderRemoved })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
}

// ─── POST /api/teams/:id/agents ──────────────────────────────────────────────
// Body: { agentId: string }
// Assigns an agent to a team.

export async function teamAgentPOST(req: Request, res: Response): Promise<void> {
  const teamId = req.params['id'] as string | undefined
  if (!teamId) {
    res.status(400).json({ error: 'team id required' })
    return
  }

  const body = req.body as { agentId?: string; agentName?: string } | undefined
  if (!body || typeof body !== 'object' || !body.agentId) {
    res.status(400).json({ error: 'agentId is required' })
    return
  }

  try {
    const db = getDb()
    const now = Date.now()

    // An OpenClaw agent deleted while its Gateway was down is still listed by the
    // Gateway until the next sync deletes it there. The upsert below would bring
    // its row back, in a team, so assigning it is refused.
    if (pendingUpstreamDeletes(db).has(body.agentId)) {
      res.status(409).json({ error: 'agent is being deleted' })
      return
    }

    // Upsert: create the agent row if it doesn't exist, then set teamId
    db.insert(agents)
      .values({
        id: body.agentId,
        name: body.agentName || body.agentId,
        gatewayId: body.agentId,
        status: 'idle',
        teamId,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: agents.id,
        set: { teamId, updatedAt: now },
      })
      .run()

    // THIS is the moment a team actually gains a member: `createAgent` (the
    // CreateTeamModal deploy path) creates every agent TEAMLESS and assigns it
    // here, so the sibling hook in `agentsCreatePOST` — gated on `agent.teamId` —
    // can never fire for it. Without an eager create here, the DEFAULT-NATIVE Boo
    // Zero only materialized on the team's FIRST MESSAGE (the orchestrator's
    // `ready` chain): too late for that team, whose client had already hydrated
    // `defaultId` as the OpenClaw `main` fallback and pinned it as the chat target
    // ("my first team is unresponsive and led by main"), yet just in time for every
    // team created after it. Idempotent + self-gated on a native member + a
    // connected provider, so a pure-OpenClaw / no-key install materializes nothing.
    //
    // AWAITED, not fire-and-forget: the wizard reads `/api/agents` for its
    // "Led by <Boo Zero>" badge immediately after deploy, so Boo Zero must exist
    // before this response lands. The create is pure SQLite (fast) and never throws.
    const runtime = db
      .select({ runtime: agents.runtime })
      .from(agents)
      .where(eq(agents.id, body.agentId))
      .get()?.runtime
    if (runtime === 'clawboo-native') {
      await ensureNativeBooZero(db, getRegistry().nativeSource)
    }

    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
}

// ─── DELETE /api/teams/:id/agents/:agentId ───────────────────────────────────
// Removes an agent from a team (sets teamId = null).

export function teamAgentDELETE(req: Request, res: Response): void {
  const agentId = req.params['agentId'] as string | undefined
  if (!agentId) {
    res.status(400).json({ error: 'agentId required' })
    return
  }

  try {
    const db = getDb()

    db.update(agents).set({ teamId: null }).where(eq(agents.id, agentId)).run()

    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
}

// ─── POST /api/teams/:id/chat ────────────────────────────────────────────────
// Body: { message, targetAgentId?, entryId?, roomId? }. `roomId` names one of the
// team's chat rooms; absent, the message goes to the team's own group chat.
// Ingest a user message into the team's SERVER orchestrator. Returns 202
// IMMEDIATELY — the cascade proceeds DETACHED (it must survive the POST ending,
// so `req.on('close')` is deliberately NOT wired to abort it; closing the client
// must not kill the run). Gated to server-orchestrated teams — the
// double-orchestration firewall: a browser-orchestrated (OpenClaw) team 404s, so
// the server engine can never run alongside the browser engine for one team.

export function teamChatIngestPOST(req: Request, res: Response): void {
  const teamId = req.params['id'] as string | undefined
  if (!teamId) {
    res.status(400).json({ error: 'team id required' })
    return
  }
  const body = req.body as
    { message?: unknown; targetAgentId?: unknown; entryId?: unknown; roomId?: unknown } | undefined
  const message = typeof body?.message === 'string' ? body.message.trim() : ''
  if (!message) {
    res.status(400).json({ error: 'message required' })
    return
  }
  const targetAgentId = typeof body?.targetAgentId === 'string' ? body.targetAgentId : null
  // A client-provided entryId lets the optimistic user bubble and the SSE-replayed
  // user entry share one id → the thin client dedups by entryId (no double-render).
  const userEntryId = typeof body?.entryId === 'string' ? body.entryId : undefined
  try {
    const db = getDb()
    if (!resolveServerOrchestrated(db, teamId)) {
      res.status(404).json({ error: 'team is not server-orchestrated' })
      return
    }
    const roomId = requestedRoomId(body?.roomId)
    if (!isActiveTeamRoom(teamId, roomId)) {
      res.status(404).json({ error: 'room not found' })
      return
    }
    const mcpBaseUrl = loopbackMcpBaseUrl(req)
    // Fire-and-forget: the orchestrator owns the long-running cascade. Not awaited
    // (the 202 returns now); not aborted on client disconnect.
    void getTeamOrchestrator(teamId, { mcpBaseUrl, roomId }).enqueueUserMessage({
      stimulus: message,
      targetAgentId,
      userEntryId,
    })
    res.status(202).json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
}

// ─── POST /api/teams/:id/chat/clear ──────────────────────────────────────────
// Body: { roomId? }. Clears one chat: the team's General chat, or a room's when
// `roomId` names one. The messages are set aside, not deleted: each
// row's session key (and entry id) gains a `#cleared:<ts>` suffix, so no reader
// matches it any more, and the agents' memory of the conversation is dropped so
// the next reply starts fresh. Other chats are untouched, and the board keeps every
// task (the chat just stops showing the ones made before the clear).

export function teamChatClearPOST(req: Request, res: Response): void {
  const teamId = req.params['id'] as string | undefined
  if (!teamId) {
    res.status(400).json({ error: 'team id required' })
    return
  }
  try {
    const db = getDb()
    const exists = db.select({ id: teams.id }).from(teams).where(eq(teams.id, teamId)).get()
    if (!exists) {
      res.status(404).json({ error: 'team not found' })
      return
    }
    const roomId = requestedRoomId((req.body as { roomId?: unknown } | undefined)?.roomId)
    if (!isActiveTeamRoom(teamId, roomId)) {
      res.status(404).json({ error: 'room not found' })
      return
    }
    const keys = resolveTeamSessionKeys(db, teamId, roomId)
    const clearedAt = Date.now()
    const suffix = `#cleared:${clearedAt}`
    const cleared =
      keys.length > 0
        ? db
            .update(chatMessages)
            .set({
              sessionKey: sql`${chatMessages.sessionKey} || ${suffix}`,
              entryId: sql`${chatMessages.entryId} || ${suffix}`,
            })
            .where(inArray(chatMessages.sessionKey, keys))
            .run().changes
        : 0
    for (const key of keys) {
      const agentId = key.slice('agent:'.length, key.indexOf(':team:'))
      if (agentId) setSetting(db, nativeTeamSessionSettingKey(agentId, teamId, roomId), '')
    }
    setSetting(db, chatClearedSettingKey(teamId, roomId), String(clearedAt))
    res.json({ ok: true, clearedAt, cleared })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
}

// ─── POST /api/teams/:id/chat/stop ───────────────────────────────────────────
// Body: { roomId? }. User Stop for one chat room (the team's own group chat when
// absent): bump that orchestrator's stop generation + abort its in-flight runs (a
// clean release to `todo`, never a failure reflection). Other rooms keep going.
// A no-op when no orchestrator is live (idle-evicted / never started).

export function teamChatStopPOST(req: Request, res: Response): void {
  const teamId = req.params['id'] as string | undefined
  if (!teamId) {
    res.status(400).json({ error: 'team id required' })
    return
  }
  try {
    const db = getDb()
    if (!resolveServerOrchestrated(db, teamId)) {
      res.status(404).json({ error: 'team is not server-orchestrated' })
      return
    }
    const roomId = requestedRoomId((req.body as { roomId?: unknown } | undefined)?.roomId)
    if (hasTeamOrchestrator(teamId, roomId)) getTeamOrchestrator(teamId, { roomId }).stop()
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
}
