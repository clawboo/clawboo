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
  ToolExecutorResult,
  ToolImage,
  ToolOwner,
  ToolProvenance,
  ToolRisk,
} from './types'

export { toolOutputOf } from './types'

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
  actionFor,
  evaluateInjection,
  injectionAuditSummary,
  isSkillSafe,
  scanForInjection,
  type EvaluateInjectionOptions,
  type InjectionAction,
  type InjectionEvaluation,
  type InjectionFinding,
  type InjectionIntent,
  type InjectionSeverity,
  type InjectionSurface,
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

export {
  buildConnectorDescriptor,
  type ConnectorDescriptorOptions,
  type RemoteToolFacts,
} from './connectorDescriptor'
export {
  CONNECTOR_TOOL_PREFIX,
  isConnectorToolName,
  namespacedToolName,
  parseNamespacedToolName,
  type NamespaceRejection,
  type NamespaceResult,
} from './namespace'
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

export {
  grantedBrokeredToolkits,
  isToolVisibleToAgent,
  type ToolVisibilityContext,
} from './grantVisibility'
export { brokeredMetaToolKind } from './brokeredApp'
export { brokeredFailureMessage } from './brokeredFailure'
export { toolClassOf, toolSummaryOf, type ToolClass } from './toolClass'
export {
  putToolResult,
  readToolResult,
  reapToolResults,
  type StoredToolResult,
  type ToolResultPage,
} from './resultStore'
export { buildCeilingView, type CeilingView, type CeilingOptions } from './resultCeiling'
