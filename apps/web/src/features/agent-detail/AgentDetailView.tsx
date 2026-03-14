import { useRef, useCallback } from 'react'
import { Group, Panel, Separator } from 'react-resizable-panels'
import { useFleetStore } from '@/stores/fleet'
import { ChatPanel } from '@/features/chat/ChatPanel'
import { MiniGraph } from './MiniGraph'
import { InlineEditor } from './InlineEditor'

// ─── Resize handle ───────────────────────────────────────────────────────────

function ResizeHandle({ direction }: { direction: 'horizontal' | 'vertical' }) {
  const isHorizontal = direction === 'horizontal'
  const ref = useRef<HTMLDivElement>(null)

  const onMouseEnter = useCallback(() => {
    if (ref.current) ref.current.style.background = 'rgba(233,69,96,0.4)'
  }, [])

  const onMouseLeave = useCallback(() => {
    if (ref.current) ref.current.style.background = 'transparent'
  }, [])

  return (
    <Separator
      className="resize-handle"
      elementRef={ref}
      style={{
        width: isHorizontal ? 3 : '100%',
        height: isHorizontal ? '100%' : 3,
        background: 'transparent',
        position: 'relative',
        flexShrink: 0,
        cursor: isHorizontal ? 'col-resize' : 'row-resize',
        transition: 'background 0.15s',
      }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <div
        style={{
          position: 'absolute',
          [isHorizontal ? 'left' : 'top']: 1,
          [isHorizontal ? 'top' : 'left']: 0,
          [isHorizontal ? 'bottom' : 'right']: 0,
          [isHorizontal ? 'width' : 'height']: 1,
          background: 'rgba(255,255,255,0.06)',
        }}
      />
    </Separator>
  )
}

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
