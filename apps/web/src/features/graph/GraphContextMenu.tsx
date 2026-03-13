import { useEffect, useRef } from 'react'
import { motion } from 'framer-motion'

interface GraphContextMenuProps {
  x: number
  y: number
  agentId: string
  agentName: string
  onClose: () => void
  onChat: () => void
  onEditPersonality: () => void
  onEditFiles: () => void
  onDelete: () => void
}

const items = [
  { label: 'Chat', emoji: '\uD83D\uDCAC', action: 'chat' },
  { label: 'Edit personality', emoji: '\u2699\uFE0F', action: 'editPersonality' },
  { label: 'Edit files', emoji: '\uD83D\uDCDD', action: 'editFiles' },
  { label: 'Delete', emoji: '\uD83D\uDDD1', action: 'delete' },
] as const

export function GraphContextMenu({
  x,
  y,
  onClose,
  onChat,
  onEditPersonality,
  onEditFiles,
  onDelete,
}: GraphContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleMouseDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
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

  const handlers: Record<string, () => void> = {
    chat: onChat,
    editPersonality: onEditPersonality,
    editFiles: onEditFiles,
    delete: onDelete,
  }

  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.1 }}
      style={{
        position: 'fixed',
        left: x,
        top: y,
        zIndex: 100,
        background: '#111827',
        border: '1px solid rgba(255,255,255,0.1)',
        borderRadius: 8,
        padding: '4px 0',
        minWidth: 180,
        boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
      }}
    >
      {items.map((item) => (
        <button
          key={item.action}
          onClick={() => handlers[item.action]()}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            width: '100%',
            padding: '8px 14px',
            background: 'transparent',
            border: 'none',
            color: item.action === 'delete' ? '#E94560' : '#E8E8E8',
            fontSize: 13,
            cursor: 'pointer',
            textAlign: 'left',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'rgba(255,255,255,0.05)'
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'transparent'
          }}
        >
          <span>{item.emoji}</span>
          <span>{item.label}</span>
        </button>
      ))}
    </motion.div>
  )
}
