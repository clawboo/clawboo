// Saving a model picked on a Hermes agent's page. The fleet store shows the pick
// at once and is put back if the save fails, so the page never shows a model or
// provider the agent does not have.

import { setAgentModel } from '@clawboo/control-client'

import { hermesModelSave } from '@/lib/hermesModelCatalog'
import { useFleetStore, type AgentState } from '@/stores/fleet'

/** Resolves `false` when the save failed (the store is restored), else `true`. */
export async function saveHermesModelPick(
  agent: Pick<AgentState, 'id' | 'model' | 'execConfig'>,
  model: string | null,
  fromGroup: boolean,
): Promise<boolean> {
  const save = model ? hermesModelSave(model, fromGroup) : null
  if (!save) return true
  const before = { model: agent.model, execConfig: agent.execConfig }
  const fleet = useFleetStore.getState()
  // The store holds the stored form: the bare model and, for a group pick, its provider.
  fleet.updateAgentModel(agent.id, save.model)
  if (save.provider) {
    fleet.updateExecConfig(agent.id, {
      ...(agent.execConfig ?? {}),
      provider: save.provider,
      model: save.model,
    } as unknown as AgentState['execConfig'])
  }
  try {
    await setAgentModel(agent.id, save.model, save.provider)
    return true
  } catch {
    const now = useFleetStore.getState()
    now.updateAgentModel(agent.id, before.model)
    now.updateExecConfig(agent.id, before.execConfig)
    return false
  }
}
