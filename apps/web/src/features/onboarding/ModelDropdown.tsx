/**
 * features/onboarding/ModelDropdown.tsx
 *
 * Full-width model picker for the onboarding "Set Up OpenClaw" step. Mirrors the
 * in-app model-selector chrome (`features/maintenance/ModelSelector`,
 * `features/agent-detail/AgentModelSelector`) — a pill trigger + a
 * `surface-floating-tier` popover with mint-accented, check-marked rows — instead
 * of a native `<select>`, so the onboarding dropdown looks identical to the ones
 * users meet later in the app. Single-level (the provider is already chosen by the
 * cards above), with outside-click / Escape close + arrow-key navigation.
 *
 * The popover is rendered through a portal to `document.body` with FIXED
 * positioning, anchored to the trigger's bounding rect. This is load-bearing: the
 * onboarding wizard wraps each step in a `fixed inset-0 … overflow-y-auto`
 * scroll container and the step card itself clips its rounded corners, so an
 * in-flow `position: absolute` menu got cut off the moment it extended past the
 * card / viewport (the model picker is the last field, near the bottom). The
 * portal escapes every ancestor's overflow; we additionally flip the menu ABOVE
 * the trigger when there isn't room below, and reposition on scroll / resize so
 * it stays glued to the field.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown } from 'lucide-react'

export interface ModelDropdownOption {
  id: string
  label: string
}

export interface ModelDropdownProps {
  value: string
  onChange: (id: string) => void
  options: ModelDropdownOption[]
  /** Index 0 is treated as the recommended default and tagged in the list. */
  disabled?: boolean
  'aria-label'?: string
}

interface MenuPosition {
  left: number
  width: number
  top?: number
  bottom?: number
  maxHeight: number
}

const MENU_DESIRED_HEIGHT = 264
const MENU_GAP = 6

export function ModelDropdown({
  value,
  onChange,
  options,
  disabled,
  'aria-label': ariaLabel,
}: ModelDropdownProps) {
  const [open, setOpen] = useState(false)
  const [focused, setFocused] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const [pos, setPos] = useState<MenuPosition | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  const selected = options.find((o) => o.id === value) ?? null
  const displayLabel = selected?.label ?? 'Select a model'

  // Anchor the fixed-position popover to the trigger; flip above only when the
  // menu's actual (estimated) height won't fit below. Estimating from the option
  // count means a short list opens downward when it fits, and only a long list
  // (capped at MENU_DESIRED_HEIGHT, scrollable) flips up near the step bottom.
  const computePosition = useCallback(() => {
    const el = triggerRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const spaceBelow = window.innerHeight - r.bottom
    const spaceAbove = r.top
    const estimatedHeight = Math.min(MENU_DESIRED_HEIGHT, options.length * 38 + 12)
    const openUp = spaceBelow < estimatedHeight + MENU_GAP + 8 && spaceAbove > spaceBelow
    const maxHeight = Math.max(
      120,
      Math.min(MENU_DESIRED_HEIGHT, (openUp ? spaceAbove : spaceBelow) - 12),
    )
    setPos({
      left: r.left,
      width: r.width,
      maxHeight,
      ...(openUp
        ? { bottom: window.innerHeight - r.top + MENU_GAP }
        : { top: r.bottom + MENU_GAP }),
    })
  }, [options.length])

  // Position synchronously before paint when opening to avoid a flash.
  useLayoutEffect(() => {
    if (open) computePosition()
  }, [open, computePosition])

  // Outside-click / Escape close + reposition on scroll / resize. Scroll uses
  // capture so it catches the wizard's inner overflow-y-auto scroller too.
  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (triggerRef.current?.contains(t) || menuRef.current?.contains(t)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    const onReflow = () => computePosition()
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKey)
    window.addEventListener('resize', onReflow)
    window.addEventListener('scroll', onReflow, true)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', onReflow)
      window.removeEventListener('scroll', onReflow, true)
    }
  }, [open, computePosition])

  // Sync the keyboard highlight to the current value each time we open.
  useEffect(() => {
    if (open) {
      const idx = options.findIndex((o) => o.id === value)
      setActiveIndex(idx >= 0 ? idx : 0)
    }
  }, [open, value, options])

  const choose = useCallback(
    (id: string) => {
      onChange(id)
      setOpen(false)
    },
    [onChange],
  )

  const onTriggerKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (disabled) return
      if (!open && (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault()
        setOpen(true)
        return
      }
      if (!open) return
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActiveIndex((i) => Math.min(i + 1, options.length - 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActiveIndex((i) => Math.max(i - 1, 0))
      } else if (e.key === 'Enter') {
        e.preventDefault()
        const opt = options[activeIndex]
        if (opt) choose(opt.id)
      }
    },
    [open, disabled, options, activeIndex, choose],
  )

  return (
    <div style={{ position: 'relative', width: '100%' }}>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => !disabled && setOpen((v) => !v)}
        onKeyDown={onTriggerKeyDown}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          width: '100%',
          height: 40,
          padding: '0 14px',
          fontSize: 13,
          fontWeight: 500,
          fontFamily: 'var(--font-body)',
          textAlign: 'left',
          borderRadius: 8,
          border: `1px solid ${open || focused ? 'var(--primary)' : 'var(--border)'}`,
          background: 'var(--surface)',
          color: selected ? 'var(--foreground)' : 'rgb(var(--foreground-rgb) / 0.45)',
          cursor: disabled ? 'not-allowed' : 'pointer',
          opacity: disabled ? 0.5 : 1,
          outline: 'none',
          boxShadow:
            (open || focused) && !disabled ? '0 0 0 4px rgb(var(--primary-rgb) / 0.15)' : 'none',
          transition:
            'border-color var(--motion-fast), background var(--motion-fast), box-shadow var(--motion-fast)',
        }}
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {displayLabel}
        </span>
        <ChevronDown
          aria-hidden
          size={14}
          strokeWidth={2}
          style={{
            flexShrink: 0,
            color: 'rgb(var(--foreground-rgb) / 0.5)',
            transform: open ? 'rotate(180deg)' : 'none',
            transition: 'transform var(--motion-fast)',
          }}
        />
      </button>

      {open &&
        pos &&
        createPortal(
          <div
            ref={menuRef}
            role="listbox"
            aria-label={ariaLabel}
            className="border border-border bg-popover"
            style={{
              position: 'fixed',
              left: pos.left,
              width: pos.width,
              ...(pos.top !== undefined ? { top: pos.top } : {}),
              ...(pos.bottom !== undefined ? { bottom: pos.bottom } : {}),
              zIndex: 1000,
              maxHeight: pos.maxHeight,
              overflowY: 'auto',
              borderRadius: 12,
              padding: '6px 0',
              boxShadow: 'var(--shadow-floating)',
            }}
          >
            {options.map((opt, idx) => {
              const isSelected = opt.id === value
              const isActive = idx === activeIndex
              return (
                <button
                  key={opt.id}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  onClick={() => choose(opt.id)}
                  onMouseEnter={() => setActiveIndex(idx)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    width: '100%',
                    padding: '8px 12px',
                    fontSize: 12,
                    fontFamily: 'var(--font-body)',
                    textAlign: 'left',
                    border: 'none',
                    cursor: 'pointer',
                    color: isSelected ? 'var(--mint)' : 'var(--foreground)',
                    background: isSelected
                      ? 'rgb(var(--mint-rgb) / 0.08)'
                      : isActive
                        ? 'rgb(var(--foreground-rgb) / 0.06)'
                        : 'transparent',
                    transition: 'background var(--motion-fast)',
                  }}
                >
                  <span
                    style={{
                      flex: 1,
                      fontWeight: isSelected ? 600 : 400,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {opt.label}
                  </span>
                  {idx === 0 && (
                    <span
                      style={{
                        fontSize: 9,
                        fontFamily: 'var(--font-mono)',
                        fontWeight: 600,
                        letterSpacing: '0.08em',
                        textTransform: 'uppercase',
                        padding: '1px 6px',
                        borderRadius: 4,
                        background: 'rgb(var(--mint-rgb) / 0.12)',
                        color: 'var(--mint)',
                        flexShrink: 0,
                      }}
                    >
                      Recommended
                    </span>
                  )}
                  {isSelected && (
                    <Check style={{ width: 14, height: 14, color: 'var(--mint)', flexShrink: 0 }} />
                  )}
                </button>
              )
            })}
          </div>,
          document.body,
        )}
    </div>
  )
}
