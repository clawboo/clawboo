import { useEffect, useRef } from 'react'
import { motion } from 'framer-motion'
import {
  Eye,
  FileText,
  MessageSquare,
  SlidersHorizontal,
  Trash2,
  type LucideIcon,
} from 'lucide-react'

interface GraphContextMenuProps {
  x: number
  y: number
  agentId: string
  agentName: string
  onClose: () => void
  onChat: () => void
  onEditPersonality: () => void
  onEditFiles: () => void
  // Highlight the agent in the sidebar without opening the agent detail
  // view. Replaces the previous left-click behaviour, which now toggles
  // the boo's orbital children visibility (peacock-feather expand).
  onSelectInSidebar: () => void
  onDelete: () => void
}

interface MenuItemConfig {
  label: string
  icon: LucideIcon
  action: 'chat' | 'editPersonality' | 'editFiles' | 'selectInSidebar' | 'delete'
}

// Phase 20 audit follow-up — emoji glyphs replaced with Lucide icons to
// match TeamContextMenu / sidebar nav. The pattern is now consistent
// across every menu surface in the app.
const items: MenuItemConfig[] = [
  { label: 'Chat', icon: MessageSquare, action: 'chat' },
  { label: 'Edit personality', icon: SlidersHorizontal, action: 'editPersonality' },
  { label: 'Edit files', icon: FileText, action: 'editFiles' },
  { label: 'Select in sidebar', icon: Eye, action: 'selectInSidebar' },
  { label: 'Delete', icon: Trash2, action: 'delete' },
]

export function GraphContextMenu({
  x,
  y,
  onClose,
  onChat,
  onEditPersonality,
  onEditFiles,
  onSelectInSidebar,
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

  const handlers: Record<MenuItemConfig['action'], () => void> = {
    chat: onChat,
    editPersonality: onEditPersonality,
    editFiles: onEditFiles,
    selectInSidebar: onSelectInSidebar,
    delete: onDelete,
  }

  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.12, ease: 'easeOut' }}
      className="surface-floating-tier fixed z-[100] min-w-[180px] overflow-hidden rounded-[10px] py-1"
      style={{ left: x, top: y }}
    >
      {items.map((item, index) => {
        const Icon = item.icon
        const isDestructive = item.action === 'delete'
        const showDivider = isDestructive && index > 0
        return (
          <div key={item.action}>
            {showDivider && <div className="my-1 mx-3.5 border-t border-foreground/[0.06]" />}
            <button
              type="button"
              onClick={() => handlers[item.action]()}
              className={`flex w-full items-center gap-2.5 px-3.5 py-2 text-left text-[13px] transition-colors duration-150 hover:bg-foreground/[0.05] ${
                isDestructive ? 'text-primary' : 'text-foreground'
              }`}
            >
              <Icon size={14} strokeWidth={1.75} aria-hidden />
              <span>{item.label}</span>
            </button>
          </div>
        )
      })}
    </motion.div>
  )
}
