import { useEffect, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { OpenClawIcon, RuntimeIcon } from '@/features/runtimes/RuntimeBrand'
import type { RuntimeId } from '@/features/runtimes/runtimeCatalog'
import type { RuntimeOption, SelectableSourceId } from './runtimeSelection'

interface RuntimeSelectProps {
  value: SelectableSourceId
  options: RuntimeOption[]
  onChange: (sourceId: SelectableSourceId) => void
  /** Fired when a DISABLED option is clicked, with the option's sourceId so the caller
   *  can route it (OpenClaw → the Gateway connect flow; a coding runtime → Runtimes). */
  onDisabledClick: (sourceId: SelectableSourceId) => void
}

function optionIcon(sourceId: SelectableSourceId): React.ReactNode {
  // OpenClaw is not a RuntimeId (can't route through RuntimeIcon) — it gets the
  // real OpenClaw mark via the sibling OpenClawIcon export.
  if (sourceId === 'openclaw') return <OpenClawIcon size={14} />
  return <RuntimeIcon id={sourceId as RuntimeId} size={14} />
}

/** A compact per-member runtime dropdown. Enabled options select; disabled ones
 *  route to the Runtimes panel to connect. Click-outside + Escape close it. */
export function RuntimeSelect({ value, options, onChange, onDisabledClick }: RuntimeSelectProps) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const current = options.find((o) => o.sourceId === value) ?? options[0]

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 rounded-md border border-border bg-foreground/[0.03] px-1.5 py-0.5 text-[10.5px] text-text/75 transition-colors hover:bg-foreground/[0.06]"
        data-testid="member-runtime-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        {current && optionIcon(current.sourceId)}
        <span className="max-w-[80px] truncate">{current?.label}</span>
        <ChevronDown className="h-3 w-3 opacity-60" strokeWidth={2} />
      </button>
      {open && (
        <div
          role="listbox"
          className="surface-floating-tier absolute right-0 z-10 mt-1 w-44 py-1"
          style={{ borderRadius: 10 }}
        >
          {options.map((o) => (
            <button
              key={o.sourceId}
              type="button"
              role="option"
              aria-selected={o.sourceId === value}
              disabled={false}
              onClick={() => {
                if (o.enabled) onChange(o.sourceId)
                else onDisabledClick(o.sourceId)
                setOpen(false)
              }}
              className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[11.5px] ${
                o.enabled
                  ? 'text-text/85 hover:bg-foreground/[0.05]'
                  : 'text-secondary/45 hover:bg-foreground/[0.03]'
              }`}
              title={o.enabled ? undefined : o.reason}
            >
              {optionIcon(o.sourceId)}
              <span className="flex-1 truncate">{o.label}</span>
              {!o.enabled && <span className="text-[9.5px] text-secondary/55">Connect →</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
