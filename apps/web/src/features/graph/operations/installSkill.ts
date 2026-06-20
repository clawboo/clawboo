import { installCapability } from '@/lib/capabilitiesClient'
import { useToastStore } from '@/stores/toast'
import { useGraphStore } from '../store'

// Install a curated skill onto an agent through the unified capability pipeline
// (POST /api/capabilities/install → the native managed source's tool-broker-audited
// write into the skills table). Supersedes the legacy markdown skill-file write.
export async function installSkillForAgent(
  skillName: string,
  agentId: string,
  agentName: string,
): Promise<void> {
  // The `runtime` field is a placeholder — the server resolves the OWNING runtime
  // authoritatively from the agent row before the write, so the audit + the
  // returned record reflect the agent's actual runtime regardless of what we send
  // here (the fleet AgentState carries no runtime field).
  const result = await installCapability({
    via: 'native',
    agentId,
    runtime: 'openclaw',
    kind: 'skill',
    name: skillName,
  })

  if (!result.ok) {
    useToastStore.getState().addToast({
      message: `Failed to install skill: ${result.error ?? 'unknown'}`,
      type: 'error',
    })
    return
  }

  useGraphStore.getState().triggerRefresh()
  useToastStore.getState().addToast({
    message: `Installed "${skillName}" on ${agentName}`,
    type: 'success',
  })
}
