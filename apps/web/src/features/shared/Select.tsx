// Styled select primitive — a custom, fully on-brand dropdown (NOT a native
// `<select>`, whose popup list is drawn by the OS and can't be themed).
//
// Mirrors the app's other pickers (`ModelDropdown` / `AgentModelSelector`): a
// pill trigger + a `bg-popover` popover with check-marked rows, arrow-key
// navigation, outside-click / Escape close. The popover is rendered through a
// portal to `document.body` with FIXED positioning anchored to the trigger rect
// (so it escapes every ancestor's `overflow: hidden` / clipped rounded corners),
// and flips ABOVE the trigger when there isn't room below.
//
// The API is unchanged from the old native wrapper — pass `value` + `onChange`
// and either an `options` array OR raw `<option>` children (whose content may be
// any ReactNode, e.g. an emoji + name). Use this anywhere a vanilla `<select>`
// would otherwise render the OS-default listbox. Pass `searchable` for long lists
// (e.g. the ~hundreds of live OpenRouter models) to add a sticky filter box.

import {
  Children,
  isValidElement,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { CSSProperties, ReactElement, ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown } from 'lucide-react'

import { SearchInput } from './SearchInput'

export type SelectSize = 'sm' | 'md'

export interface SelectOption {
  value: string
  label: string
  disabled?: boolean
}

// Internal shape — a children-parsed option carries a ReactNode label (e.g. an
// emoji + team name), so the normalized form widens `label` beyond `string`.
interface NormalizedOption {
  value: string
  label: ReactNode
  disabled?: boolean
}

export interface SelectProps {
  /** Convenience prop — pass an array of options or use `children` directly. */
  options?: SelectOption[]
  value: string
  onChange: (value: string) => void
  /** Compact (sm = 26 px) vs default (md = 32 px) trigger heights. */
  size?: SelectSize
  /** Optional fixed menu width (px). Defaults to the trigger width; pass a larger
   *  value when the trigger is compact but the option labels are long, so the menu
   *  stays readable (it's clamped to the viewport so it never overflows the edge). */
  menuWidth?: number
  /** Render a sticky search box that filters the options. For long lists. */
  searchable?: boolean
  /** Placeholder for the search box (when `searchable`). */
  searchPlaceholder?: string
  /** Raw `<option>` elements (labels may be any ReactNode). */
  children?: ReactNode
  className?: string
  style?: CSSProperties
  disabled?: boolean
  'aria-label'?: string
  'data-testid'?: string
  id?: string
}

const SIZE_STYLES: Record<
  SelectSize,
  { height: number; fontSize: number; pl: number; pr: number; chevron: number }
> = {
  sm: { height: 26, fontSize: 11, pl: 8, pr: 22, chevron: 12 },
  md: { height: 32, fontSize: 12, pl: 10, pr: 26, chevron: 14 },
}

interface MenuPosition {
  left: number
  width: number
  top?: number
  bottom?: number
  maxHeight: number
}

const MENU_DESIRED_HEIGHT = 264
const MENU_GAP = 4

// Parse `<option>` children into the normalized option shape. Handles the two
// forms consumers use — a mapped array of `<option>` and inline `<option>`
// literals — flattening fragments via `Children.toArray`.
function optionsFromChildren(children: ReactNode): NormalizedOption[] {
  const out: NormalizedOption[] = []
  Children.toArray(children).forEach((child) => {
    if (!isValidElement(child) || child.type !== 'option') return
    const props = (child as ReactElement<{ value?: string; disabled?: boolean; children?: ReactNode }>)
      .props
    out.push({
      value: String(props.value ?? ''),
      label: props.children,
      disabled: props.disabled,
    })
  })
  return out
}

export function Select({
  options,
  value,
  onChange,
  size = 'md',
  menuWidth,
  searchable = false,
  searchPlaceholder = 'Search…',
  children,
  className,
  style,
  disabled,
  'aria-label': ariaLabel,
  'data-testid': dataTestId,
  id,
}: SelectProps) {
  const dims = SIZE_STYLES[size]
  const normalized: NormalizedOption[] = options ?? optionsFromChildren(children)

  const [open, setOpen] = useState(false)
  const [focused, setFocused] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const [search, setSearch] = useState('')
  const [pos, setPos] = useState<MenuPosition | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  // The rows the popover renders — filtered by the search box when `searchable`.
  const filtered = useMemo(() => {
    const q = searchable ? search.trim().toLowerCase() : ''
    if (!q) return normalized
    return normalized.filter(
      (o) =>
        o.value.toLowerCase().includes(q) ||
        (typeof o.label === 'string' && o.label.toLowerCase().includes(q)),
    )
  }, [normalized, search, searchable])

  // Refs so the highlight effect can read the latest filtered list + value WITHOUT
  // depending on their identity — an inline-array / `<option>`-children consumer
  // re-parses a NEW array every render, which would otherwise reset the highlight.
  const filteredRef = useRef(filtered)
  filteredRef.current = filtered
  const valueRef = useRef(value)
  valueRef.current = value
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([])

  const selectedIndex = normalized.findIndex((o) => o.value === value)
  const selected = selectedIndex >= 0 ? normalized[selectedIndex] : undefined
  // Mirror the native <select>, which shows the first option when the value
  // matches none — never a blank trigger. (Always from the FULL list, so the
  // trigger keeps showing the selection even while the list is filtered.)
  const displayLabel = selected?.label ?? normalized[0]?.label ?? ''

  const computePosition = useCallback(() => {
    const el = triggerRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const spaceBelow = window.innerHeight - r.bottom
    const spaceAbove = r.top
    const estimatedHeight = Math.min(MENU_DESIRED_HEIGHT, normalized.length * 34 + 12)
    const openUp = spaceBelow < estimatedHeight + MENU_GAP + 8 && spaceAbove > spaceBelow
    const maxHeight = Math.max(
      120,
      Math.min(MENU_DESIRED_HEIGHT, (openUp ? spaceAbove : spaceBelow) - 12),
    )
    // The menu may be wider than a compact trigger (menuWidth); keep it left-anchored
    // to the trigger but clamp so it never overflows the viewport's right edge.
    const width = menuWidth && menuWidth > r.width ? menuWidth : r.width
    const left = Math.max(8, Math.min(r.left, window.innerWidth - 8 - width))
    setPos({
      left,
      width,
      maxHeight,
      ...(openUp ? { bottom: window.innerHeight - r.top + MENU_GAP } : { top: r.bottom + MENU_GAP }),
    })
  }, [normalized.length, menuWidth])

  useLayoutEffect(() => {
    if (open) computePosition()
  }, [open, computePosition])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (triggerRef.current?.contains(t) || menuRef.current?.contains(t)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation() // don't also close a parent modal behind the dropdown
        setOpen(false)
      }
    }
    const onReflow = () => computePosition()
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKey, true)
    window.addEventListener('resize', onReflow)
    window.addEventListener('scroll', onReflow, true)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKey, true)
      window.removeEventListener('resize', onReflow)
      window.removeEventListener('scroll', onReflow, true)
    }
  }, [open, computePosition])

  // Reset the search box each time the menu closes.
  useEffect(() => {
    if (!open) setSearch('')
  }, [open])

  // Set the initial highlight when the menu OPENS or the search query changes —
  // deliberately NOT on every render (depending on `filtered`'s identity would snap
  // the highlight back to the selected row on any re-render, breaking arrow / hover
  // for inline-array and `<option>`-children consumers).
  useEffect(() => {
    if (!open) return
    if (searchable && search.trim()) {
      setActiveIndex(0)
      return
    }
    const idx = filteredRef.current.findIndex((o) => o.value === valueRef.current)
    setActiveIndex(idx >= 0 ? idx : 0)
  }, [open, searchable, search])

  // Keep the keyboard-highlighted row visible in the scroll container (long lists).
  useEffect(() => {
    if (!open) return
    optionRefs.current[activeIndex]?.scrollIntoView?.({ block: 'nearest' })
  }, [activeIndex, open])

  const choose = useCallback(
    (opt: NormalizedOption) => {
      if (opt.disabled) return
      onChange(opt.value)
      setOpen(false)
    },
    [onChange],
  )

  // Skip disabled options when arrowing (over the currently-visible `filtered` list).
  const step = useCallback(
    (from: number, dir: 1 | -1) => {
      let i = from
      for (let n = 0; n < filtered.length; n++) {
        i = Math.min(Math.max(i + dir, 0), filtered.length - 1)
        if (!filtered[i]?.disabled) return i
        if (i === 0 || i === filtered.length - 1) break
      }
      return from
    },
    [filtered],
  )

  // Shared arrow/enter/escape navigation — used by the trigger (non-searchable)
  // and the search box (searchable), both operating on the `filtered` list.
  const navKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActiveIndex((i) => step(i, 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActiveIndex((i) => step(i, -1))
      } else if (e.key === 'Enter') {
        e.preventDefault()
        const opt = filtered[activeIndex]
        if (opt) choose(opt)
      } else if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        setOpen(false)
      }
    },
    [step, filtered, activeIndex, choose],
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
      // When searchable, the search box owns keyboard nav (it has focus on open).
      if (searchable) return
      // Space selects the highlighted option (non-searchable only — in the search
      // box Space must type a space). preventDefault stops the native <button>
      // activation that would otherwise just toggle the open menu closed.
      if (e.key === ' ') {
        e.preventDefault()
        const opt = filtered[activeIndex]
        if (opt) choose(opt)
        return
      }
      navKeyDown(e)
    },
    [open, disabled, searchable, navKeyDown, filtered, activeIndex, choose],
  )

  return (
    <div
      className={className}
      style={{ position: 'relative', display: 'inline-block', ...style }}
    >
      <button
        ref={triggerRef}
        type="button"
        id={id}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        data-testid={dataTestId}
        onClick={() => !disabled && setOpen((v) => !v)}
        onKeyDown={onTriggerKeyDown}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 6,
          width: '100%',
          height: dims.height,
          paddingLeft: dims.pl,
          paddingRight: dims.pr - 8,
          background: 'var(--surface)',
          border: `1px solid ${(open || focused) && !disabled ? 'var(--primary)' : 'var(--border)'}`,
          borderRadius: 8,
          color: 'rgb(var(--foreground-rgb) / 0.85)',
          fontSize: dims.fontSize,
          fontFamily: 'var(--font-body)',
          fontWeight: 500,
          textAlign: 'left',
          cursor: disabled ? 'not-allowed' : 'pointer',
          outline: 'none',
          boxShadow:
            (open || focused) && !disabled ? '0 0 0 4px rgb(var(--primary-rgb) / 0.15)' : 'none',
          transition:
            'border-color var(--motion-fast), background var(--motion-fast), box-shadow var(--motion-fast)',
          opacity: disabled ? 0.5 : 1,
          minWidth: 0,
        }}
      >
        <span
          style={{
            flex: 1,
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {displayLabel}
        </span>
        <ChevronDown
          aria-hidden
          size={dims.chevron}
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
              borderRadius: 10,
              padding: '5px 0',
              boxShadow: 'var(--shadow-floating)',
            }}
          >
            {searchable && (
              <div
                className="bg-popover"
                style={{ position: 'sticky', top: 0, zIndex: 1, padding: '2px 8px 6px' }}
              >
                <SearchInput
                  size="sm"
                  value={search}
                  onChange={setSearch}
                  placeholder={searchPlaceholder}
                  autoFocus
                  onKeyDown={navKeyDown}
                  aria-label={ariaLabel ? `Search ${ariaLabel}` : 'Search options'}
                />
              </div>
            )}

            {filtered.length === 0 ? (
              <div
                style={{
                  padding: '9px 12px',
                  fontSize: dims.fontSize,
                  color: 'rgb(var(--foreground-rgb) / 0.45)',
                }}
              >
                No matches
              </div>
            ) : (
              filtered.map((opt, idx) => {
                const isSelected = opt.value === value
                const isActive = idx === activeIndex
                return (
                  <button
                    key={`${opt.value}-${idx}`}
                    ref={(el) => {
                      optionRefs.current[idx] = el
                    }}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    aria-disabled={opt.disabled || undefined}
                    onClick={() => choose(opt)}
                    onMouseEnter={() => !opt.disabled && setActiveIndex(idx)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      width: '100%',
                      padding: '7px 12px',
                      fontSize: dims.fontSize,
                      fontFamily: 'var(--font-body)',
                      textAlign: 'left',
                      border: 'none',
                      cursor: opt.disabled ? 'not-allowed' : 'pointer',
                      color: opt.disabled ? 'rgb(var(--foreground-rgb) / 0.4)' : 'var(--foreground)',
                      background: isSelected
                        ? 'rgb(var(--primary-rgb) / 0.07)'
                        : isActive && !opt.disabled
                          ? 'rgb(var(--foreground-rgb) / 0.06)'
                          : 'transparent',
                      transition: 'background var(--motion-fast)',
                    }}
                  >
                    <span
                      style={{
                        flex: 1,
                        minWidth: 0,
                        fontWeight: isSelected ? 600 : 400,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {opt.label}
                    </span>
                    {isSelected && (
                      <Check
                        style={{ width: 14, height: 14, color: 'var(--primary)', flexShrink: 0 }}
                      />
                    )}
                  </button>
                )
              })
            )}
          </div>,
          document.body,
        )}
    </div>
  )
}
