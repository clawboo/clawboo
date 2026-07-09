// A single, refined capability chip shared by RuntimesPanel + RuntimeConnectionCard.
//
// Design: a quiet neutral chip carrying a tiny status DOT — mint when the runtime
// supports the capability, dim when it doesn't. The colour lives only in the 4-px
// dot, never a loud full-pill fill, so a row of five reads as a cohesive spec strip
// (Linear / Vercel capability-tag aesthetic) rather than a wall of green.

const DOT_ON = 'var(--mint)'
const DOT_OFF = 'rgb(var(--foreground-rgb) / 0.22)'

export function CapabilityChip({ label, on }: { label: string; on: boolean }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-md px-2 py-[3px] font-mono text-[10px] tracking-tight"
      style={{
        background: on ? 'rgb(var(--foreground-rgb) / 0.05)' : 'rgb(var(--foreground-rgb) / 0.025)',
        color: on ? 'rgb(var(--foreground-rgb) / 0.72)' : 'rgb(var(--foreground-rgb) / 0.3)',
      }}
    >
      <span
        className="h-[5px] w-[5px] shrink-0 rounded-full"
        style={{ background: on ? DOT_ON : DOT_OFF }}
        aria-hidden
      />
      {label}
    </span>
  )
}
