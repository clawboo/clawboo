// @clawboo/capability-registry — the unified capability-inventory seam.
//
// clawboo OBSERVES every capability across all five runtimes (OpenClaw,
// clawboo-native, Claude Code, Codex, Hermes) and MANAGES only what the owning
// runtime cedes. This package holds ONLY the neutral CapabilityRecord types +
// the `CapabilitySource` trait + the `CapabilityMultiplexer` (browser-safe, zero
// runtime deps), mirroring @clawboo/agent-registry's package shape and
// @clawboo/scheduler's read()-fan-in trait. The five concrete CapabilitySource
// adapters live server-side. One merged CapabilityRecord stream feeds BOTH the
// Ghost Graph AND the Capabilities dashboard.

export type {
  CanonicalMcpServer,
  CapabilityAvailability,
  CapabilityKind,
  CapabilityManageability,
  CapabilityOrigin,
  CapabilityProvenance,
  CapabilityRecord,
  CapabilityRuntime,
  CapabilityScope,
  CapabilitySourceId,
  CapabilityStatus,
} from './records'

export type {
  CapabilityApprovalDecision,
  CapabilityInstallSpec,
  CapabilityReadResult,
  CapabilitySource,
  CapabilityWriteAction,
  SourceReadStatus,
} from './source'

export { UnknownCapabilityError, UnsupportedCapabilityWriteError, unsupported } from './errors'

export {
  CapabilityMultiplexer,
  makeCapabilityId,
  parseCapabilityId,
  type MergedCapabilityRead,
} from './registry'
