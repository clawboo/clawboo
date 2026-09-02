import type { Request, Response } from 'express'
import { getScreenshot } from '../lib/screenshotBus'
import { envVarForProvider, KNOWN_PROVIDERS } from '@clawboo/adapter-native'
import {
  agents,
  appendAudit,
  costRecords,
  approvalHistory,
  evaluateInjection,
  injectionAuditSummary,
  settings,
  getSetting,
  type InjectionFinding,
} from '@clawboo/db'
import { AGENT_FILE_NAMES, type AgentFileName, type AgentSource } from '@clawboo/agent-registry'
import { eq, sql, inArray } from 'drizzle-orm'
import { getDb } from '../lib/db'
import { getTenantId } from '../lib/tenant'
import { getRegistry } from '../lib/agentSource'
import { runtimeAgentFileKey } from '../lib/agentSource/runtimeAgentFileStore'
import {
  loadAgentConfig,
  nativeConfigKey,
  nativeFileKey,
  saveAgentConfig,
} from '../lib/runtimes/native/agentConfigStore'
import { nativeChatSessionSettingKey } from '../lib/agentChat/driveAgentChat'
import { ensureNativeBooZero, resolveBooZero } from '../lib/teamChat/booZero'

// The source throws Error('gateway_disconnected') when a write/file/session op
// needs a live Gateway but the server-side connection is down.
function isDisconnected(err: unknown): boolean {
  return err instanceof Error && err.message === 'gateway_disconnected'
}

// Multi-source routing: per-agent operations go to the source that OWNS the
// row (its `sourceId`). Unknown ids fall back to the default (OpenClaw)
// source so its 404 semantics are preserved.
function sourceForAgent(agentId: string): AgentSource {
  const reg = getRegistry()
  const row = getDb()
    .select({ sourceId: agents.sourceId })
    .from(agents)
    .where(eq(agents.id, agentId))
    .get()
  return (row && reg.registry.get(row.sourceId)) || reg.source
}

// ─── GET /api/agents ─────────────────────────────────────────────────────────
// The read surface: aggregates EVERY registered source (OpenClaw + native; all
// SQLite-backed, so it works even when the Gateway connection is down — `stale`
// flags the OpenClaw leg). `defaultId`/`mainKey`/`stale`/`lastSyncedAt` stay
// OpenClaw-derived: Boo Zero and the Gateway session keys are OpenClaw
// concepts; native records carry their own sessionKey on the record.
export async function agentsListGET(req: Request, res: Response): Promise<void> {
  try {
    const reg = getRegistry()
    const includeArchived = req.query['includeArchived'] === 'true'
    const teamId =
      typeof req.query['teamId'] === 'string' ? (req.query['teamId'] as string) : undefined
    const lists = await Promise.all(
      reg.registry
        .list()
        .map((s) => s.listAgents({ includeArchived, ...(teamId !== undefined ? { teamId } : {}) })),
    )
    const db = getDb()
    const health = await reg.source.health()
    res.json({
      // Runtime-neutral Boo Zero for the client to identify (override → native → OpenClaw).
      // Native-first installs identify the native Boo Zero here, not the Gateway default.
      defaultId: resolveBooZero(db)?.id ?? '',
      mainKey: (getSetting(db, 'agent-source:openclaw:mainKey') ?? '').trim() || 'main',
      agents: lists.flat(),
      stale: health.connection !== 'connected',
      lastSyncedAt: health.lastSyncedAt,
    })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
}

// ─── GET /api/agents/registry/health ─────────────────────────────────────────
// Always 200 — reports the server-side Gateway connection state. (Registered
// BEFORE /api/agents/:agentId so ':agentId' doesn't swallow 'registry'.)
export async function agentsRegistryHealthGET(_req: Request, res: Response): Promise<void> {
  try {
    res.json(await getRegistry().source.health())
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
}

// ─── Injection gate on the agent-authoring path ──────────────────────────────
// `POST /api/agents` and `PUT /api/agents/:agentId/files/:name` are the two
// routes EVERY marketplace deploy travels, and neither scanned anything before.
// Agent files are prose bound for the model's own context, so they evaluate on
// the `prompt` surface: instruction-override phrasing and invisible-unicode
// smuggling block, while machine-directed strings pass with a review flag. That
// asymmetry is load-bearing, not a softening: first-run onboarding hard-requires
// deploying a builtin team, so a false positive here is an unrecoverable
// first-run failure rather than a degraded experience, and a `DROP TABLE` in a
// code reviewer's worked example is security-education prose, not an attack. The
// `exec` seam (tool args, skill installs, connector spawn config) still denies
// the real thing.
interface AgentContentScan {
  block: InjectionFinding[]
  review: InjectionFinding[]
}

/** Evaluate every named chunk of agent-authored prose on the `prompt` surface. */
function scanAgentContent(parts: Array<[string, string]>, scopePrefix: string): AgentContentScan {
  const block: InjectionFinding[] = []
  const review: InjectionFinding[] = []
  for (const [label, text] of parts) {
    if (!text) continue
    const evaluation = evaluateInjection(text, {
      surface: 'prompt',
      scope: `${scopePrefix}#${label}`,
    })
    block.push(...evaluation.block)
    review.push(...evaluation.review)
  }
  return { block, review }
}

/** Audit + 422 for a blocked authoring attempt. Only `{pattern, line,
 *  fingerprint}` reaches the audit row, because `appendAudit` stringifies into one TEXT
 *  column, so full excerpts stay in the HTTP response. */
function rejectBlockedContent(
  res: Response,
  scan: AgentContentScan,
  audit: { agentId: string | null; teamId?: string | null },
): void {
  appendAudit(getDb(), {
    eventType: 'install',
    agentId: audit.agentId,
    teamId: audit.teamId ?? null,
    summary: { blocked: true, gate: 'agent-content', findings: injectionAuditSummary(scan.block) },
  })
  res
    .status(422)
    .json({ error: 'agent content blocked: prompt-injection finding', findings: scan.block })
}

// ─── POST /api/agents ────────────────────────────────────────────────────────
// Create an agent. Default source = OpenClaw (Gateway create + file writes +
// SQLite mirror; 503 when the server-side connection is down). An optional
// `sourceId` routes the create to a peer source (e.g. 'clawboo-native', whose
// writes are pure SQLite and always work).
interface CreateAgentBody {
  name?: string
  teamId?: string | null
  personalityConfig?: unknown
  execConfig?: unknown
  avatarSeed?: string | null
  files?: Record<string, string>
  sourceId?: string
}
export async function agentsCreatePOST(req: Request, res: Response): Promise<void> {
  const body = req.body as CreateAgentBody | undefined
  if (!body || typeof body.name !== 'string' || !body.name.trim()) {
    res.status(400).json({ error: 'name is required' })
    return
  }
  const reg = getRegistry()
  const source = body.sourceId ? reg.registry.get(body.sourceId) : reg.source
  if (!source) {
    res.status(400).json({ error: `unknown sourceId '${String(body.sourceId)}'` })
    return
  }
  // Gate BEFORE the source write, so a blocked payload never reaches the Gateway
  // or SQLite, and so the 422 is returned even when the Gateway is disconnected.
  const name = body.name.trim()
  const scan = scanAgentContent(
    [
      ['name', name],
      ...Object.entries(body.files ?? {}).filter(
        (e): e is [string, string] => typeof e[1] === 'string',
      ),
    ],
    name,
  )
  if (scan.block.length > 0) {
    rejectBlockedContent(res, scan, { agentId: null, teamId: body.teamId ?? null })
    return
  }
  try {
    const agent = await source.createAgent({
      name,
      teamId: body.teamId ?? null,
      personalityConfig: body.personalityConfig,
      execConfig: body.execConfig,
      avatarSeed: body.avatarSeed ?? null,
      files: body.files,
      tenantId: getTenantId(req),
    })
    // Eagerly materialize the DEFAULT-NATIVE Boo Zero the moment a native team gains a
    // member, so the client identifies the native leader right away instead of the
    // OpenClaw `main` fallback shown in the window before the first orchestrator run
    // (the "why is my native team led by OpenClaw?" report). Best-effort, idempotent,
    // and self-gated on a connected native provider.
    if (agent.runtime === 'clawboo-native' && agent.teamId) {
      void ensureNativeBooZero(getDb(), getRegistry().nativeSource).catch(() => undefined)
    }
    // Review findings do not block, but they must be visible: a finding that
    // only ever reached a local variable is indistinguishable from not looking.
    res.status(201).json(scan.review.length > 0 ? { agent, findings: scan.review } : { agent })
  } catch (err) {
    if (isDisconnected(err)) {
      res.status(503).json({ error: 'gateway_disconnected' })
      return
    }
    res.status(500).json({ error: String(err) })
  }
}

// ─── POST /api/agents/sync ───────────────────────────────────────────────────
// Manual sync trigger + browser-fallback. With a body ({ defaultId, mainKey,
// agents }) it upserts WITHOUT needing the server's own connection (the browser,
// connected via the proxy, pushes its agents.list result). With no body it runs
// the server-side sync (needs the connection → 503 when down).
interface SyncBody {
  defaultId?: string
  mainKey?: string
  scope?: string
  agents?: Array<{ id: string; name?: string; identity?: Record<string, unknown> }>
}
export async function agentsSyncPOST(req: Request, res: Response): Promise<void> {
  const source = getRegistry().source
  const body = req.body as SyncBody | undefined
  try {
    if (body && Array.isArray(body.agents)) {
      const result = source.upsertFromList(body.agents, {
        defaultId: body.defaultId ?? '',
        mainKey: (body.mainKey ?? '').trim() || 'main',
        scope: body.scope ?? '',
      })
      res.json({ result: { ...result, durationMs: 0, at: Date.now() } })
      return
    }
    const result = await source.sync()
    res.json({ result })
  } catch (err) {
    if (isDisconnected(err)) {
      res.status(503).json({ error: 'gateway_disconnected' })
      return
    }
    res.status(500).json({ error: String(err) })
  }
}

// ─── GET /api/agents/:agentId ────────────────────────────────────────────────
export async function agentGET(req: Request, res: Response): Promise<void> {
  const agentId = req.params['agentId'] as string | undefined
  if (!agentId) {
    res.status(400).json({ error: 'agentId required' })
    return
  }
  try {
    const agent = await sourceForAgent(agentId).getAgent(agentId)
    if (!agent) {
      res.status(404).json({ error: 'agent not found' })
      return
    }
    res.json({ agent })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
}

// ─── PATCH /api/agents/:agentId/model ────────────────────────────────────────
// Change an agent's model, and optionally its provider. Native persists to its
// AgentConfig (via the AgentConfig KV directly, NOT `updateAgent`, which would
// clobber `agents.execConfig`): with a `provider` in the body the
// primaryProvider + primaryModel + envVar triple moves ATOMICALLY (the model
// picker offers every provider's models, and a cross-provider model left on the
// old provider posts to the wrong endpoint and fails auth); without one, only
// primaryModel changes (back-compat, and how a custom id for the current
// provider is set). The server has no model-to-provider catalog (custom ids are
// supported), so it validates the provider name and trusts the model string;
// the SPA sends the provider of the group the user picked from. Hermes persists
// to its execConfig `{ provider, model }`: it routes every model through
// OpenRouter, so any other explicit provider is a 400. Codex / Claude Code
// (account / SDK default) + OpenClaw (via the Gateway) are not editable here → 404.
export async function agentModelPATCH(req: Request, res: Response): Promise<void> {
  const agentId = req.params['agentId'] as string | undefined
  if (!agentId) {
    res.status(400).json({ error: 'agentId required' })
    return
  }
  const body = req.body as { model?: unknown; provider?: unknown } | undefined
  const model = typeof body?.model === 'string' ? body.model.trim() : ''
  // PRESENT-but-malformed is rejected, not quietly treated as absent: dropping it
  // would do a model-only update, leaving the model on the OLD provider, which is
  // the accept-and-drop behaviour this route exists to stop.
  const providerSupplied = body != null && 'provider' in body && body.provider !== undefined
  const provider = typeof body?.provider === 'string' ? body.provider.trim() : ''
  if (!model) {
    res.status(400).json({ error: 'model (non-empty string) required' })
    return
  }
  if (providerSupplied && !(KNOWN_PROVIDERS as readonly string[]).includes(provider)) {
    res.status(400).json({ error: `unknown provider '${String(body?.provider)}'` })
    return
  }
  try {
    const source = sourceForAgent(agentId)
    const agent = await source.getAgent(agentId)
    if (!agent) {
      res.status(404).json({ error: 'agent not found' })
      return
    }
    if (agent.runtime === 'clawboo-native') {
      const db = getDb()
      const config = loadAgentConfig(db, agentId)
      if (!config) {
        res.status(404).json({ error: 'native agent config not found' })
        return
      }
      saveAgentConfig(db, {
        ...config,
        ...(provider
          ? {
              primaryProvider: provider,
              // Ollama is keyless; the placeholder mirrors the onboarding seed.
              envVar: envVarForProvider(provider) ?? 'OLLAMA_BASE_URL',
            }
          : {}),
        primaryModel: model,
        updatedAt: Date.now(),
      })
      res.json({ ok: true, model, ...(provider ? { provider } : {}) })
      return
    }
    if (agent.runtime === 'hermes') {
      if (provider && provider !== 'openrouter') {
        res.status(400).json({
          error: `hermes routes every model via OpenRouter; provider must be 'openrouter' or omitted`,
        })
        return
      }
      // Hermes routes every model via OpenRouter, so store { provider, model } in the
      // execConfig the run reads (serverDeliver → ctx.model + providerHint).
      await source.updateAgent(agentId, { execConfig: { provider: 'openrouter', model } })
      res.json({ ok: true, model, ...(provider ? { provider } : {}) })
      return
    }
    res.status(404).json({ error: 'model change via this route is native/hermes-only' })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
}

// ─── GET / PUT /api/agents/:agentId/files/:name ──────────────────────────────
function validFileName(name: string | undefined): name is AgentFileName {
  return !!name && (AGENT_FILE_NAMES as readonly string[]).includes(name)
}
export async function agentFileGET(req: Request, res: Response): Promise<void> {
  const agentId = req.params['agentId'] as string | undefined
  const name = req.params['name'] as string | undefined
  if (!agentId) {
    res.status(400).json({ error: 'agentId required' })
    return
  }
  if (!validFileName(name)) {
    res.status(400).json({ error: 'invalid file name' })
    return
  }
  try {
    const content = await sourceForAgent(agentId).readFile(agentId, name)
    res.json({ name, content })
  } catch (err) {
    if (isDisconnected(err)) {
      res.status(503).json({ error: 'gateway_disconnected' })
      return
    }
    res.status(500).json({ error: String(err) })
  }
}
export async function agentFilePUT(req: Request, res: Response): Promise<void> {
  const agentId = req.params['agentId'] as string | undefined
  const name = req.params['name'] as string | undefined
  const body = req.body as { content?: unknown } | undefined
  if (!agentId) {
    res.status(400).json({ error: 'agentId required' })
    return
  }
  if (!validFileName(name)) {
    res.status(400).json({ error: 'invalid file name' })
    return
  }
  if (typeof body?.content !== 'string') {
    res.status(400).json({ error: 'content (string) required' })
    return
  }
  const content = body.content
  const scan = scanAgentContent([[name, content]], agentId)
  if (scan.block.length > 0) {
    rejectBlockedContent(res, scan, { agentId })
    return
  }
  try {
    await sourceForAgent(agentId).writeFile(agentId, name, content)
    res.json(scan.review.length > 0 ? { name, content, findings: scan.review } : { name, content })
  } catch (err) {
    if (isDisconnected(err)) {
      res.status(503).json({ error: 'gateway_disconnected' })
      return
    }
    res.status(500).json({ error: String(err) })
  }
}

// ─── GET /api/agents/:agentId/sessions ───────────────────────────────────────
export async function agentSessionsGET(req: Request, res: Response): Promise<void> {
  const agentId = req.params['agentId'] as string | undefined
  if (!agentId) {
    res.status(400).json({ error: 'agentId required' })
    return
  }
  try {
    const sessions = await sourceForAgent(agentId).listSessions(agentId)
    res.json({ sessions })
  } catch (err) {
    if (isDisconnected(err)) {
      res.status(503).json({ error: 'gateway_disconnected' })
      return
    }
    res.status(500).json({ error: String(err) })
  }
}

// Per-agent `settings` keys that should be removed alongside the agent row:
// `boo-zero:display-name:<agentId>` (see `server/api/booZero.ts`
// DISPLAY_NAME_KEY_PREFIX) plus the native runtime's per-agent KV rows
// (AgentConfig + agent files). Add new prefixes here whenever a per-agent
// settings key is introduced — the helper is consumed by BOTH `agentsDELETE`
// (single agent) and `agentsCleanupPOST` (ghost sweep) so adding a row stays
// a one-line change.
function perAgentSettingKeys(agentId: string): string[] {
  return [
    `boo-zero:display-name:${agentId}`,
    nativeConfigKey(agentId),
    // The native 1:1 chat's resume pointer (conversation continuity).
    nativeChatSessionSettingKey(agentId),
    ...AGENT_FILE_NAMES.map((name) => nativeFileKey(agentId, name)),
    // The generic RuntimeAgentSource (claude-code / codex / hermes) file-KV rows.
    ...AGENT_FILE_NAMES.map((name) => runtimeAgentFileKey(agentId, name)),
  ]
}

// ─── DELETE /api/agents/:agentId ─────────────────────────────────────────────
//
// Removes an agent row from the LOCAL SQLite DB (Clawboo's own metadata) plus
// any FK-referenced rows that would otherwise block the delete:
//   - cost_records.agent_id  → ON DELETE NO ACTION (no cascade), so must
//     remove first to satisfy FK.
//   - approval_history.agent_id → same.
//
// The Gateway-side `agents.delete` RPC is the caller's responsibility (see
// `deleteAgentOperation` on the client). This endpoint ONLY cleans up local
// metadata; without it, deleted agents leave permanent ghost rows in SQLite
// that inflate per-team `agentCount` and pollute namespace checks.

function deleteLocalAgentRows(agentId: string): void {
  const db = getDb()
  // Order matters — children before parent (FK guards).
  db.delete(costRecords).where(eq(costRecords.agentId, agentId)).run()
  db.delete(approvalHistory).where(eq(approvalHistory.agentId, agentId)).run()
  // Per-agent KV settings (no FK to `agents`) — wipe in lock-step.
  db.delete(settings)
    .where(inArray(settings.key, perAgentSettingKeys(agentId)))
    .run()
  db.delete(agents).where(eq(agents.id, agentId)).run()
}

export async function agentsDELETE(req: Request, res: Response): Promise<void> {
  const agentId = req.params['agentId'] as string | undefined
  if (!agentId) {
    res.status(400).json({ error: 'agentId required' })
    return
  }
  try {
    // archiveAgent deletes upstream (Gateway) THEN cleans the SQLite row + FK
    // children. If the server-side Gateway connection is down, fall back to a
    // SQLite-only cleanup so the local row never rots (disconnect tolerance).
    try {
      await sourceForAgent(agentId).archiveAgent(agentId)
      res.json({ ok: true, upstreamDeleted: true })
    } catch (err) {
      if (isDisconnected(err)) {
        deleteLocalAgentRows(agentId)
        res.json({ ok: true, upstreamDeleted: false })
        return
      }
      throw err
    }
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
}

// ─── POST /api/agents/cleanup-ghosts ─────────────────────────────────────────
//
// Body: { liveAgentIds: string[] }
//
// One-shot cleanup the client invokes after hydrating from the Gateway. The
// caller passes the IDs of all agents currently alive in the Gateway; this
// endpoint deletes every local SQLite agent row NOT in that list, plus their
// FK-referenced cost/approval rows. Idempotent — safe to call repeatedly.
//
// This catches historical pollution from a time when `deleteAgentOperation`
// only deleted the Gateway-side agent and left the SQLite row behind. Going
// forward, the per-agent DELETE endpoint above prevents accumulation.

interface CleanupBody {
  liveAgentIds: string[]
}

export function agentsCleanupPOST(req: Request, res: Response): void {
  const body = req.body as CleanupBody | undefined
  if (!body || !Array.isArray(body.liveAgentIds)) {
    res.status(400).json({ error: 'liveAgentIds array required' })
    return
  }
  // Guard rail: if the caller passes an empty list AND no agents are
  // actually expected to be alive, that's plausible. But if it's empty
  // because of a transient Gateway hiccup, we'd nuke every local row.
  // Require an explicit override flag for the empty-list case.
  if (body.liveAgentIds.length === 0 && !(req.query['allowEmpty'] === 'true')) {
    res.status(400).json({
      error: 'empty liveAgentIds list — pass ?allowEmpty=true to confirm',
    })
    return
  }

  try {
    const db = getDb()
    const liveIds = body.liveAgentIds

    // Collect IDs of local agent rows that are NOT in the live set. Scoped to
    // the OpenClaw source: the live-id list comes from the GATEWAY, so only
    // Gateway-owned rows may be compared against it — native (and any future
    // peer-source) agents are never ghosts of the Gateway.
    const localRows = db
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.sourceId, 'openclaw'))
      .all()
    const liveSet = new Set(liveIds)
    const toDelete = localRows.map((r) => r.id).filter((id) => !liveSet.has(id))

    if (toDelete.length === 0) {
      res.json({ ok: true, deleted: 0 })
      return
    }

    // Children before parent (FK guards).
    db.delete(costRecords).where(inArray(costRecords.agentId, toDelete)).run()
    db.delete(approvalHistory).where(inArray(approvalHistory.agentId, toDelete)).run()
    // Per-agent KV settings (no FK to `agents`) — same sweep, same scope.
    const settingKeys = toDelete.flatMap(perAgentSettingKeys)
    if (settingKeys.length > 0) {
      db.delete(settings).where(inArray(settings.key, settingKeys)).run()
    }
    db.delete(agents).where(inArray(agents.id, toDelete)).run()

    // Sanity-log how many remain — useful when debugging via curl.
    const remaining = db
      .select({ count: sql<number>`COUNT(*)` })
      .from(agents)
      .all()[0]
    res.json({ ok: true, deleted: toDelete.length, remaining: remaining?.count ?? null })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
}

// ─── GET /api/agents/:agentId/screenshot ─────────────────────────────────────
// The newest frame this agent captured, for the Browser panel. `?meta=1` returns
// just the descriptor so the panel can decide whether to render at all without
// pulling megabytes it may not show.
//
// Serves out of an in-memory bus, never the event log: the frame's value expires
// in seconds and the log is append-only with no delete writer.
export function agentScreenshotGET(req: Request, res: Response): void {
  const agentId = (req.params['agentId'] as string | undefined) ?? ''
  const shot = getScreenshot(agentId)
  if (!shot) {
    res.status(404).json({ ok: false, error: 'no screenshot for this agent' })
    return
  }
  if (req.query['meta'] !== undefined) {
    res.json({ ok: true, mimeType: shot.mimeType, toolName: shot.toolName, ts: shot.ts })
    return
  }
  let bytes: Buffer
  try {
    bytes = Buffer.from(shot.data, 'base64')
  } catch {
    res.status(500).json({ ok: false, error: 'frame is not decodable' })
    return
  }
  res.setHeader('Content-Type', shot.mimeType)
  res.setHeader('Content-Length', String(bytes.length))
  // The newest frame replaces the last one under the same URL, so a cached copy
  // would pin the panel to whatever the agent was looking at first.
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.end(bytes)
}
