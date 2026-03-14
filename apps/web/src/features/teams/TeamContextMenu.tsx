import { useEffect, useRef } from 'react'
import { motion } from 'framer-motion'

interface TeamContextMenuProps {
  x: number
  y: number
  teamName: string
  isArchived: boolean
  onClose: () => void
  onArchive: () => void
  onDelete: () => void
  onDeleteWithAgents: () => void
}

export function TeamContextMenu({
  x,
  y,
  teamName,
  isArchived,
  onClose,
  onArchive,
  onDelete,
  onDeleteWithAgents,
}: TeamContextMenuProps) {
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
        minWidth: 160,
        boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
      }}
    >
      {/* Team name header */}
      <div
        style={{
          padding: '6px 14px 4px',
          fontSize: 11,
          color: 'rgba(232,232,232,0.4)',
          borderBottom: '1px solid rgba(255,255,255,0.06)',
          marginBottom: 4,
        }}
      >
        {teamName}
      </div>

      <button
        onClick={onArchive}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          width: '100%',
          padding: '8px 14px',
          background: 'transparent',
          border: 'none',
          color: '#E8E8E8',
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
        <span>{isArchived ? '📤' : '📦'}</span>
        <span>{isArchived ? 'Unarchive' : 'Archive'}</span>
      </button>

      <button
        onClick={onDelete}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          width: '100%',
          padding: '8px 14px',
          background: 'transparent',
          border: 'none',
          color: '#E94560',
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
        <span>🗑</span>
        <span>Delete team only</span>
      </button>

      <button
        onClick={onDeleteWithAgents}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          width: '100%',
          padding: '8px 14px',
          background: 'transparent',
          border: 'none',
          color: '#E94560',
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
        <span>🗑</span>
        <span>Delete with agents</span>
      </button>
    </motion.div>
  )
}
