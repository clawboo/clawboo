// ─── Tools broker — availability + inspectors + audit ──────────
export type {
  AvailabilityContext,
  AvailabilityRequirement,
  AvailabilityResult,
  ChainOutcome,
  Inspector,
  InspectorDecision,
  ToolCall,
  ToolCallContext,
  ToolDescriptor,
  ToolOwner,
  ToolProvenance,
  ToolRisk,
} from './types'

export {
  defaultAvailabilityContext,
  evaluateAvailability,
  type DefaultAvailabilityOpts,
} from './availability'

export {
  argClampInspector,
  defaultInspectors,
  riskClassifierInspector,
  runInspectors,
  scopeInspector,
  securityInspector,
} from './inspectors'

export {
  isSkillSafe,
  scanForInjection,
  type InjectionFinding,
  type InjectionSeverity,
} from './injection'

export {
  provenancePayload,
  signProvenance,
  verifyProvenance,
  b64urlToBytes,
  bytesToB64url,
  type ProvenanceResult,
  type ProvenanceVerifyOpts,
} from './provenance'

export { scrubArgsSummary, scrubResultSummary, scrubSecrets } from './scrub'

export { ToolRegistry, createBuiltinRegistry, type VisibleTool } from './registry'
export { BUILTIN_TOOLS, deletePathTool, echoTool, memoryNoteTool, webSearchTool } from './builtins'

export {
  createApproval,
  expireStaleApprovals,
  getApproval,
  getDescriptorMetadata,
  isToolEnabled,
  listAudit,
  listPendingApprovals,
  persistDescriptorMetadata,
  resolveApproval,
  seedBuiltinTools,
  setToolEnabled,
  waitForApproval,
  writeAuditAfter,
  writeAuditBefore,
  type ApprovalDecision,
  type ApprovalResolution,
} from './persistence'

export { executeBrokeredCall, type BrokeredResult, type BrokerOptions } from './broker'

export {
  listToolsQuery,
  resolveApprovalBody,
  type ListToolsQuery,
  type ResolveApprovalBody,
} from './schemas'
