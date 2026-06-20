import { Router, type Router as RouterType } from 'express'

import { settingsGET, settingsPOST } from './settings'
import { approvalsGET, approvalsPOST } from './approvals'
import { chatHistoryGET, chatHistoryPOST, chatHistoryDELETE } from './chatHistory'
import { costRecordsGET, costRecordsPOST } from './costRecords'
import { costRecordsSummaryGET } from './costRecordsSummary'
import { graphLayoutGET, graphLayoutPOST } from './graphLayout'
import { execSettingsGET, execSettingsAllGET, execSettingsPOST } from './execSettings'
import { personalityGET, personalityPOST } from './personality'
import { skillsGET, skillsPOST, skillsDELETE } from './skills'
import {
  systemStatusGET,
  installOpenclawPOST,
  configureOpenclawPOST,
  gatewayControlPOST,
  openclawConfigGET,
  openclawConfigPATCH,
  systemModelsGET,
  approveDevicePOST,
} from './system'
import {
  teamsGET,
  teamsPOST,
  teamsPATCH,
  teamsDELETE,
  teamAgentPOST,
  teamAgentDELETE,
} from './teams'
import { teamChatGET, teamChatExchangePOST } from './teamChat'
import {
  agentsDELETE,
  agentsCleanupPOST,
  agentsListGET,
  agentsRegistryHealthGET,
  agentsCreatePOST,
  agentsSyncPOST,
  agentGET,
  agentFileGET,
  agentFilePUT,
  agentSessionsGET,
} from './agents'
import { teamOnboardingGET, teamOnboardingPATCH } from './teamOnboarding'
import { teamRulesGET, teamRulesPUT } from './teamRules'
import {
  teamBriefGET,
  teamBriefPUT,
  teamBriefDELETE,
  globalBriefGET,
  globalBriefPUT,
  displayNameGET,
  displayNamePUT,
} from './booZero'
import {
  boardListGET,
  boardGetGET,
  boardCreatePOST,
  boardClaimPOST,
  boardUpdatePATCH,
  boardCancelDependentsPOST,
  boardCommentPOST,
  boardExecutionCreatePOST,
  boardExecutionCompletePATCH,
  boardExecutionsGET,
  boardLinkDepPOST,
  boardWorkspaceProvisionPOST,
  boardWorkspaceGET,
  boardWorkspaceDetailGET,
  boardWorkspaceHandoffPOST,
  boardWorkspaceActionPATCH,
} from './board'
import { memorySearchGET, memorySavePOST, memoryBrowseGET, memoryProviderGET } from './memory'
import { capabilitiesListGET, capabilitiesActionPOST } from './capabilities'
import { toolsListGET, toolsApprovalsGET, toolsApprovalResolvePOST, toolsAuditGET } from './tools'
import {
  mcpConfigGET,
  mcpTasksPost,
  mcpTasksSession,
  mcpMemoryPost,
  mcpMemorySession,
  mcpToolsPost,
  mcpToolsSession,
  mcpTeamchatPost,
  mcpTeamchatSession,
} from './mcp'
import {
  runtimesListGET,
  runtimesInstallPOST,
  runtimesConnectPOST,
  runtimesDisconnectPOST,
  runtimesHealthcheckPOST,
  runtimesRunPOST,
} from './runtimes'
import { onboardingSeedNativeTeamPOST } from './onboardingSeed'
import { budgetsListGET, budgetsResumePOST, budgetsSetPOST } from './budgets'
import { governanceAuditGET } from './governanceAudit'
import { delegationApprovalPOST } from './delegationApproval'
import {
  obsErrorsGET,
  obsEventsGET,
  obsGraphGET,
  obsHealthGET,
  obsIngestPOST,
  obsStreamGET,
  obsTraceGET,
} from './obs'
import { evalSmokePOST } from './evalSmoke'
import { fleetSummaryGET } from './fleet'
import { healthGET, healthRecheckPOST } from './health'
import {
  schedulesCreatePOST,
  schedulesDELETE,
  schedulesListGET,
  schedulesRunPOST,
  schedulesUpdatePATCH,
} from './schedules'

const router: RouterType = Router()

// Settings
router.get('/api/settings', settingsGET)
router.post('/api/settings', settingsPOST)

// Approvals
router.get('/api/approvals', approvalsGET)
router.post('/api/approvals', approvalsPOST)

// Chat history
router.get('/api/chat-history', chatHistoryGET)
router.post('/api/chat-history', chatHistoryPOST)
router.delete('/api/chat-history', chatHistoryDELETE)

// Cost records — summary must be before the shorter prefix
router.get('/api/cost-records/summary', costRecordsSummaryGET)
router.get('/api/cost-records', costRecordsGET)
router.post('/api/cost-records', costRecordsPOST)

// Graph layout
router.get('/api/graph-layout', graphLayoutGET)
router.post('/api/graph-layout', graphLayoutPOST)

// Exec settings — /all must come before the shorter prefix
router.get('/api/exec-settings/all', execSettingsAllGET)
router.get('/api/exec-settings', execSettingsGET)
router.post('/api/exec-settings', execSettingsPOST)

// Personality
router.get('/api/personality', personalityGET)
router.post('/api/personality', personalityPOST)

// Skills
router.get('/api/skills', skillsGET)
router.post('/api/skills', skillsPOST)
router.delete('/api/skills', skillsDELETE)

// System management
router.get('/api/system/status', systemStatusGET)
router.post('/api/system/install-openclaw', installOpenclawPOST)
router.post('/api/system/configure-openclaw', configureOpenclawPOST)
router.post('/api/system/gateway', gatewayControlPOST)
router.get('/api/system/openclaw-config', openclawConfigGET)
router.patch('/api/system/openclaw-config', openclawConfigPATCH)
router.get('/api/system/models', systemModelsGET)
router.post('/api/system/approve-device', approveDevicePOST)

// Teams
router.get('/api/teams', teamsGET)
router.post('/api/teams', teamsPOST)
router.patch('/api/teams/:id', teamsPATCH)
router.delete('/api/teams/:id', teamsDELETE)
router.post('/api/teams/:id/agents', teamAgentPOST)
router.delete('/api/teams/:id/agents/:agentId', teamAgentDELETE)

// Team onboarding (per-team boolean flags for "Know Your Team" gate)
router.get('/api/teams/:id/onboarding', teamOnboardingGET)
router.patch('/api/teams/:id/onboarding', teamOnboardingPATCH)

// Mixed-runtime peer chat — the durable team-room read (the model-facing write
// half is the TeamChat MCP server at /api/mcp/teamchat). POST /exchange is the
// explicit kickoff for one bounded leader/peer exchange (runtime adapters drive
// real turns; lifecycle projected into the obs log) — an invokable trigger, not
// an autonomous loop.
router.get('/api/team-chat', teamChatGET)
router.post('/api/team-chat/exchange', teamChatExchangePOST)

// Team rules — user-captured rules injected into every team agent's preamble.
// Source: maintenance panel textarea OR /rule slash command in the composer.
router.get('/api/team-rules/:teamId', teamRulesGET)
router.put('/api/team-rules/:teamId', teamRulesPUT)

// Agents — the registry-of-record (AgentSource decoupling). SQLite is the source
// of truth; the OpenClawAgentSource syncs the Gateway IN. Reads serve SQLite (work
// even when the Gateway is down); writes/files/sessions delegate to the Gateway and
// 503 when its server-side connection is down. STATIC paths register BEFORE
// `:agentId` so the param doesn't swallow 'registry'/'sync'/'cleanup-ghosts'.
router.get('/api/agents', agentsListGET)
router.post('/api/agents', agentsCreatePOST)
router.post('/api/agents/sync', agentsSyncPOST)
router.get('/api/agents/registry/health', agentsRegistryHealthGET)
router.post('/api/agents/cleanup-ghosts', agentsCleanupPOST)
router.get('/api/agents/:agentId', agentGET)
router.delete('/api/agents/:agentId', agentsDELETE)
router.get('/api/agents/:agentId/files/:name', agentFileGET)
router.put('/api/agents/:agentId/files/:name', agentFilePUT)
router.get('/api/agents/:agentId/sessions', agentSessionsGET)

// Boo Zero context — per-team briefs + global brief.
// Per-team briefs are SQLite-backed and FK-cascade on team delete; the
// global brief lives in the settings key/value table.
router.get('/api/boo-zero/team-briefs/:teamId', teamBriefGET)
router.put('/api/boo-zero/team-briefs/:teamId', teamBriefPUT)
router.delete('/api/boo-zero/team-briefs/:teamId', teamBriefDELETE)
router.get('/api/boo-zero/global-brief', globalBriefGET)
router.put('/api/boo-zero/global-brief', globalBriefPUT)
router.get('/api/boo-zero/display-name/:agentId', displayNameGET)
router.put('/api/boo-zero/display-name/:agentId', displayNamePUT)

// Durable board.
router.get('/api/board', boardListGET)
router.post('/api/board', boardCreatePOST)
router.get('/api/board/:taskId', boardGetGET)
router.post('/api/board/:taskId/claim', boardClaimPOST)
router.patch('/api/board/:taskId', boardUpdatePATCH)
router.post('/api/board/:taskId/comments', boardCommentPOST)
// Execution ledger (distinct two-segment paths — no collision with /:taskId).
router.get('/api/board/:taskId/executions', boardExecutionsGET)
router.post('/api/board/:taskId/executions', boardExecutionCreatePOST)
router.patch('/api/board/executions/:execId', boardExecutionCompletePATCH)
// Dependency links (plans / blockedBy) — the ready-pump fires the next task.
router.post('/api/board/:taskId/deps', boardLinkDepPOST)
router.post('/api/board/:taskId/cancel-dependents', boardCancelDependentsPOST)
// Per-task worktree system-of-record. Handoff is a longer
// path than the bare workspace route — distinct, no collision.
router.post('/api/board/:taskId/workspace/handoff', boardWorkspaceHandoffPOST)
router.get('/api/board/:taskId/workspace/detail', boardWorkspaceDetailGET)
router.post('/api/board/:taskId/workspace', boardWorkspaceProvisionPOST)
router.get('/api/board/:taskId/workspace', boardWorkspaceGET)
router.patch('/api/board/:taskId/workspace', boardWorkspaceActionPATCH)

// MCP trifecta. Memory + Tools REST surfaces are for the UI; /api/mcp/* is the
// in-process Streamable-HTTP transport; /api/mcp/config emits the per-runtime
// attach snippet.
router.get('/api/memory', memorySearchGET)
router.post('/api/memory', memorySavePOST)
router.get('/api/memory/browse', memoryBrowseGET)
router.get('/api/memory/provider', memoryProviderGET)
router.get('/api/tools', toolsListGET)
router.get('/api/tools/approvals', toolsApprovalsGET)
router.post('/api/tools/approvals/:id/resolve', toolsApprovalResolvePOST)
router.get('/api/tools/audit', toolsAuditGET)
router.get('/api/mcp/config', mcpConfigGET)
router.post('/api/mcp/tasks', mcpTasksPost)
router.get('/api/mcp/tasks', mcpTasksSession)
router.delete('/api/mcp/tasks', mcpTasksSession)
router.post('/api/mcp/memory', mcpMemoryPost)
router.get('/api/mcp/memory', mcpMemorySession)
router.delete('/api/mcp/memory', mcpMemorySession)
router.post('/api/mcp/tools', mcpToolsPost)
router.get('/api/mcp/tools', mcpToolsSession)
router.delete('/api/mcp/tools', mcpToolsSession)
router.post('/api/mcp/teamchat', mcpTeamchatPost)
router.get('/api/mcp/teamchat', mcpTeamchatSession)
router.delete('/api/mcp/teamchat', mcpTeamchatSession)

// Non-OpenClaw runtimes. POST drives a board task on the chosen runtime.
router.get('/api/runtimes', runtimesListGET)
// Install the runtime CLI (SSE) / connect the provider key (encrypted vault) /
// disconnect. Distinct two-segment suffixes — no collision with `:id/run`.
router.post('/api/runtimes/:id/install', runtimesInstallPOST)
router.post('/api/runtimes/:id/connect', runtimesConnectPOST)
router.post('/api/runtimes/:id/disconnect', runtimesDisconnectPOST)
// Verify a pasted provider key (native, multi-provider) BEFORE seeding. Distinct
// two-segment suffix — no collision with `:id/run`.
router.post('/api/runtimes/:id/healthcheck', runtimesHealthcheckPOST)
router.post('/api/runtimes/:id/run', runtimesRunPOST)

// Onboarding — seed a default native leader + specialist team (the native
// first-run lands here straight after connecting a provider key).
router.post('/api/onboarding/seed-native-team', onboardingSeedNativeTeamPOST)

// Governance. Budget kill-switch caps + the forensic audit.
router.get('/api/governance/budgets', budgetsListGET)
router.post('/api/governance/budgets', budgetsSetPOST)
router.post('/api/governance/budgets/:scope/:scopeId/resume', budgetsResumePOST)

// Unified Scheduler surface — merged read over clawboo Routines + the OpenClaw
// Gateway cron (operator WS-RPC); writes routed by owner. The Scheduler tab's backend.
router.get('/api/schedules', schedulesListGET)
router.post('/api/schedules', schedulesCreatePOST)
router.post('/api/schedules/:id/run', schedulesRunPOST)
router.patch('/api/schedules/:id', schedulesUpdatePATCH)
router.delete('/api/schedules/:id', schedulesDELETE)
router.get('/api/governance/audit', governanceAuditGET)
router.post('/api/governance/delegation-approval', delegationApprovalPOST)

// Unified capability inventory — ONE merged stream (records + per-source
// degradation) feeding BOTH the Ghost Graph and the Capabilities dashboard;
// writes manageability-gated, reusing the existing tool-broker audit/approval pipeline.
router.get('/api/capabilities', capabilitiesListGET)
router.post('/api/capabilities/:action', capabilitiesActionPOST)

// Observability. The event-log feed, a reconstructed trace, the harness-bug
// error query (taxonomy alert), the fleet-health triage, and the graph projection.
router.get('/api/obs/events', obsEventsGET)
router.get('/api/obs/traces/:traceId', obsTraceGET)
router.get('/api/obs/errors', obsErrorsGET)
router.get('/api/obs/health', obsHealthGET)
router.get('/api/obs/graph', obsGraphGET)
router.get('/api/obs/stream', obsStreamGET) // SSE live-tail (task/agent/team scoped)
router.post('/api/obs/ingest', obsIngestPOST) // client mirror of OpenClaw runtime events

// System Health — the boot-probe surface (state dir, vault, db, port, mcp, gateway).
router.get('/api/health', healthGET)
router.post('/api/health/recheck', healthRecheckPOST)

// Fleet-health overview — a read-only aggregation (agents · per-runtime health ·
// 24h task/verification pass-rate · spend · budgets). Never recomputes.
router.get('/api/fleet/summary', fleetSummaryGET)

// Eval smoke run. On-demand, button-triggered: runs the deterministic
// SMOKE_TASKS suite on ephemeral throwaway boards → a real SuiteReport. The full
// live ablation stays CI-only (the `evals` workflow, manually triggered).
router.post('/api/eval/smoke', evalSmokePOST)

export { router as apiRouter }
