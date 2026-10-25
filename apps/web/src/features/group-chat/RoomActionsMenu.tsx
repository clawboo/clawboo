// The "..." menu on a room row in the sidebar: pin, rename, clear chat, delete.
// On General (the team's own chat, which can't be renamed or deleted) it only
// clears the chat.
//
// Portalled to the body with fixed positioning, because the sidebar column
// clips its contents (it is resizable and fades when narrow).

import { useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Eraser, Pencil, Pin, PinOff, Trash2, type LucideIcon } from 'lucide-react'

import { useMenuKeyboard, type MenuItemProps } from '@/features/shared/useMenuKeyboard'
import { useDismissableLayer } from '@/features/shared/useDismissableLayer'
import { archiveRoom, updateRoom, type Room } from '@/lib/roomsClient'
import { clearServerTeamChat } from './serverTeamChatSend'
import { confirm } from '@/stores/confirm'
import { useRoomStore } from '@/stores/rooms'
import { useToastStore } from '@/stores/toast'
import { useViewStore } from '@/stores/view'

const MENU_WIDTH = 176
const GAP = 4
const EDGE = 8

function MenuItem({
  icon: Icon,
  label,
  onClick,
  destructive,
  item,
}: {
  icon: LucideIcon
  label: string
  onClick: () => void
  destructive?: boolean
  item: MenuItemProps
}) {
  return (
    <button
      type="button"
      role="menuitem"
      {...item}
      onClick={onClick}
      className={`flex w-full cursor-pointer items-center gap-2.5 px-3.5 py-2 text-left text-[13px] transition-colors duration-150 hover:bg-foreground/[0.06] focus-visible:bg-foreground/[0.08] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--primary)] ${
        destructive ? 'text-destructive' : 'text-foreground'
      }`}
    >
      <Icon size={14} strokeWidth={2} aria-hidden />
      <span>{label}</span>
    </button>
  )
}

export function RoomActionsMenu({
  room,
  anchor,
  onClose,
  onRename,
  general = false,
}: {
  room: Room
  /** The "..." button's rect: the menu opens below it, right-aligned. */
  anchor: DOMRect
  onClose: () => void
  onRename: () => void
  /** The General room: the only action is Clear chat. */
  general?: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  const { itemProps, menuKeyDown } = useMenuKeyboard(general ? 1 : 4, onClose)
  const pinned = room.pinnedAt != null

  useDismissableLayer({
    active: true,
    level: 'popover',
    onEscape: onClose,
    contains: (t) => !!ref.current?.contains(t),
    onPressOutside: onClose,
  })

  // Below the button, or above it when there is no room underneath.
  const [top, setTop] = useState(anchor.bottom + GAP)
  useLayoutEffect(() => {
    const h = ref.current?.offsetHeight ?? 0
    if (anchor.bottom + GAP + h > window.innerHeight - EDGE) {
      setTop(Math.max(EDGE, anchor.top - GAP - h))
    }
  }, [anchor])
  const left = Math.min(
    Math.max(EDGE, anchor.right - MENU_WIDTH),
    window.innerWidth - MENU_WIDTH - EDGE,
  )

  const togglePin = async () => {
    onClose()
    const result = await updateRoom(room.teamId, room.id, { pinned: !pinned })
    if (result.ok) useRoomStore.getState().upsert(result.room)
    else useToastStore.getState().addToast({ type: 'error', message: result.error })
  }

  const remove = async () => {
    onClose()
    const ok = await confirm({
      title: `Delete ${room.name}?`,
      message:
        'The conversation is kept, but the room leaves the sidebar and anything it is working on stops. Its tasks stay on the board.',
      confirmLabel: 'Delete room',
      tone: 'danger',
    })
    if (!ok) return
    if (!(await archiveRoom(room.teamId, room.id))) {
      useToastStore.getState().addToast({
        type: 'error',
        message: 'Could not delete the room. Try again?',
      })
      return
    }
    useRoomStore.getState().remove(room.teamId, room.id)
    const view = useViewStore.getState().viewMode
    if (view.type === 'groupChat' && view.roomId === room.id) {
      useViewStore.getState().openGroupChat(room.teamId)
    }
    useToastStore.getState().addToast({ type: 'success', message: `${room.name} deleted.` })
  }

  const clearChat = async () => {
    onClose()
    const ok = await confirm({
      title: `Clear ${room.name}?`,
      message:
        'Its messages leave the chat, and the agents start this conversation fresh. Tasks stay on the board, and other chats are not touched.',
      confirmLabel: 'Clear chat',
      tone: 'danger',
    })
    if (!ok) return
    if (!(await clearServerTeamChat(room))) {
      useToastStore.getState().addToast({
        type: 'error',
        message: 'Could not clear the chat. Try again?',
      })
      return
    }
    useToastStore.getState().addToast({ type: 'success', message: `${room.name} cleared.` })
  }

  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label={`Actions for ${room.name}`}
      onKeyDown={menuKeyDown}
      data-testid="room-actions-menu"
      className="fixed z-[100] overflow-hidden rounded-xl border border-border bg-popover py-1.5"
      style={{ top, left, width: MENU_WIDTH, boxShadow: 'var(--shadow-floating)' }}
    >
      {general ? (
        <MenuItem
          icon={Eraser}
          label="Clear chat"
          onClick={() => void clearChat()}
          item={itemProps(0)}
        />
      ) : (
        <>
          <MenuItem
            icon={pinned ? PinOff : Pin}
            label={pinned ? 'Unpin' : 'Pin'}
            onClick={() => void togglePin()}
            item={itemProps(0)}
          />
          <MenuItem
            icon={Pencil}
            label="Rename"
            onClick={() => {
              onClose()
              onRename()
            }}
            item={itemProps(1)}
          />
          <MenuItem
            icon={Eraser}
            label="Clear chat"
            onClick={() => void clearChat()}
            item={itemProps(2)}
          />
          <div role="none" className="mx-3.5 my-1 border-t border-border" />
          <MenuItem
            icon={Trash2}
            label="Delete"
            onClick={() => void remove()}
            destructive
            item={itemProps(3)}
          />
        </>
      )}
    </div>,
    document.body,
  )
}
