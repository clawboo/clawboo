// A filter-chip row that shows the popular options inline and tucks the rest
// behind a "+N more" toggle, so a long taxonomy (15 agent domains / 18 team
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
  'aria-label'?: string
}

export function CollapsiblePillRow({
  options,
  activeKey,
  onSelect,
  primaryCount = 7,
  allLabel = 'All',
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
    <div className="flex flex-wrap gap-1.5" role="group" aria-label={ariaLabel}>
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
