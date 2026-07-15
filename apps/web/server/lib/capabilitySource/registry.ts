// The process-wide CapabilityMultiplexer singleton — registers all five
// CapabilitySource adapters (the scheduleSource/registry.ts pattern). The
// OpenClaw adapter reuses the SHARED operator connection (getRegistry().source);
// it never opens a second Gateway connection.

import { CapabilityMultiplexer } from '@clawboo/capability-registry'

import { getRegistry } from '../agentSource/registry'
import { getDbPath } from '../db'
import { ClaudeCodeCapabilitySource } from './claudeCode'
import { CodexCapabilitySource } from './codex'
import { HermesCapabilitySource } from './hermes'
import { NativeCapabilitySource } from './native'
import { OpenClawCapabilitySource } from './openclaw'

let singleton: CapabilityMultiplexer | null = null

export function getCapabilityMultiplexer(): CapabilityMultiplexer {
  if (singleton) return singleton
  const mux = new CapabilityMultiplexer()
  mux.register(new NativeCapabilitySource({ getDbPath }))
  mux.register(new HermesCapabilitySource({ getDbPath }))
  mux.register(new ClaudeCodeCapabilitySource())
  mux.register(new CodexCapabilitySource())
  mux.register(new OpenClawCapabilitySource({ client: getRegistry().source, getDbPath }))
  singleton = mux
  return mux
}
