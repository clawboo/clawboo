// The engine's answer to "what are you, and what can you do?": its version, the
// client-facing API revision, the oldest minor whose clients it still serves,
// and a flat map of feature flags. Served by GET /api/system/capabilities so a
// client checks before it uses a feature instead of probing routes.
//
// Built per request from in-process facts only: no database read, no network,
// no child process, nothing written. The flags describe what this engine can
// do, never machine state (whether a runtime's CLI is installed lives on
// GET /api/runtimes) and never a secret or a path.

import {
  ENGINE_API_REVISION,
  supportFloorFor,
  type EngineCapabilities,
  type EngineFeature,
} from '@clawboo/control-client'
import { embeddingsDisabled } from '@clawboo/db'

import { appLinkOn, proxyIdentityMode } from './proxyIdentity/config'
import { NON_OPENCLAW_RUNTIME_IDS } from './runtimes/descriptor'
import { getCurrentVersion, selfUpdateRefusal } from './updateCheck'

/**
 * The routes each route-backed flag stands for, as `METHOD /path` exactly as the
 * router registers them. The contract test fails when one is missing, so a flag
 * can never report a feature whose routes are gone.
 */
export const FEATURE_ROUTES = {
  'chat.rooms': [
    'GET /api/teams/:id/rooms',
    'POST /api/teams/:id/rooms',
    'PATCH /api/teams/:id/rooms/:roomId',
    'DELETE /api/teams/:id/rooms/:roomId',
  ],
  'chat.direct': [
    'POST /api/agents/:agentId/chat',
    'POST /api/agents/:agentId/chat/stop',
    'GET /api/agents/:agentId/chat/stream',
  ],
  'board.steering': ['POST /api/board/:taskId/comments'],
  'board.reopen': ['POST /api/board/:taskId/reopen'],
  'board.personAssignees': ['POST /api/board/:taskId/assign-person'],
  'board.questions': [
    'GET /api/board/:taskId/questions',
    'POST /api/board/questions/:questionId/answer',
  ],
  'board.agentWakes': [
    'POST /api/board/agent-wakes/:jobTaskId',
    'GET /api/team-agent-wakes/:teamId',
    'PUT /api/team-agent-wakes/:teamId',
  ],
  'board.jobLimit': ['POST /api/board/job-limit/:jobTaskId'],
  'board.planDocuments': ['GET /api/board/:taskId/plan'],
  'board.planApproval': [
    'GET /api/team-plan-approval/:teamId',
    'PUT /api/team-plan-approval/:teamId',
  ],
  'board.readableIds': ['GET /api/teams/:id/task-prefix', 'PUT /api/teams/:id/task-prefix'],
  'board.labels': [
    'GET /api/teams/:id/labels',
    'POST /api/teams/:id/labels',
    'PATCH /api/teams/:id/labels/:labelId',
    'DELETE /api/teams/:id/labels/:labelId',
    'PUT /api/board/:taskId/labels',
  ],
  'board.inbox': [
    'GET /api/board/inbox',
    'POST /api/board/inbox/read',
    'POST /api/board/:taskId/read',
  ],
  'workspace.view': [
    'GET /api/agents/:agentId/workspaces',
    'GET /api/board/:taskId/workspace/tree',
    'GET /api/board/:taskId/workspace/file',
    'GET /api/board/:taskId/workspace/file-diff',
    'GET /api/board/:taskId/workspace/status',
  ],
  'workspace.preview': ['GET /api/board/:taskId/preview', 'GET /api/board/:taskId/preview/*splat'],
  'agent.nativeShell': ['GET /api/agents/:agentId/shell', 'POST /api/agents/:agentId/shell'],
  'agent.screenshots': [
    'GET /api/agents/:agentId/screenshot',
    'POST /api/agents/:agentId/screenshot/capture',
  ],
  routines: [
    'GET /api/schedules',
    'GET /api/schedules/occurrences',
    'POST /api/schedules',
    'POST /api/schedules/:id/run',
    'GET /api/schedules/:id/runs',
    'PATCH /api/schedules/:id',
    'DELETE /api/schedules/:id',
  ],
  memory: ['GET /api/memory', 'POST /api/memory', 'GET /api/memory/browse'],
  'memory.embeddings': ['GET /api/memory/provider'],
  connectors: [
    'GET /api/connectors',
    'POST /api/connectors/connect',
    'POST /api/connectors/:slug/disconnect',
  ],
  'connectors.custom': [
    'GET /api/connectors/custom',
    'POST /api/connectors/custom',
    'DELETE /api/connectors/custom/:slug',
  ],
  'connectors.broker': [
    'GET /api/connectors/composio',
    'PUT /api/connectors/composio/key',
    'DELETE /api/connectors/composio/key',
    'POST /api/connectors/composio/apps/:slug/authorize',
  ],
  'stream.teamChat.resume': ['GET /api/teams/:id/chat/stream'],
  'stream.agentChat.resume': ['GET /api/agents/:agentId/chat/stream'],
  'stream.events.resume': ['GET /api/obs/stream'],
  'system.selfUpdate': ['POST /api/system/self-update'],
  'system.hold': [
    'GET /api/system/hold',
    'POST /api/system/hold',
    'DELETE /api/system/hold/:owner',
  ],
  'board.pause': ['GET /api/pauses', 'POST /api/pauses', 'DELETE /api/pauses/:kind/:id'],
  'auth.proxyIdentity': ['GET /api/access/identity'],
  'auth.appLink': ['GET /api/access/identity'],
} as const satisfies Partial<Record<EngineFeature, readonly string[]>>

export function buildEngineCapabilities(): EngineCapabilities {
  // The same source GET /api/system/self-version reports as `current`.
  const version = getCurrentVersion()
  const runtimes = new Set<string>(NON_OPENCLAW_RUNTIME_IDS)
  const features: Record<EngineFeature, boolean> = {
    // OpenClaw agents run in their own Gateway, which this engine always speaks to.
    'runtime.openclaw': true,
    'runtime.clawboo-native': runtimes.has('clawboo-native'),
    'runtime.claude-code': runtimes.has('claude-code'),
    'runtime.codex': runtimes.has('codex'),
    'runtime.hermes': runtimes.has('hermes'),
    'chat.rooms': true,
    'chat.direct': true,
    // Inside a 1:1 turn and that chat's stream, so it has no route of its own.
    'chat.handOffs': true,
    // Enforced inside the board's status change, so it has no route of its own
    // and no switch: a task whose stored verdict fails cannot reach done
    // without a person's override. A task with no verdict can still be moved.
    'board.verification': true,
    // Inside the team-chat work check too, so no route of its own: a waiting check
    // marks its task with `checkHeldSince`.
    'board.checkHold': true,
    // An agent's report on its task, which moves nothing (the server decides Done).
    'board.reportResult': true,
    // A task that hands out work waits for it, and gets one follow-up turn.
    'board.parentWaits': true,
    'board.steering': true,
    // Enforced inside each person write (lib/auth.ts), on no route of its own.
    'board.personCheck': true,
    'board.readableIds': true,
    'board.labels': true,
    'board.inbox': true,
    // Inside the engine and the board's own writes, so no route of its own: a request's
    // main task is a row with `isMainTask`, and its work is filed under it.
    'board.mainTasks': true,
    // Part of the board's own writes and the dispatch pump, so it has no route of its
    // own and no switch. What a comment did is in its reply's `delivery`.
    'board.wakes': true,
    // Agents waking each other once a person said yes for the job.
    'board.agentWakes': true,
    // The count of runs a job starts by itself, and a person's answer at its limit.
    'board.jobLimit': true,
    // How a run's ending is read: no route or switch of its own. A task's `waitingOn`
    // and `attention` carry the new reasons, and a run's `status` the new endings.
    'board.endings': true,
    'board.reopen': true,
    'board.personAssignees': true,
    'board.questions': true,
    'board.planDocuments': true,
    'board.planApproval': true,
    'workspace.view': true,
    'workspace.preview': true,
    'agent.nativeShell': true,
    'agent.screenshots': true,
    routines: true,
    memory: true,
    // The operator's off switch. Whether a provider is ready to embed is a probe,
    // so it stays on GET /api/memory/provider.
    'memory.embeddings': !embeddingsDisabled(),
    connectors: true,
    'connectors.custom': true,
    'connectors.broker': true,
    'stream.teamChat.resume': true,
    'stream.agentChat.resume': true,
    'stream.events.resume': true,
    // Matches self-version's `applyable`: a global npm install this user can
    // write, with in-app updates not turned off by an administrator.
    'system.selfUpdate': selfUpdateRefusal() === null,
    'system.hold': true,
    'board.pause': true,
    // The administrator's switch, on or required. Either way a verified token
    // names the person; whether one is required is the lane's own business.
    'auth.proxyIdentity': proxyIdentityMode() !== 'off',
    // On only when the app that started this engine handed it a key.
    'auth.appLink': appLinkOn(),
  }
  return {
    version,
    apiRevision: ENGINE_API_REVISION,
    supportFloor: supportFloorFor(version),
    features,
  }
}
