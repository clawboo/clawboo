import type { GatewayClientLike } from '@clawboo/gateway-client'
import { useFleetStore } from '@/stores/fleet'
import { useChatStore } from '@/stores/chat'
import { useBooZeroStore, identifyBooZero } from '@/stores/booZero'

export async function deleteAgentOperation(
  agentId: string,
  sessionKey: string | null,
  client: GatewayClientLike,
): Promise<void> {
  // 1. Gateway delete
  await client.call('agents.delete', { agentId })

  // 2. Remove from fleet store
  useFleetStore.getState().removeAgent(agentId)

  // 3. Re-identify Boo Zero in case the deleted agent was Boo Zero
  const remainingAgents = useFleetStore.getState().agents
  useBooZeroStore.getState().setBooZeroAgentId(identifyBooZero(remainingAgents))

  // 4. Clear transcript + SQLite history (if session key exists)
  if (sessionKey) {
    useChatStore.getState().clearTranscript(sessionKey)

    // Best-effort, non-blocking
    fetch(`/api/chat-history?sessionKey=${encodeURIComponent(sessionKey)}`, {
      method: 'DELETE',
    }).catch(() => {})
  }

  // 5. Clean up the local SQLite agent row + FK-referenced rows. Without
  //    this the row lingers forever, inflating per-team `agentCount` in
  //    `/api/teams` responses and polluting any future logic that reads
  //    from the local DB. Best-effort, non-blocking — if the request fails
  //    the worst case is one extra ghost row that the one-shot
  //    `cleanup-ghosts` will sweep on the next bootstrap.
  fetch(`/api/agents/${encodeURIComponent(agentId)}`, { method: 'DELETE' }).catch(() => {})
}
