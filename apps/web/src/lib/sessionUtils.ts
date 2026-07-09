// `agentIdFromSessionKey` + `buildTeamSessionKey` moved to
// @clawboo/team-orchestration (shared with the server orchestrator); re-exported
// here so existing `@/lib/sessionUtils` imports keep working. The former team-chat
// override machinery (a Gateway-event redirect map) was RETIRED with the browser
// team-orchestration path — the server orchestrator owns team runs now, so the
// browser never redirects team-scoped events.
export { agentIdFromSessionKey, buildTeamSessionKey } from '@clawboo/team-orchestration'
