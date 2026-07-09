import { useFleetStore } from '@/stores/fleet'
import { useChatStore } from '@/stores/chat'
import { useBooZeroStore, identifyBooZero } from '@/stores/booZero'
import { archiveAgentRecord } from '@clawboo/control-client'

export async function deleteAgentOperation(
  agentId: string,
  sessionKey: string | null,
): Promise<void> {
  // 1. Archive upstream (Gateway delete) + clean the SQLite row + FK children in
  //    one server call (DELETE /api/agents/:id via the AgentSource). When the
  //    Gateway is down the server falls back to a SQLite-only cleanup.
  await archiveAgentRecord(agentId)

  // 2. Remove from fleet store
  useFleetStore.getState().removeAgent(agentId)

  // 3. Re-identify Boo Zero in case the deleted agent was Boo Zero
  const remainingAgents = useFleetStore.getState().agents
  useBooZeroStore.getState().setBooZeroAgentId(identifyBooZero(remainingAgents))

  // 4. Clear transcript + SQLite history (if session key exists)
  if (sessionKey) {
    useChatStore.getState().clearTranscript(sessionKey)
    fetch(`/api/chat-history?sessionKey=${encodeURIComponent(sessionKey)}`, {
      method: 'DELETE',
    }).catch(() => {})
  }
}
