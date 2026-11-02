// The provider keys a task-runner run gets in its environment: every variable
// the runtime reads, resolved the way its card resolves them. Shared by the
// agent Routine fire and a person's rerun from the board.

import { getDescriptor, isRuntimeId } from './descriptor'
import { resolveRuntimeKeyForRuntime } from '../secretsVault'

export function runtimeKeyEnv(runtime: string): Record<string, string> {
  const apiKeyEnv: Record<string, string> = {}
  if (!isRuntimeId(runtime)) return apiKeyEnv
  const d = getDescriptor(runtime)
  for (const envVar of [d.envVar, ...(d.altEnvVars ?? [])]) {
    if (!envVar) continue
    const key = resolveRuntimeKeyForRuntime(runtime, envVar)
    if (key) apiKeyEnv[envVar] = key
  }
  return apiKeyEnv
}
