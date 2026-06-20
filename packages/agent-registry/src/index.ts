// @clawboo/agent-registry — the agent-registry-of-record seam.
//
// SQLite becomes the source of truth for the agent/team/session registry; OpenClaw
// becomes one `AgentSource` among (eventually) many. This package holds ONLY the
// neutral record types + the `AgentSource` trait + the `AgentRegistry` multiplexer
// (browser-safe, zero runtime deps), mirroring how @clawboo/executor holds the
// `RuntimeAdapter` trait. The concrete `OpenClawAgentSource` lives server-side.

export type {
  AgentRecord,
  AgentRecordStatus,
  ParticipantKind,
  RuntimeId,
  SessionRecord,
  TeamRecord,
} from './records'

export type {
  AgentEvent,
  AgentFileName,
  AgentSource,
  CreateAgentInput,
  HealthResult,
  SyncResult,
  UpdateAgentInput,
} from './source'
export { AGENT_FILE_NAMES } from './source'

export { AgentRegistry } from './registry'
