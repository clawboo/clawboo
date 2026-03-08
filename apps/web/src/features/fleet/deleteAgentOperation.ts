import type { GatewayClientLike } from '@clawboo/gateway-client'
import { useFleetStore } from '@/stores/fleet'
import { useChatStore } from '@/stores/chat'

export async function deleteAgentOperation(
  agentId: string,
  sessionKey: string | null,
  client: GatewayClientLike,
): Promise<void> {
  // 1. Gateway delete
  await client.call('agents.delete', { agentId })

  // 2. Remove from fleet store
  useFleetStore.getState().removeAgent(agentId)

  // 3. Clear transcript + SQLite history (if session key exists)
  if (sessionKey) {
    useChatStore.getState().clearTranscript(sessionKey)

    // Best-effort, non-blocking
    fetch(`/api/chat-history?sessionKey=${encodeURIComponent(sessionKey)}`, {
      method: 'DELETE',
    }).catch(() => {})
  }
}
