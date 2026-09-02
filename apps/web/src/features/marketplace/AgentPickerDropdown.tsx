import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useFleetStore } from '@/stores/fleet'
import { useDismissableLayer } from '@/features/shared/useDismissableLayer'

interface AgentPickerDropdownProps {
  onSelect: (agentId: string, agentName: string) => void
  onClose: () => void
  /** Extra inline styles for positioning (merged onto the root div). */
  style?: React.CSSProperties
  /**
   * Anchor to hang the menu off, which also switches it into a body portal.
   *
   * WHY THE PORTAL IS NOT OPTIONAL FOR CARDS. A card that carries a CSS
   * `transform` establishes its own stacking context, and `z-index` cannot
   * escape one. The marketplace skill cards animate with `hover:-translate-y-px`,
   * so every card is its own context and the menu rendered inside one paints
   * UNDER every card that comes later in DOM order, no matter how high its
   * z-index goes. Worse, the menu then sat beneath the card below it, so moving
   * the pointer toward an agent crossed that card, retriggered its hover
   * transform, and the 1px shift read as a flicker.
   *
   * Portalling to `document.body` leaves every one of those contexts behind.
   * Callers that live inside an already-transformed surface, such as a React
   * Flow node whose canvas is scaled and translated, must NOT pass this: fixed
   * coordinates would be measured against a viewport the node does not share.
   * Those keep the absolute path by passing `style` alone.
   */
  anchorRef?: React.RefObject<HTMLElement | null>
}

export function AgentPickerDropdown({
  onSelect,
  onClose,
  style,
  anchorRef,
}: AgentPickerDropdownProps) {
  const agents = useFleetStore((s) => s.agents)
  const ref = useRef<HTMLDivElement>(null)
  const [anchored, setAnchored] = useState<React.CSSProperties | null>(null)

  // Measured before paint so the menu never shows at 0,0 for a frame. Right
  // edges are aligned so a menu wider than its trigger opens inward, and the
  // top flips above the anchor when there is not room below.
  useLayoutEffect(() => {
    if (!anchorRef) return
    const place = () => {
      const el = anchorRef.current
      if (!el) return
      const r = el.getBoundingClientRect()
      const menuH = ref.current?.offsetHeight ?? 0
      const below = window.innerHeight - r.bottom
      const flip = menuH > 0 && below < menuH + 8 && r.top > below
      setAnchored({
        position: 'fixed',
        right: Math.max(8, window.innerWidth - r.right),
        ...(flip ? { bottom: window.innerHeight - r.top + 4 } : { top: r.bottom + 4 }),
        maxHeight: Math.max(120, (flip ? r.top : below) - 12),
        overflowY: 'auto',
      })
    }
    place()
    // Any scroll in any ancestor moves the anchor, and a fixed menu would not
    // follow it. Capture phase catches scrolls on inner containers too.
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => {
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [anchorRef])

  // Escape and outside-press are arbitrated by the shared layer stack: only the
  // topmost open layer reacts, so this dismisses alone.
  useDismissableLayer({ active: true, level: 'popover', onEscape: onClose })

  useEffect(() => {
    function handleMouseDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as globalThis.Node)) {
        onClose()
      }
    }
    document.addEventListener('mousedown', handleMouseDown)
    return () => {
      document.removeEventListener('mousedown', handleMouseDown)
    }
  }, [onClose])

  const menu = (
    <div
      ref={ref}
      className={
        anchorRef
          ? 'z-[70] min-w-[160px] overflow-hidden rounded-xl border border-border bg-popover py-1.5'
          : 'absolute z-50 min-w-[160px] overflow-hidden rounded-xl border border-border bg-popover py-1.5'
      }
      style={
        anchorRef
          ? {
              ...anchored,
              boxShadow: 'var(--shadow-floating)',
              visibility: anchored ? 'visible' : 'hidden',
            }
          : { ...style, boxShadow: 'var(--shadow-floating)' }
      }
    >
      {agents.length === 0 ? (
        <div className="px-3.5 py-2 text-[12px] text-foreground/50">No agents</div>
      ) : (
        agents.map((agent) => (
          <button
            type="button"
            key={agent.id}
            onClick={() => {
              onSelect(agent.id, agent.name)
              onClose()
            }}
            className="block w-full cursor-pointer whitespace-nowrap px-3.5 py-2 text-left text-[13px] text-foreground transition-colors duration-150 hover:bg-foreground/[0.06]"
          >
            {agent.name}
          </button>
        ))
      )}
    </div>
  )

  return anchorRef ? createPortal(menu, document.body) : menu
}
