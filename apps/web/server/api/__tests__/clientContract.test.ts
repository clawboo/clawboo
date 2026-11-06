// The client-facing contract. Several clients talk to this engine: the web
// dashboard, a desktop shell that bundles it, a wrapper that serves it behind a
// reverse proxy, and remote apps. Each must keep working across the support
// window, the current minor release plus the previous one, so this suite pins
// what they rely on:
//   • the GET /api/system/capabilities answer, whose schema is exported from
//     @clawboo/control-client;
//   • every route and method the API router serves;
//   • the event names and payload fields of the three resumable streams, driven
//     end to end through the real writers and the real routes.
//
// ADDING is free, but must be pinned: a new route, flag or field fails this suite
// until it is listed below, so nothing a client can see goes unpinned.
// REMOVING OR RENAMING anything listed here breaks clients. Do it only with an API
// revision bump: raise ENGINE_API_REVISION in
// packages/control-client/src/capabilities.ts, set PINNED_API_REVISION to match,
// update the lists, and say so in the changeset.

import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'

import {
  ENGINE_API_REVISION,
  ENGINE_FEATURES,
  RESUMABLE_STREAMS,
  engineCapabilitiesSchema,
  engineHoldSchema,
  engineHoldStateSchema,
  supportFloorFor,
  type AgentStatusFrame,
  type BoardChangeFrame,
  type ChatDeltaFrame,
  type ChatMessageFrame,
  type OrchestrationEventFrame,
} from '@clawboo/control-client'
import {
  agents,
  appendEvent,
  latestChatMessageId,
  teams,
  type DbOrchestrationEvent,
} from '@clawboo/db'
import { createAccessGate, createOriginGuard } from '@clawboo/gateway-proxy'
import type { TranscriptEntry } from '@clawboo/protocol'
import { buildTeamSessionKey } from '@clawboo/team-orchestration'
import express, { type Express } from 'express'
import { afterAll, beforeAll, describe, expect, expectTypeOf, it } from 'vitest'

import { agentChatSessionKey } from '../../lib/agentChat/driveAgentChat'
import { getDb, resetDb } from '../../lib/db'
import { persistNativeChatEntry } from '../../lib/runtimes/native/nativeDriver'
import { FEATURE_ROUTES } from '../../lib/engineCapabilities'
import { publishAgentStatus, type AgentStatusUpdate } from '../../lib/teamChat/agentStatusBus'
import { publishChatDelta, type ChatDelta } from '../../lib/teamChat/chatDeltaBus'
import { persistTeamChatEntry } from '../../lib/teamChat/persistTeamChatEntry'
import {
  publishBoardChangeWithAttention,
  type RoomedBoardChange,
} from '../../lib/teamChat/publishBoardChange'
import { getCurrentVersion } from '../../lib/updateCheck'
import { apiRouter } from '../index'

// ─── The pinned surface ──────────────────────────────────────────────────────

const PINNED_API_REVISION = 1

const PINNED_CAPABILITY_FIELDS = ['apiRevision', 'features', 'supportFloor', 'version']

const PINNED_FEATURES = [
  'runtime.openclaw',
  'runtime.clawboo-native',
  'runtime.claude-code',
  'runtime.codex',
  'runtime.hermes',
  'chat.rooms',
  'chat.direct',
  'board.verification',
  'board.steering',
  'board.readableIds',
  'board.labels',
  'workspace.view',
  'workspace.preview',
  'agent.nativeShell',
  'agent.screenshots',
  'routines',
  'memory',
  'memory.embeddings',
  'connectors',
  'connectors.custom',
  'connectors.broker',
  'stream.teamChat.resume',
  'stream.agentChat.resume',
  'stream.events.resume',
  'system.selfUpdate',
  'system.hold',
  'auth.proxyIdentity',
]

/** The drain-and-hold answer (GET, POST /api/system/hold, DELETE /api/system/hold/:owner). */
const PINNED_HOLD_FIELDS = ['backgroundWork', 'held', 'holds', 'runs']
const PINNED_HOLD_ENTRY_FIELDS = ['expiresAt', 'expiresInMs', 'heldAt', 'owner', 'reason']
const PINNED_HOLD_RUNS_FIELDS = ['limit', 'queued', 'running']

/** Every route the API router serves, as `METHOD /path`, in registration order. */
const PINNED_ROUTES = [
  'GET /api/settings',
  'POST /api/settings',
  'POST /api/access/launch-code',
  'GET /api/access/identity',
  'GET /api/approvals',
  'POST /api/approvals',
  'GET /api/chat-history',
  'POST /api/chat-history',
  'DELETE /api/chat-history',
  'POST /api/chat-history/reset-context',
  'GET /api/cost-records/summary',
  'GET /api/cost-records',
  'POST /api/cost-records',
  'GET /api/graph-layout',
  'POST /api/graph-layout',
  'GET /api/exec-settings/all',
  'GET /api/exec-settings',
  'POST /api/exec-settings',
  'POST /api/exec-allowlist/revoke',
  'GET /api/exec-allowlist',
  'GET /api/agents/:agentId/shell',
  'POST /api/agents/:agentId/shell',
  'GET /api/personality',
  'POST /api/personality',
  'GET /api/catalog/index',
  'GET /api/catalog/agents/:id',
  'GET /api/catalog/teams/:id',
  'GET /api/skills',
  'POST /api/skills',
  'DELETE /api/skills',
  'GET /api/system/status',
  'POST /api/system/install-openclaw',
  'POST /api/system/configure-openclaw',
  'POST /api/system/auto-configure-openclaw',
  'POST /api/system/gateway',
  'GET /api/system/openclaw-config',
  'PATCH /api/system/openclaw-config',
  'GET /api/system/models',
  'POST /api/system/approve-device',
  'GET /api/system/self-version',
  'GET /api/system/capabilities',
  'POST /api/system/self-update',
  'GET /api/system/hold',
  'POST /api/system/hold',
  'DELETE /api/system/hold/:owner',
  'GET /api/system/operator-settings',
  'PUT /api/system/operator-settings/:key',
  'GET /api/teams',
  'GET /api/teams/member-roles',
  'POST /api/teams',
  'PATCH /api/teams/:id',
  'DELETE /api/teams/:id',
  'POST /api/teams/:id/agents',
  'DELETE /api/teams/:id/agents/:agentId',
  'GET /api/teams/:id/rooms',
  'POST /api/teams/:id/rooms',
  'PATCH /api/teams/:id/rooms/:roomId',
  'DELETE /api/teams/:id/rooms/:roomId',
  'GET /api/teams/:id/onboarding',
  'PATCH /api/teams/:id/onboarding',
  'GET /api/teams/:id/activity-summary',
  'POST /api/teams/:id/chat/stop',
  'POST /api/teams/:id/chat/clear',
  'POST /api/teams/:id/chat',
  'GET /api/teams/:id/chat/stream',
  'GET /api/team-chat',
  'POST /api/team-chat/exchange',
  'GET /api/team-rules/:teamId',
  'PUT /api/team-rules/:teamId',
  'GET /api/team-verify-command/:teamId',
  'PUT /api/team-verify-command/:teamId',
  'GET /api/agents',
  'POST /api/agents',
  'POST /api/agents/sync',
  'GET /api/agents/registry/health',
  'POST /api/agents/cleanup-ghosts',
  'GET /api/agents/:agentId',
  'PATCH /api/agents/:agentId/model',
  'DELETE /api/agents/:agentId',
  'POST /api/agents/:agentId/move',
  'GET /api/agents/:agentId/files/:name',
  'PUT /api/agents/:agentId/files/:name',
  'GET /api/agents/:agentId/sessions',
  'GET /api/agents/:agentId/screenshot',
  'POST /api/agents/:agentId/screenshot/capture',
  'GET /api/agents/:agentId/workspaces',
  'GET /api/agents/:agentId/team-folder/tree',
  'GET /api/agents/:agentId/team-folder/file',
  'POST /api/agents/:agentId/chat/stop',
  'GET /api/agents/:agentId/chat/stream',
  'POST /api/agents/:agentId/chat',
  'GET /api/boo-zero/team-briefs/:teamId',
  'PUT /api/boo-zero/team-briefs/:teamId',
  'DELETE /api/boo-zero/team-briefs/:teamId',
  'GET /api/boo-zero/display-name/:agentId',
  'PUT /api/boo-zero/display-name/:agentId',
  'GET /api/boo-zero/override',
  'POST /api/boo-zero/override',
  'GET /api/teams/:id/task-prefix',
  'PUT /api/teams/:id/task-prefix',
  'GET /api/teams/:id/labels',
  'POST /api/teams/:id/labels',
  'PATCH /api/teams/:id/labels/:labelId',
  'DELETE /api/teams/:id/labels/:labelId',
  'PUT /api/board/:taskId/labels',
  'GET /api/board',
  'POST /api/board',
  'GET /api/board/:taskId',
  'POST /api/board/:taskId/claim',
  'PATCH /api/board/:taskId',
  'POST /api/board/:taskId/comments',
  'POST /api/board/:taskId/retry',
  'POST /api/board/:taskId/assign',
  'GET /api/board/:taskId/executions',
  'POST /api/board/:taskId/executions',
  'PATCH /api/board/executions/:execId',
  'POST /api/board/:taskId/deps',
  'POST /api/board/:taskId/cancel-dependents',
  'POST /api/board/:taskId/workspace/handoff',
  'GET /api/board/:taskId/workspace/detail',
  'GET /api/board/:taskId/preview',
  'GET /api/board/:taskId/preview/*splat',
  'GET /api/board/:taskId/workspace/tree',
  'GET /api/board/:taskId/workspace/file',
  'GET /api/board/:taskId/workspace/file-diff',
  'GET /api/board/:taskId/workspace/status',
  'POST /api/board/:taskId/workspace',
  'GET /api/board/:taskId/workspace',
  'PATCH /api/board/:taskId/workspace',
  'GET /api/memory',
  'POST /api/memory',
  'GET /api/memory/browse',
  'GET /api/memory/graph',
  'POST /api/memory/feedback',
  'GET /api/memory/outcomes',
  'GET /api/memory/provider',
  'POST /api/memory/embedding/reindex',
  'POST /api/memory/embedding/install',
  'GET /api/tools',
  'GET /api/tools/approvals',
  'POST /api/tools/approvals/:id/resolve',
  'GET /api/tools/audit',
  'GET /api/connectors',
  'POST /api/connectors/connect',
  'GET /api/connectors/configured',
  'GET /api/connectors/path-suggestions',
  'GET /api/connectors/composio',
  'PUT /api/connectors/composio/key',
  'DELETE /api/connectors/composio/key',
  'POST /api/connectors/composio/apps/:slug/authorize',
  'GET /api/connectors/custom',
  'POST /api/connectors/custom',
  'DELETE /api/connectors/custom/:slug',
  'POST /api/connectors/:slug/disconnect',
  'POST /api/connectors/:slug/authorize',
  'POST /api/connectors/:slug/authorize/await',
  'DELETE /api/connectors/:slug/authorize',
  'GET /api/connectors/:slug/config',
  'PUT /api/connectors/:slug/config',
  'GET /api/grants',
  'POST /api/grants',
  'POST /api/grants/:id/revoke',
  'POST /api/grants/:id/resume',
  'GET /api/mcp/config',
  'POST /api/mcp/attach-secret/rotate',
  'POST /api/mcp/tasks',
  'GET /api/mcp/tasks',
  'DELETE /api/mcp/tasks',
  'POST /api/mcp/memory',
  'GET /api/mcp/memory',
  'DELETE /api/mcp/memory',
  'POST /api/mcp/tools',
  'GET /api/mcp/tools',
  'DELETE /api/mcp/tools',
  'POST /api/mcp/teamchat',
  'GET /api/mcp/teamchat',
  'DELETE /api/mcp/teamchat',
  'GET /api/runtimes',
  'GET /api/runtimes/openrouter/models',
  'GET /api/runtimes/codex/models',
  'GET /api/providers',
  'GET /api/providers/:id/models',
  'POST /api/providers/:id/models',
  'POST /api/providers/:id/connect',
  'POST /api/providers/:id/disconnect',
  'POST /api/auth/cli-login/:tool',
  'POST /api/runtimes/:id/install',
  'POST /api/runtimes/:id/connect',
  'POST /api/runtimes/:id/disconnect',
  'POST /api/runtimes/:id/logout',
  'POST /api/runtimes/:id/healthcheck',
  'POST /api/runtimes/:id/run',
  'POST /api/onboarding/native-leader-model',
  'GET /api/onboarding/native-leader-model',
  'GET /api/onboarding/state',
  'GET /api/governance/budgets',
  'POST /api/governance/budgets',
  'POST /api/governance/budgets/:scope/:scopeId/resume',
  'GET /api/schedules',
  'GET /api/schedules/occurrences',
  'GET /api/schedules/time-zone',
  'PUT /api/schedules/time-zone',
  'POST /api/schedules',
  'POST /api/schedules/:id/run',
  'GET /api/schedules/:id/runs',
  'PATCH /api/schedules/:id',
  'DELETE /api/schedules/:id',
  'GET /api/governance/audit',
  'POST /api/governance/delegation-approval',
  'GET /api/capabilities',
  'POST /api/capabilities/:action',
  'GET /api/obs/events',
  'GET /api/obs/traces/:traceId',
  'GET /api/obs/errors',
  'GET /api/obs/health',
  'GET /api/obs/graph',
  'GET /api/obs/stream',
  'GET /api/health',
  'POST /api/health/recheck',
  'GET /api/fleet/summary',
  'POST /api/eval/smoke',
]

const CHAT_MESSAGE_FIELDS = [
  'entryId',
  'role',
  'kind',
  'text',
  'sessionKey',
  'runId',
  'source',
  'timestampMs',
  'sequenceKey',
  'confirmed',
  'fingerprint',
  'origin',
  'person',
]
const CHAT_DELTA_FIELDS = ['sessionKey', 'runId', 'text']
const CURSOR_FIELDS = ['cursor']
const AGENT_STATUS_FIELDS = ['agentId', 'status', 'roomId']

/** Each resumable stream: its route, and every field each of its events declares. */
const PINNED_STREAMS = {
  teamChat: {
    route: 'GET /api/teams/:id/chat/stream',
    events: {
      cursor: CURSOR_FIELDS,
      message: CHAT_MESSAGE_FIELDS,
      delta: CHAT_DELTA_FIELDS,
      board: [
        'id',
        'title',
        'status',
        'assigneeAgentId',
        'parentTaskId',
        'identifier',
        'createdAt',
        'updatedAt',
        'summary',
        'attention',
        'roomId',
      ],
      status: AGENT_STATUS_FIELDS,
    },
  },
  agentChat: {
    route: 'GET /api/agents/:agentId/chat/stream',
    events: {
      cursor: CURSOR_FIELDS,
      message: CHAT_MESSAGE_FIELDS,
      delta: CHAT_DELTA_FIELDS,
      status: AGENT_STATUS_FIELDS,
    },
  },
  events: {
    route: 'GET /api/obs/stream',
    events: {
      message: [
        'seq',
        'id',
        'ts',
        'kind',
        'teamId',
        'taskId',
        'agentId',
        'runtime',
        'traceId',
        'spanId',
        'parentSpanId',
        'correlationId',
        'data',
        'tenantId',
        'createdAt',
      ],
    },
  },
} as const

const BUMP =
  'Removing or renaming client-facing surface needs an API revision bump: raise ' +
  'ENGINE_API_REVISION, set PINNED_API_REVISION to match and update the pinned lists.'

// ─── Harness ─────────────────────────────────────────────────────────────────

interface RouteLayer {
  route?: { path: string; methods: Record<string, boolean> }
}

function registeredRoutes(): string[] {
  return (apiRouter.stack as RouteLayer[]).flatMap((layer) => {
    const route = layer.route
    if (!route) return []
    return Object.keys(route.methods).map((m) => `${m.toUpperCase()} ${route.path}`)
  })
}

async function listen(app: Express): Promise<{ server: http.Server; base: string }> {
  const server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }
}

async function close(server: http.Server): Promise<void> {
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
}

interface Frame {
  id?: string
  event: string
  data: string
}

/** One SSE block; null for a comment (`: connected`, `: keepalive`). */
function parseBlock(block: string): Frame | null {
  let id: string | undefined
  let event = 'message'
  const data: string[] = []
  for (const line of block.split('\n')) {
    if (line.startsWith('id: ')) id = line.slice(4)
    else if (line.startsWith('event: ')) event = line.slice(7)
    else if (line.startsWith('data: ')) data.push(line.slice(6))
  }
  if (data.length === 0) return null
  return { ...(id === undefined ? {} : { id }), event, data: data.join('\n') }
}

/**
 * Open a stream, run `onOpen` once its first block (the `: connected` comment)
 * arrives, and collect frames until `done` says so. The route subscribes before it
 * writes that comment, so anything published from `onOpen` reaches it.
 */
async function readStream(
  url: string,
  opts: {
    headers?: Record<string, string>
    onOpen?: () => void
    done: (frames: Frame[]) => boolean
  },
): Promise<Frame[]> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10_000)
  const frames: Frame[] = []
  try {
    const res = await fetch(url, { headers: opts.headers, signal: controller.signal })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/^text\/event-stream/)
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    let opened = false
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let cut = buf.indexOf('\n\n')
      while (cut !== -1) {
        const frame = parseBlock(buf.slice(0, cut))
        buf = buf.slice(cut + 2)
        if (!opened) {
          opened = true
          opts.onOpen?.()
        }
        if (frame) frames.push(frame)
        cut = buf.indexOf('\n\n')
      }
      if (opts.done(frames)) return frames
    }
  } catch (err) {
    if (!controller.signal.aborted) throw err
  } finally {
    clearTimeout(timer)
    controller.abort()
  }
  throw new Error(`stream ended before the expected frames: ${JSON.stringify(frames)}`)
}

/** Every field a pinned event's schema declares. */
function declaredFields(stream: keyof typeof PINNED_STREAMS, event: string): string[] {
  const events = RESUMABLE_STREAMS[stream].events as Record<string, unknown>
  const schema = events[event] as { shape?: Record<string, unknown> } | undefined
  return Object.keys(schema?.shape ?? {})
}

/** Check each frame against its stream's pinned events and schemas. */
function expectFramesMatch(stream: keyof typeof PINNED_STREAMS, frames: Frame[]): void {
  const pinned = Object.keys(PINNED_STREAMS[stream].events)
  const events = RESUMABLE_STREAMS[stream].events as Record<
    string,
    { safeParse: (v: unknown) => { success: boolean; error?: unknown } }
  >
  for (const frame of frames) {
    expect(pinned, `${stream} sent an unpinned event "${frame.event}"`).toContain(frame.event)
    const parsed = events[frame.event]!.safeParse(JSON.parse(frame.data))
    expect(parsed.error, `${stream} ${frame.event}: ${frame.data}`).toBeUndefined()
    // Only stored rows, and the cursor a chat stream opens with, carry an id, so
    // only they move a client's resume cursor.
    if (frame.event === 'message' || frame.event === 'cursor') expect(frame.id).toMatch(/^\d+$/)
    else expect(frame.id).toBeUndefined()
  }
  const seen = new Set(frames.map((f) => f.event))
  expect([...seen].sort(), `${stream} did not send every pinned event`).toEqual([...pinned].sort())
}

let dir: string
let prevHome: string | undefined
let server: http.Server
let base: string

beforeAll(async () => {
  prevHome = process.env['CLAWBOO_HOME']
  dir = mkdtempSync(path.join(os.tmpdir(), 'clawboo-client-contract-'))
  process.env['CLAWBOO_HOME'] = dir
  // Mounted as ../../index.ts mounts it.
  const app = express()
  app.set('case sensitive routing', true)
  app.use(express.json())
  app.use(apiRouter)
  ;({ server, base } = await listen(app))
})
afterAll(async () => {
  await close(server)
  resetDb()
  if (prevHome === undefined) delete process.env['CLAWBOO_HOME']
  else process.env['CLAWBOO_HOME'] = prevHome
  rmSync(dir, { recursive: true, force: true })
})

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('API revision', () => {
  it('is the one this surface was pinned at', () => {
    expect(ENGINE_API_REVISION, `ENGINE_API_REVISION moved without a re-pin. ${BUMP}`).toBe(
      PINNED_API_REVISION,
    )
  })
})

describe('GET /api/system/capabilities', () => {
  it('answers the pinned shape with every flag, and writes nothing', async () => {
    const before = readdirSync(dir)
    const res = await fetch(`${base}/api/system/capabilities`)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const body = (await res.json()) as Record<string, unknown>
    // Read-only and cheap: no database opened, nothing written under the home.
    expect(readdirSync(dir)).toEqual(before)

    expect(Object.keys(body).sort(), BUMP).toEqual([...PINNED_CAPABILITY_FIELDS].sort())
    const caps = engineCapabilitiesSchema.parse(body)
    expect(caps.version).toBe(getCurrentVersion())
    expect(caps.apiRevision).toBe(ENGINE_API_REVISION)
    expect(caps.supportFloor).toBe(supportFloorFor(caps.version))
    expect(Object.keys(caps.features).sort()).toEqual([...ENGINE_FEATURES].sort())

    // No machine path and nothing from the environment beyond the version.
    const text = JSON.stringify(body)
    expect(text).not.toContain(dir)
    expect(text).not.toContain(os.homedir())
  })

  it('keeps every pinned flag name, and pins every flag it has', () => {
    const known = new Set<string>(ENGINE_FEATURES)
    const missing = PINNED_FEATURES.filter((f) => !known.has(f))
    expect(missing, BUMP).toEqual([])
    const unpinned = ENGINE_FEATURES.filter((f) => !PINNED_FEATURES.includes(f))
    expect(unpinned, 'A new flag: add it to PINNED_FEATURES.').toEqual([])
  })

  it('declares the pinned response fields in the exported schema', () => {
    expect(Object.keys(engineCapabilitiesSchema.shape).sort(), BUMP).toEqual(
      [...PINNED_CAPABILITY_FIELDS].sort(),
    )
  })
})

describe('drain and hold', () => {
  it('places, reports and releases a hold in the pinned shape', async () => {
    const json = { 'Content-Type': 'application/json' }
    const placed = await fetch(`${base}/api/system/hold`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ owner: 'contract-client', ttlSeconds: 30, reason: 'stop' }),
    })
    expect(placed.status).toBe(200)
    const body = (await placed.json()) as Record<string, unknown>
    expect(Object.keys(body).sort(), BUMP).toEqual([...PINNED_HOLD_FIELDS].sort())
    const held = engineHoldStateSchema.parse(body)
    expect(held.held).toBe(true)
    expect(Object.keys(held.holds[0]!).sort(), BUMP).toEqual([...PINNED_HOLD_ENTRY_FIELDS].sort())
    expect(Object.keys(held.runs).sort(), BUMP).toEqual([...PINNED_HOLD_RUNS_FIELDS].sort())

    const read = await fetch(`${base}/api/system/hold`)
    expect(engineHoldStateSchema.parse(await read.json()).holds[0]!.owner).toBe('contract-client')

    const refused = await fetch(`${base}/api/system/hold/another-client`, { method: 'DELETE' })
    expect(refused.status).toBe(404)
    const released = await fetch(`${base}/api/system/hold/contract-client`, { method: 'DELETE' })
    expect(released.status).toBe(200)
    expect(engineHoldStateSchema.parse(await released.json()).held).toBe(false)
  })

  it('declares the pinned fields in the exported schemas', () => {
    expect(Object.keys(engineHoldStateSchema.shape).sort(), BUMP).toEqual(
      [...PINNED_HOLD_FIELDS].sort(),
    )
    expect(Object.keys(engineHoldSchema.shape).sort(), BUMP).toEqual(
      [...PINNED_HOLD_ENTRY_FIELDS].sort(),
    )
    expect(Object.keys(engineHoldStateSchema.shape.runs.shape).sort(), BUMP).toEqual(
      [...PINNED_HOLD_RUNS_FIELDS].sort(),
    )
  })
})

describe('routes', () => {
  const registered = registeredRoutes()

  it('serves every pinned route', () => {
    const served = new Set(registered)
    expect(
      PINNED_ROUTES.filter((r) => !served.has(r)),
      BUMP,
    ).toEqual([])
  })

  it('pins every route it serves', () => {
    const pinned = new Set(PINNED_ROUTES)
    expect(
      registered.filter((r) => !pinned.has(r)),
      'A new route: add it to PINNED_ROUTES.',
    ).toEqual([])
  })

  it('serves the routes behind every route-backed flag', () => {
    const served = new Set(registered)
    for (const [flag, routes] of Object.entries(FEATURE_ROUTES)) {
      expect(
        routes.filter((r) => !served.has(r)),
        `${flag} reports a feature whose routes are gone`,
      ).toEqual([])
    }
  })

  it('serves each resumable stream on its pinned route', () => {
    for (const [name, stream] of Object.entries(RESUMABLE_STREAMS)) {
      const pinned = PINNED_STREAMS[name as keyof typeof PINNED_STREAMS]
      expect(`${stream.method} ${stream.path}`, BUMP).toBe(pinned.route)
      expect(registered).toContain(pinned.route)
    }
  })
})

describe('the route has no exemption in the origin guard or the access gate', () => {
  it('refuses a request without the token and a cross-origin one with it, in the server order', async () => {
    const token = 'contract-test-token'
    let port = 0
    const gate = createAccessGate({ token })
    const app = express()
    app.use((req, res, next) => {
      if (createOriginGuard({ port }).checkHttp(req, res)) return
      next()
    })
    app.use((req, res, next) => {
      if (gate.handleHttp(req, res)) return
      next()
    })
    app.use(apiRouter)
    const gated = await listen(app)
    port = Number(new URL(gated.base).port)
    try {
      const url = `${gated.base}/api/system/capabilities`
      const cookie = { cookie: `clawboo_access=${token}` }
      expect((await fetch(url)).status).toBe(401)
      expect((await fetch(url, { headers: cookie })).status).toBe(200)
      const foreign = { ...cookie, origin: 'https://elsewhere.example' }
      expect((await fetch(url, { headers: foreign })).status).toBe(403)
    } finally {
      await close(gated.server)
    }
  })
})

describe('resumable streams', () => {
  it('the server payload types still carry every pinned field', () => {
    // Compile-time: `pnpm typecheck` fails when a server type drops or renames a
    // field the exported frame schemas declare.
    expectTypeOf<TranscriptEntry>().toExtend<ChatMessageFrame>()
    expectTypeOf<ChatDelta>().toExtend<ChatDeltaFrame>()
    expectTypeOf<AgentStatusUpdate>().toExtend<AgentStatusFrame>()
    expectTypeOf<RoomedBoardChange>().toExtend<BoardChangeFrame>()
    expectTypeOf<DbOrchestrationEvent>().toExtend<OrchestrationEventFrame>()
  })

  it('the exported schemas declare exactly the pinned fields', () => {
    for (const [stream, pinned] of Object.entries(PINNED_STREAMS)) {
      const name = stream as keyof typeof PINNED_STREAMS
      expect(Object.keys(RESUMABLE_STREAMS[name].events).sort(), BUMP).toEqual(
        Object.keys(pinned.events).sort(),
      )
      for (const [event, fields] of Object.entries(pinned.events)) {
        expect(declaredFields(name, event).sort(), `${stream} ${event}. ${BUMP}`).toEqual(
          [...fields].sort(),
        )
      }
    }
  })

  it('team chat: resumes from Last-Event-ID and sends every pinned event', async () => {
    const db = getDb()
    const teamId = 'contract-team'
    const agentId = 'contract-member'
    db.insert(teams)
      .values({ id: teamId, name: teamId, icon: 'x', color: '#fff', createdAt: 0, updatedAt: 0 })
      .run()
    db.insert(agents)
      .values({
        id: agentId,
        name: agentId,
        gatewayId: agentId,
        teamId,
        createdAt: 0,
        updatedAt: 0,
      })
      .run()
    const sessionKey = buildTeamSessionKey(agentId, teamId)
    persistTeamChatEntry(db, { teamId, agentId, text: 'seen before', role: 'user', kind: 'user' })
    const seen = latestChatMessageId(db, [sessionKey])
    persistTeamChatEntry(db, {
      teamId,
      agentId,
      text: 'posted by a routine',
      role: 'user',
      kind: 'user',
      origin: { kind: 'routine', routineId: 'r1', routineName: 'Daily' },
    })
    const next = latestChatMessageId(db, [sessionKey])

    const frames = await readStream(`${base}/api/teams/${teamId}/chat/stream`, {
      headers: { 'last-event-id': String(seen) },
      onOpen: () => {
        publishChatDelta(teamId, { sessionKey, runId: 'run-1', text: 'Work' })
        publishBoardChangeWithAttention(db, teamId, { id: 'contract-task', status: 'done' })
        publishAgentStatus(teamId, { agentId, status: 'running', roomId: null })
      },
      done: (f) => ['delta', 'board', 'status'].every((e) => f.some((x) => x.event === e)),
    })

    expect(frames.filter((f) => f.event === 'message').map((f) => f.id)).toEqual([String(next)])
    expectFramesMatch('teamChat', frames)
  })

  it('agent chat: resumes from ?since and sends every pinned event', async () => {
    const db = getDb()
    const agentId = 'contract-solo'
    const sessionKey = agentChatSessionKey(db, agentId)
    // The writer the server-run 1:1 chat commits replies through.
    persistNativeChatEntry(db, agentId, 'seen before', { sessionKey })
    const seen = latestChatMessageId(db, [sessionKey])
    persistNativeChatEntry(db, agentId, 'new reply', { sessionKey })
    const next = latestChatMessageId(db, [sessionKey])

    const frames = await readStream(`${base}/api/agents/${agentId}/chat/stream?since=${seen}`, {
      onOpen: () => {
        publishChatDelta(sessionKey, { sessionKey, runId: 'run-3', text: 'Typ' })
        publishAgentStatus(sessionKey, { agentId, status: 'idle' })
      },
      done: (f) => ['delta', 'status'].every((e) => f.some((x) => x.event === e)),
    })

    expect(frames.filter((f) => f.event === 'message').map((f) => f.id)).toEqual([String(next)])
    expectFramesMatch('agentChat', frames)
  })

  it('event stream: resumes from Last-Event-ID with the row seq as the id', async () => {
    const db = getDb()
    const teamId = 'contract-events'
    const first = appendEvent(db, { kind: 'task_created', teamId, data: { title: 'one' } })
    const second = appendEvent(db, { kind: 'task_claimed', teamId, agentId: 'a1', data: {} })

    const frames = await readStream(`${base}/api/obs/stream?teamId=${teamId}`, {
      headers: { 'last-event-id': String(first.seq) },
      done: (f) => f.some((x) => x.id === String(second.seq)),
    })

    expect(frames.map((f) => f.id)).toEqual([String(second.seq)])
    expect((JSON.parse(frames[0]!.data) as { seq: number }).seq).toBe(second.seq)
    expectFramesMatch('events', frames)
  })
})
