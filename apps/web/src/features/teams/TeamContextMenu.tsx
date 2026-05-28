import { useEffect, useRef } from 'react'
import { motion } from 'framer-motion'
import { Archive, RotateCw, Trash2, Upload, type LucideIcon } from 'lucide-react'

interface TeamContextMenuProps {
  x: number
  y: number
  teamName: string
  isArchived: boolean
  onClose: () => void
  onArchive: () => void
  onRefreshProtocol: () => void
  onDelete: () => void
  onDeleteWithAgents: () => void
}

interface MenuItemProps {
  icon: LucideIcon
  label: string
  onClick: () => void
  /** When true, label + icon render in the destructive (primary-red) tone. */
  destructive?: boolean
}

function MenuItem({ icon: Icon, label, onClick, destructive }: MenuItemProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-2.5 px-3.5 py-2 text-left text-[13px] transition-colors duration-150 hover:bg-foreground/[0.05] ${
        destructive ? 'text-primary' : 'text-foreground'
      }`}
    >
      <Icon size={14} strokeWidth={1.75} aria-hidden />
      <span>{label}</span>
    </button>
  )
}

export function TeamContextMenu({
  x,
  y,
  teamName,
  isArchived,
  onClose,
  onArchive,
  onRefreshProtocol,
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
      transition={{ duration: 0.12, ease: 'easeOut' }}
      className="surface-floating-tier fixed z-[100] min-w-[180px] overflow-hidden rounded-[10px] py-1"
      style={{ left: x, top: y }}
    >
      {/* Team name header — mono uppercase microlabel matches the rest of the
          app's section-header rhythm. */}
      <div className="border-b border-foreground/[0.06] px-3.5 pb-1.5 pt-1.5 font-mono text-[10px] uppercase tracking-wider text-foreground/40">
        {teamName}
      </div>

      <div className="py-0.5">
        <MenuItem
          icon={isArchived ? Upload : Archive}
          label={isArchived ? 'Unarchive' : 'Archive'}
          onClick={onArchive}
        />
        <MenuItem icon={RotateCw} label="Refresh Protocol" onClick={onRefreshProtocol} />
        <div className="my-1 mx-3.5 border-t border-foreground/[0.06]" />
        <MenuItem icon={Trash2} label="Delete team only" onClick={onDelete} destructive />
        <MenuItem
          icon={Trash2}
          label="Delete with agents"
          onClick={onDeleteWithAgents}
          destructive
        />
      </div>
    </motion.div>
  )
}
