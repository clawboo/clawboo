// The run an agent has in progress, for MCP connections that outlive any one
// run.
//
// Most runtimes get fresh attach URLs for every run, each signed with that run's
// scope (its team, its task, its run id, whether the team engine drives it).
// Hermes's gateway connects to Clawboo's MCP servers once per agent and keeps the
// connection, so its URL can only name the agent (`live=1`, signed). Each call on
// such a URL is bound here, at call time, to the run that agent has in progress.
//
// One entry per agent. Runs of an agent whose runtime keeps a home go one at a
// time (the identity home lock), so there is never more than one to choose from.
// What is NOT told apart: a call the runtime makes on its own while a Clawboo run
// is in progress for the same agent (a Hermes job of its own firing then) is
// bound to that run as well.

import type { RuntimeRunContext } from './runtimes/types'

export type LiveRunScope = NonNullable<RuntimeRunContext['memoryScope']>

const bindings = new Map<string, { token: symbol; scope: LiveRunScope }>()

/** Bind an agent's live MCP calls to this run. Returns the release, which undoes
 *  only this binding: a later run's binding is left alone. */
export function bindLiveRun(agentId: string, scope: LiveRunScope): () => void {
  const token = Symbol(agentId)
  bindings.set(agentId, { token, scope })
  return () => {
    if (bindings.get(agentId)?.token === token) bindings.delete(agentId)
  }
}

/** The scope of the run the agent has in progress, or null. */
export function liveRunScope(agentId: string): LiveRunScope | null {
  return bindings.get(agentId)?.scope ?? null
}

/** Tests only. */
export function clearLiveRunBindings(): void {
  bindings.clear()
}
