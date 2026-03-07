import { useConnectionStore } from '@/stores/connection'
import { useFleetStore } from '@/stores/fleet'
import { useToastStore } from '@/stores/toast'
import { mutationQueue } from '@/lib/mutationQueue'
import { useGraphStore } from '../store'

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export async function removeRouting(
  edgeId: string,
  sourceAgentId: string,
  targetAgentId: string,
): Promise<void> {
  const client = useConnectionStore.getState().client
  if (!client) return

  const agents = useFleetStore.getState().agents
  const targetAgent = agents.find((a) => a.id === targetAgentId)
  const sourceAgent = agents.find((a) => a.id === sourceAgentId)
  if (!targetAgent || !sourceAgent) return

  const targetName = targetAgent.name

  // Optimistically remove edge from graph
  const store = useGraphStore.getState()
  const prevEdges = store.edges
  store.setEdges(prevEdges.filter((e) => e.id !== edgeId))

  try {
    const currentAgentsMd = await client.agents.files
      .read(sourceAgentId, 'AGENTS.md')
      .catch(() => null)

    if (!currentAgentsMd) {
      useToastStore.getState().addToast({
        message: `Routing removed: ${sourceAgent.name} \u2192 ${targetName}`,
        type: 'success',
      })
      return
    }

    // Remove all lines that mention @targetName
    const lines = currentAgentsMd.split('\n')
    const mentionRe = new RegExp(`@["']?${escapeRe(targetName)}["']?`, 'i')
    const filtered = lines.filter((line) => !mentionRe.test(line))
    const newAgentsMd = filtered.join('\n')

    await mutationQueue.enqueue(sourceAgentId, () =>
      client.agents.files.set(sourceAgentId, 'AGENTS.md', newAgentsMd),
    )

    // Update local agentFiles cache (no triggerRefresh — matches onConnect pattern)
    useGraphStore.getState().setAgentFiles(sourceAgentId, { agentsMd: newAgentsMd })

    useToastStore.getState().addToast({
      message: `Routing removed: ${sourceAgent.name} \u2192 ${targetName}`,
      type: 'success',
    })
  } catch (_err) {
    // Rollback: restore edges
    useGraphStore.getState().setEdges(prevEdges)
    useToastStore.getState().addToast({
      message: 'Failed to remove routing',
      type: 'error',
    })
  }
}
