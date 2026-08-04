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

import { useMenuKeyboard } from '@/features/shared/useMenuKeyboard'

interface GraphContextMenuProps {
  x: number
  y: number
  /** Names the menu for assistive tech ("Actions for Scout"). */
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

// Emoji glyphs replaced with Lucide icons to
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
  agentName,
  onClose,
  onChat,
  onEditPersonality,
  onEditFiles,
  onSelectInSidebar,
  onDelete,
}: GraphContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null)
  const { itemProps, menuKeyDown } = useMenuKeyboard(items.length, onClose)

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
      role="menu"
      aria-label={`Actions for ${agentName}`}
      onKeyDown={menuKeyDown}
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.12, ease: 'easeOut' }}
      className="fixed z-[100] min-w-[180px] overflow-hidden rounded-xl border border-border bg-popover py-1.5"
      style={{ left: x, top: y, boxShadow: 'var(--shadow-floating)' }}
    >
      {items.map((item, index) => {
        const Icon = item.icon
        const isDestructive = item.action === 'delete'
        const showDivider = isDestructive && index > 0
        return (
          // role="none" — a role=menu may only contain menuitem / group /
          // presentation children, so these layout wrappers must not break the
          // required parent-child relationship (axe: aria-required-children).
          <div key={item.action} role="none">
            {showDivider && <div role="none" className="my-1 mx-3.5 border-t border-border" />}
            <button
              type="button"
              role="menuitem"
              {...itemProps(index)}
              onClick={() => handlers[item.action]()}
              // The menu is `overflow-hidden`, which would clip a positive
              // outline-offset, so the ring is inset and paired with a row
              // highlight (the conventional menu focus treatment).
              className={`flex w-full cursor-pointer items-center gap-2.5 px-3.5 py-2 text-left text-[13px] transition-colors duration-150 hover:bg-foreground/[0.06] focus-visible:bg-foreground/[0.08] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--primary)] ${
                isDestructive ? 'text-destructive' : 'text-foreground'
              }`}
            >
              <Icon size={14} strokeWidth={2} aria-hidden />
              <span>{item.label}</span>
            </button>
          </div>
        )
      })}
    </motion.div>
  )
}
