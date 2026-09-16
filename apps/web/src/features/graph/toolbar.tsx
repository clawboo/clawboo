import type { LucideIcon } from 'lucide-react'

// ─── Canvas control primitives ──────────────────────────────────────────────
//
// One shared visual dialect for every piece of graph chrome. The top command
// bar AND the bottom viewport bar are both built from these atoms inside a
// single `.surface-floating-tier` glass shell — so the controls read as ONE
// coordinated system instead of the old three-corner / three-language sprawl.
// Buttons carry NO per-button border/background; the glass shell is the single
// elevated plane and hover is a quiet fill-fade (no jittery per-button lift).
//
// Accent semantics (two tiers, matching the product convention):
//   • primary (red)   — the single forward authoring action (Connect).
//   • mint            — an on/overlay toggle is engaged (Halos, Activity, Lock,
//                       Minimap-shown).
//   • neutral         — a momentary action's transient pressed tint.

export type BarTint = 'primary' | 'mint' | 'neutral'

export function BarBtn({
  icon: Icon,
  label,
  onClick,
  active,
  tint = 'primary',
  disabled,
}: {
  icon: LucideIcon
  label: string
  onClick: () => void
  active?: boolean
  tint?: BarTint
  disabled?: boolean
}) {
  const activeClass =
    tint === 'mint'
      ? 'bg-mint/[0.18] text-mint'
      : tint === 'neutral'
        ? 'bg-foreground/[0.10] text-foreground'
        : 'bg-primary/[0.18] text-primary'
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active ?? undefined}
      disabled={disabled}
      onClick={onClick}
      className={[
        'flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-lg transition-colors duration-150',
        'focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-1',
        'disabled:cursor-default disabled:opacity-40',
        active
          ? activeClass
          : 'text-foreground/55 hover:bg-foreground/[0.06] hover:text-foreground/90',
      ].join(' ')}
    >
      <Icon size={15} strokeWidth={2} aria-hidden />
    </button>
  )
}

export function BarDivider() {
  return <span aria-hidden className="mx-1 h-5 w-px shrink-0 bg-[rgb(var(--foreground-rgb)/0.1)]" />
}
