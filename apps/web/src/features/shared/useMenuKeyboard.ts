// The WAI-ARIA APG menu keyboard contract, shared by the app's two context
// menus (graph nodes, teams). Both were mouse-only: no roles, no focus move on
// open, no arrow navigation, and no way back to the element that opened them.
//
// Roving tabindex rather than five tab stops: exactly one item sits in the tab
// order, so Tab LEAVES the menu (and dismisses it, per the APG) instead of
// walking through every entry.
//
// Items stay native `<button role="menuitem">`, so Enter / Space activation and
// the click handler come for free — this hook only owns arrow / Home / End /
// Tab, plus focus entry and restore.

import { useCallback, useEffect, useRef, useState } from 'react'

export interface MenuItemProps {
  ref: (el: HTMLButtonElement | null) => void
  tabIndex: number
  onFocus: () => void
}

export interface MenuKeyboard {
  /** Spread onto each `role="menuitem"` button, by index. */
  itemProps: (index: number) => MenuItemProps
  /** Attach to the `role="menu"` container. */
  menuKeyDown: (e: React.KeyboardEvent<HTMLElement>) => void
  /** The item index currently holding the roving tabindex. */
  activeIndex: number
}

export function useMenuKeyboard(count: number, onClose: () => void): MenuKeyboard {
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])
  const [activeIndex, setActiveIndex] = useState(0)
  const openerRef = useRef<HTMLElement | null>(null)

  // Focus into the menu on open, and back to the opener on close — otherwise a
  // keyboard user who opens the menu and presses Escape is dumped at the top of
  // the document with the whole graph to re-traverse.
  useEffect(() => {
    openerRef.current = document.activeElement as HTMLElement | null
    itemRefs.current[0]?.focus()
    return () => {
      const opener = openerRef.current
      if (!opener?.isConnected) return
      // An action may have deliberately moved focus (opened the agent view, a
      // confirm dialog…). Only reclaim focus when the unmount left it on <body>.
      if (document.activeElement && document.activeElement !== document.body) return
      opener.focus()
    }
  }, [])

  const itemProps = useCallback(
    (index: number): MenuItemProps => ({
      ref: (el) => {
        itemRefs.current[index] = el
      },
      tabIndex: index === activeIndex ? 0 : -1,
      onFocus: () => setActiveIndex(index),
    }),
    [activeIndex],
  )

  const menuKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLElement>) => {
      const last = count - 1
      let next: number
      switch (e.key) {
        case 'ArrowDown':
          next = activeIndex >= last ? 0 : activeIndex + 1
          break
        case 'ArrowUp':
          next = activeIndex <= 0 ? last : activeIndex - 1
          break
        case 'Home':
          next = 0
          break
        case 'End':
          next = last
          break
        case 'Tab':
          // APG: Tab dismisses the menu and lets focus continue past the opener.
          onClose()
          return
        default:
          return
      }
      e.preventDefault()
      e.stopPropagation()
      setActiveIndex(next)
      itemRefs.current[next]?.focus()
    },
    [activeIndex, count, onClose],
  )

  return { itemProps, menuKeyDown, activeIndex }
}
