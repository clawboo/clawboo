// Re-export shim. The pure board-orchestration engine + its types now live in
// @clawboo/team-orchestration (shared verbatim by this browser binding and the
// server orchestrator at apps/web/server/lib/teamChat). This shim keeps every
// existing `@/features/group-chat/boardOrchestration` import working unchanged.
export * from '@clawboo/team-orchestration'
