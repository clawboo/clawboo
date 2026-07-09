import type { LucideIcon } from 'lucide-react'

// The gradient banner that leads each marketplace grid (Skills / Agents / Teams)
// and the team showcase reused inside the first-run "create a team" modal.
export function HeroTile({
  gradient,
  icon: Icon,
  eyebrow,
  title,
  subtitle,
}: {
  gradient: string
  icon: LucideIcon
  eyebrow: string
  title: string
  subtitle: string
}) {
  return (
    <div
      className="relative flex flex-col justify-between gap-3 overflow-hidden rounded-2xl p-5 text-white"
      style={{ background: gradient, boxShadow: 'var(--shadow-raised)' }}
    >
      <div className="flex items-center gap-2">
        <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-white/20">
          <Icon size={18} strokeWidth={2} />
        </span>
        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-white/80">
          {eyebrow}
        </span>
      </div>
      <div>
        <div className="font-display text-[17px] font-bold" style={{ letterSpacing: '-0.01em' }}>
          {title}
        </div>
        <div className="mt-1 text-[12.5px] leading-snug text-white/85">{subtitle}</div>
      </div>
    </div>
  )
}
