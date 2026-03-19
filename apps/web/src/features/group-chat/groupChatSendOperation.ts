// Group chat send operation — routes messages to the correct team agent.

import type { GatewayClientLike } from '@clawboo/gateway-client'
import type { AgentState } from '@/stores/fleet'
import { sendChatMessage } from '@/features/chat/chatSendOperation'
import { parseMention } from './parseMention'

export interface GroupChatSendParams {
  client: GatewayClientLike
  teamId: string
  leaderAgentId: string | null
  teamAgents: AgentState[]
  message: string
}

export async function sendGroupChatMessage(params: GroupChatSendParams): Promise<void> {
  const { client, leaderAgentId, teamAgents, message } = params

  // Parse @mention to determine target agent
  const { targetAgentId: mentionedId, cleanedMessage } = parseMention(
    message,
    teamAgents.map((a) => ({ id: a.id, name: a.name })),
  )

  // Resolve target: @mentioned > leader > first team agent
  const targetId = mentionedId ?? leaderAgentId ?? teamAgents[0]?.id
  if (!targetId) return

  const target = teamAgents.find((a) => a.id === targetId)
  if (!target?.sessionKey) return

  await sendChatMessage({
    client,
    agentId: target.id,
    sessionKey: target.sessionKey,
    message: mentionedId ? cleanedMessage : message,
  })
}
