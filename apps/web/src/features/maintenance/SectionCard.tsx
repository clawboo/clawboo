import type { ReactNode } from 'react'

/** A clean card with a mono-uppercase section label above its body. */
export function SectionCard({
  label,
  children,
  ...rest
}: {
  label: string
  children: ReactNode
  'data-testid'?: string
}) {
  return (
    <section
      className="rounded-2xl border border-border bg-surface p-5"
      style={{ boxShadow: 'var(--shadow-raised)' }}
      {...rest}
    >
      <h2 className="font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
        {label}
      </h2>
      <div className="mt-4">{children}</div>
    </section>
  )
}
