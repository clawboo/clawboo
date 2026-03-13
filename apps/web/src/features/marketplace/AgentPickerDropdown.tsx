import { useEffect, useRef } from 'react'
import { useFleetStore } from '@/stores/fleet'

interface AgentPickerDropdownProps {
  onSelect: (agentId: string, agentName: string) => void
  onClose: () => void
  /** Extra inline styles for positioning (merged onto the root div). */
  style?: React.CSSProperties
}

export function AgentPickerDropdown({ onSelect, onClose, style }: AgentPickerDropdownProps) {
  const agents = useFleetStore((s) => s.agents)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleMouseDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as globalThis.Node)) {
        onClose()
      }
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', handleMouseDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handleMouseDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [onClose])

  return (
    <div
      ref={ref}
      style={{
        position: 'absolute',
        zIndex: 50,
        background: '#111827',
        border: '1px solid rgba(255,255,255,0.1)',
        borderRadius: 8,
        padding: '4px 0',
        minWidth: 140,
        boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
        ...style,
      }}
    >
      {agents.length === 0 ? (
        <div style={{ padding: '6px 12px', fontSize: 11, color: 'rgba(232,232,232,0.4)' }}>
          No agents
        </div>
      ) : (
        agents.map((agent) => (
          <button
            key={agent.id}
            onClick={() => {
              onSelect(agent.id, agent.name)
              onClose()
            }}
            style={{
              display: 'block',
              width: '100%',
              padding: '6px 12px',
              background: 'transparent',
              border: 'none',
              color: '#E8E8E8',
              fontSize: 12,
              cursor: 'pointer',
              textAlign: 'left',
              whiteSpace: 'nowrap',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'rgba(255,255,255,0.05)'
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'transparent'
            }}
          >
            {agent.name}
          </button>
        ))
      )}
    </div>
  )
}
