import { useConnectionStore } from '@/stores/connection'
import { useToastStore } from '@/stores/toast'
import { mutationQueue } from '@/lib/mutationQueue'
import { useGraphStore } from '../store'

export async function installSkillForAgent(skillName: string, agentId: string, agentName: string) {
  const client = useConnectionStore.getState().client
  if (!client) return

  try {
    const currentTools = await client.agents.files.read(agentId, 'TOOLS.md')

    if (currentTools.includes(skillName)) {
      useToastStore.getState().addToast({
        message: `${skillName} already installed on ${agentName}`,
        type: 'info',
      })
      return
    }

    const newTools = currentTools.trimEnd() + '\n- ' + skillName + '\n'
    await mutationQueue.enqueue(agentId, () =>
      client.agents.files.set(agentId, 'TOOLS.md', newTools),
    )

    useGraphStore.getState().triggerRefresh()

    useToastStore.getState().addToast({
      message: `Installed "${skillName}" on ${agentName}`,
      type: 'success',
    })
  } catch (err) {
    useToastStore.getState().addToast({
      message: `Failed to install skill: ${err instanceof Error ? err.message : 'unknown'}`,
      type: 'error',
    })
  }
}
