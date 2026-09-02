// A filter-chip row that shows the popular options inline and tucks the rest
// behind a "+N more" toggle, so a long taxonomy (20 agent categories / 15 team
// categories) reads as a clean single band instead of a wrapping wall of pills.
//
// The caller passes `options` already ordered popular-first (excluding "All");
// the row renders All + the first `primaryCount` + a More/Less toggle. The
// currently-active option is ALWAYS visible even while collapsed — so a filter
// picked from the expanded set never disappears when the row is folded back.

import { useState } from 'react'
import { ChevronDown } from 'lucide-react'

import { Chip } from '@/features/shared/Chip'

export interface PillOption {
  key: string
  label: string
  /** Optional accent color for the active state (defaults to brand red). */
  color?: string
}

export interface CollapsiblePillRowProps {
  options: PillOption[]
  /** The active key — `'all'` or one of the option keys. */
  activeKey: string
  /** Called with `'all'` or an option key. */
  onSelect: (key: string) => void
  /** How many options show inline before the "More" toggle. Default 7. */
  primaryCount?: number
  allLabel?: string
  /**
   * Visible name for the axis this row filters on, rendered before the chips.
   *
   * Two unlabelled rows sitting on top of each other read as one long list of
   * interchangeable chips, so picking one from each looks like a contradiction
   * rather than an intersection. Category and Pack are different questions and
   * the row has to say which one it is asking.
   */
  label?: string
  /** Render each option's `color` as a leading dot, not just as the active accent. */
  dot?: boolean
  'aria-label'?: string
}

export function CollapsiblePillRow({
  options,
  activeKey,
  onSelect,
  primaryCount = 7,
  allLabel = 'All',
  label,
  dot = false,
  'aria-label': ariaLabel,
}: CollapsiblePillRowProps) {
  const [expanded, setExpanded] = useState(false)

  const collapsible = options.length > primaryCount

  // Collapsed → the first `primaryCount`, plus the active option if it lives in
  // the hidden tail (so the current filter is never invisible). Expanded → all.
  let visible = options
  if (!expanded && collapsible) {
    visible = options.slice(0, primaryCount)
    const active = options.find((o) => o.key === activeKey)
    if (active && !visible.includes(active)) visible = [...visible, active]
  }

  const hiddenCount = options.length - visible.length

  return (
    <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={ariaLabel}>
      {label && (
        <span className="mr-0.5 shrink-0 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          {label}
        </span>
      )}

      <Chip size="sm" active={activeKey === 'all'} onClick={() => onSelect('all')}>
        {allLabel}
      </Chip>

      {visible.map((opt) => (
        <Chip
          key={opt.key}
          size="sm"
          active={activeKey === opt.key}
          accent={opt.color}
          onClick={() => onSelect(opt.key)}
        >
          {dot && opt.color && (
            <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: opt.color }} />
          )}
          {opt.label}
        </Chip>
      ))}

      {collapsible && (hiddenCount > 0 || expanded) && (
        <Chip
          size="sm"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="text-foreground/50"
        >
          {expanded ? 'Show less' : `+${hiddenCount} more`}
          <ChevronDown
            size={13}
            strokeWidth={2}
            className="transition-transform duration-150"
            style={{ transform: expanded ? 'rotate(180deg)' : 'none', opacity: 0.7 }}
          />
        </Chip>
      )}
    </div>
  )
}
