import { useEffect, useRef } from 'react'
import { motion } from 'framer-motion'
import { Archive, RotateCw, Trash2, Upload, type LucideIcon } from 'lucide-react'

import { useMenuKeyboard, type MenuItemProps } from '@/features/shared/useMenuKeyboard'
import { useDismissableLayer } from '@/features/shared/useDismissableLayer'

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

interface MenuEntryProps {
  icon: LucideIcon
  label: string
  onClick: () => void
  /** When true, label + icon render in the destructive (primary-red) tone. */
  destructive?: boolean
  /** Roving-tabindex wiring from `useMenuKeyboard`. */
  item: MenuItemProps
}

function MenuItem({ icon: Icon, label, onClick, destructive, item }: MenuEntryProps) {
  return (
    <button
      type="button"
      role="menuitem"
      {...item}
      onClick={onClick}
      // The menu is `overflow-hidden`, which would clip a positive
      // outline-offset, so the ring is inset and paired with a row highlight.
      className={`flex w-full cursor-pointer items-center gap-2.5 px-3.5 py-2 text-left text-[13px] transition-colors duration-150 hover:bg-foreground/[0.06] focus-visible:bg-foreground/[0.08] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--primary)] ${
        destructive ? 'text-destructive' : 'text-foreground'
      }`}
    >
      <Icon size={14} strokeWidth={2} aria-hidden />
      <span>{label}</span>
    </button>
  )
}

const ITEM_COUNT = 4

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
  const { itemProps, menuKeyDown } = useMenuKeyboard(ITEM_COUNT, onClose)

  // Escape and outside-press are arbitrated by the shared layer stack: only the
  // topmost open layer reacts, so this dismisses alone.
  useDismissableLayer({ active: true, level: 'popover', onEscape: onClose })

  useEffect(() => {
    function handleMouseDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose()
      }
    }
    document.addEventListener('mousedown', handleMouseDown)
    return () => {
      document.removeEventListener('mousedown', handleMouseDown)
    }
  }, [onClose])

  return (
    <motion.div
      ref={ref}
      role="menu"
      aria-label={`Actions for ${teamName}`}
      onKeyDown={menuKeyDown}
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.12, ease: 'easeOut' }}
      className="fixed z-[100] min-w-[180px] overflow-hidden rounded-xl border border-border bg-popover py-1.5"
      style={{ left: x, top: y, boxShadow: 'var(--shadow-floating)' }}
    >
      {/* Team name header — mono uppercase microlabel matches the rest of the
          app's section-header rhythm. `role="none"`, because a role=menu may only
          contain menuitem / group / presentation children; the name itself
          already reaches assistive tech through the menu's aria-label. */}
      <div
        role="none"
        className="border-b border-border px-3.5 pb-1.5 pt-1.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground"
      >
        {teamName}
      </div>

      <div role="none" className="py-0.5">
        <MenuItem
          icon={isArchived ? Upload : Archive}
          label={isArchived ? 'Unarchive' : 'Archive'}
          onClick={onArchive}
          item={itemProps(0)}
        />
        <MenuItem
          icon={RotateCw}
          label="Refresh Protocol"
          onClick={onRefreshProtocol}
          item={itemProps(1)}
        />
        <div role="none" className="my-1 mx-3.5 border-t border-border" />
        <MenuItem
          icon={Trash2}
          label="Delete team only"
          onClick={onDelete}
          destructive
          item={itemProps(2)}
        />
        <MenuItem
          icon={Trash2}
          label="Delete with agents"
          onClick={onDeleteWithAgents}
          destructive
          item={itemProps(3)}
        />
      </div>
    </motion.div>
  )
}
