// App-safe barrel: the trait, the normalized event union, the registry, and the
// async-queue primitive adapters use. The contract test-suite lives under the
// `./contract` subpath (it imports a test runner) so app consumers never pull
// test deps through this entry point.

export type { RuntimeEvent, RuntimeEventKind, RuntimeEventBase, Usage } from './runtime-event'
export { assertExhaustive } from './runtime-event'

export type {
  RuntimeAdapter,
  RuntimeId,
  ParticipantKind,
  Capabilities,
  RuntimeClass,
  NativeHomeClaim,
  HealthResult,
  TaskHandle,
  StartOpts,
  RunHandle,
  SessionCodec,
} from './types'

export type { IntegrationHome, RuntimeIntegrationPlan } from './integration'
export { resolveRuntimeIntegration } from './integration'

export { RuntimeRegistry } from './registry'

export type { AsyncQueue } from './async-queue'
export { createAsyncQueue } from './async-queue'

export type { RotationTrigger, RotationHandoff, RotateSessionOpts } from './session-rotation'
export {
  shouldRotate,
  buildRotationHandoffNote,
  rotateSession,
  DEFAULT_ROTATION,
} from './session-rotation'
