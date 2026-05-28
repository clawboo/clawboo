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
      className="surface-floating-tier absolute z-50 min-w-[160px] overflow-hidden rounded-[10px] py-1"
      style={style}
    >
      {agents.length === 0 ? (
        <div className="px-3 py-2 text-[11px] text-foreground/55">No agents</div>
      ) : (
        agents.map((agent) => (
          <button
            type="button"
            key={agent.id}
            onClick={() => {
              onSelect(agent.id, agent.name)
              onClose()
            }}
            className="block w-full whitespace-nowrap px-3 py-1.5 text-left text-[12px] text-foreground transition-colors duration-150 hover:bg-foreground/[0.05]"
          >
            {agent.name}
          </button>
        ))
      )}
    </div>
  )
}
