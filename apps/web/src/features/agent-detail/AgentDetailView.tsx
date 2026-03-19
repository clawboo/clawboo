import { Group, Panel } from 'react-resizable-panels'
import { useFleetStore } from '@/stores/fleet'
import { ChatPanel } from '@/features/chat/ChatPanel'
import { ResizeHandle } from '@/features/shared/ResizeHandle'
import { MiniGraph } from './MiniGraph'
import { InlineEditor } from './InlineEditor'

// ─── AgentDetailView ─────────────────────────────────────────────────────────
//
// 3-panel resizable layout:
// ┌─────────────────────┬──────────────────────────┐
// │                     │      MiniGraph (55%)      │
// │   ChatPanel (45%)   ├──────────────────────────┤
// │                     │    InlineEditor (45%)     │
// └─────────────────────┴──────────────────────────┘

export function AgentDetailView({ agentId }: { agentId: string }) {
  const agent = useFleetStore((s) => s.agents.find((a) => a.id === agentId) ?? null)

  if (!agent) {
    return (
      <div
        style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'rgba(232,232,232,0.4)',
          fontSize: 13,
          fontFamily: 'var(--font-body)',
        }}
      >
        Agent not found
      </div>
    )
  }

  return (
    <Group orientation="horizontal" id="agent-detail-h">
      {/* Left: Chat */}
      <Panel defaultSize={45} minSize={25}>
        <ChatPanel agentId={agentId} />
      </Panel>

      <ResizeHandle direction="horizontal" />

      {/* Right: MiniGraph + InlineEditor */}
      <Panel defaultSize={55} minSize={25}>
        <Group orientation="vertical" id="agent-detail-v">
          {/* Top: MiniGraph */}
          <Panel defaultSize={55} minSize={15}>
            <MiniGraph agentId={agentId} />
          </Panel>

          <ResizeHandle direction="vertical" />

          {/* Bottom: InlineEditor */}
          <Panel defaultSize={45} minSize={15}>
            <InlineEditor agentId={agentId} agentName={agent.name} />
          </Panel>
        </Group>
      </Panel>
    </Group>
  )
}
