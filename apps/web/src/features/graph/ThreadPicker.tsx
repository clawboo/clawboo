// What a thread can end in, offered where it was dropped.
//
// THE GESTURE THIS COMPLETES already half-existed: React Flow reports a drop on
// empty canvas through `onConnectEnd`, and the handler hard-returned with the
// comment "the gesture just ends". That early return is the one interaction
// every node editor has taught people -- drag out, let go, pick what appears --
// and the canvas was throwing it away.
//
// ONLY LEGAL ENDINGS ARE LISTED. The rows are filtered by what the source node
// can actually connect to, so an impossible connection is never on screen to be
// attempted. That is the same posture as the connectors shelf: a button you can
// see is a button the server will accept.
//
// NOTHING COMPLEX IS OFFERED HERE. Anything needing more than a name or a pick
// (a credential, a folder, a custom server, a team) is absent rather than
// linked away, because a row that opens another window is the pattern this
// surface exists to remove.

import { useEffect, useMemo, useRef, useState } from 'react'
import { Plus, Search } from 'lucide-react'

import { ConnectorMark } from '@/features/connectors/ConnectorMark'
import { useDismissableLayer } from '@/features/shared/useDismissableLayer'

/** A thing the thread could end in. */
export interface ThreadOption {
  id: string
  /** Group heading. Rows are rendered in group order. */
  group: 'Agents' | 'Skills' | 'Connectors'
  label: string
  /** One line, truncated. */
  hint?: string
  /** The verb the row commits to, e.g. "Turn on" or "Add key". */
  action?: string
  /** A connector slug, so the row can carry the real brand mark. */
  slug?: string
  /** Rows that cannot be completed on the canvas render inert with a reason. */
  disabledReason?: string
}

export interface ThreadPickerProps {
  /** Screen position of the drop, in client pixels. */
  at: { x: number; y: number }
  options: readonly ThreadOption[]
  /** Whether a new agent can be created from here. */
  allowNewAgent: boolean
  onPick: (option: ThreadOption) => void
  onCreateAgent: (name: string) => void
  onClose: () => void
}

const PANEL_W = 300
const PANEL_MAX_H = 380

export function ThreadPicker({
  at,
  options,
  allowNewAgent,
  onPick,
  onCreateAgent,
  onClose,
}: ThreadPickerProps) {
  const [query, setQuery] = useState('')
  const [newAgentName, setNewAgentName] = useState('')
  const [creating, setCreating] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // Escape and outside-press both close. A picker that traps the pointer is
  // worse than no picker: the gesture must always be abandonable.
  //
  // THROUGH THE LAYER STACK, not a raw listener. The house rule exists because
  // a capture-phase key listener runs before the stack and before every React
  // onKeyDown, so two overlays act on one Escape and the wrong one closes.
  useDismissableLayer({
    active: true,
    level: 'popover',
    onEscape: onClose,
    contains: (target) => Boolean(panelRef.current?.contains(target)),
    onPressOutside: onClose,
  })

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return options
    return options.filter(
      (o) => o.label.toLowerCase().includes(q) || (o.hint ?? '').toLowerCase().includes(q),
    )
  }, [options, query])

  const groups = useMemo(() => {
    const order: ThreadOption['group'][] = ['Agents', 'Skills', 'Connectors']
    return order
      .map((g) => ({ group: g, rows: filtered.filter((o) => o.group === g) }))
      .filter((g) => g.rows.length > 0)
  }, [filtered])

  // Kept inside the viewport: a picker opened near the right or bottom edge
  // would otherwise render half off-screen, which is where drops often land.
  const left = Math.min(at.x, window.innerWidth - PANEL_W - 16)
  const top = Math.min(at.y, window.innerHeight - PANEL_MAX_H - 16)

  const showNewAgent =
    allowNewAgent && (query.trim() === '' || 'new agent'.includes(query.toLowerCase()))

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-label="Connect to"
      className="fixed z-50 overflow-hidden rounded-xl border border-border bg-surface shadow-lg"
      style={{
        left: Math.max(8, left),
        top: Math.max(8, top),
        width: PANEL_W,
        maxHeight: PANEL_MAX_H,
        boxShadow: 'var(--shadow-raised)',
        animation: 'threadPickerIn 140ms cubic-bezier(0.32, 0.72, 0, 1)',
      }}
    >
      <style>{`@keyframes threadPickerIn{from{opacity:0;transform:scale(.97) translateY(-4px)}to{opacity:1;transform:none}}`}</style>

      <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
        <Search size={14} className="shrink-0 text-muted-foreground" aria-hidden />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search"
          className="w-full bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground"
        />
      </div>

      <div className="max-h-[320px] overflow-y-auto py-1">
        {showNewAgent && (
          <div className="px-1 pb-1">
            <div className="px-2 pb-1 pt-1.5 font-mono text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
              Agents
            </div>
            <div className="flex items-center gap-2 rounded-lg px-2 py-1.5">
              <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-foreground/[0.06] text-foreground/55">
                <Plus size={13} aria-hidden />
              </span>
              <input
                value={newAgentName}
                onChange={(e) => setNewAgentName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter' || creating) return
                  const name = newAgentName.trim()
                  if (!name) return
                  setCreating(true)
                  onCreateAgent(name)
                }}
                placeholder="New agent: type a name"
                aria-label="Name for the new agent"
                className="w-full bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground"
              />
            </div>
          </div>
        )}

        {groups.map(({ group, rows }) => (
          <div key={group} className="px-1">
            <div className="px-2 pb-1 pt-1.5 font-mono text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
              {group}
            </div>
            {rows.map((o) => (
              <button
                key={o.id}
                type="button"
                disabled={Boolean(o.disabledReason)}
                title={o.disabledReason ?? o.hint}
                onClick={() => onPick(o)}
                className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors duration-120 ${
                  o.disabledReason
                    ? 'cursor-not-allowed opacity-45'
                    : 'cursor-pointer hover:bg-foreground/[0.055]'
                }`}
              >
                {o.slug ? (
                  <ConnectorMark slug={o.slug} displayName={o.label} size={24} />
                ) : (
                  <span className="size-6 shrink-0 rounded-md bg-foreground/[0.06]" aria-hidden />
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] leading-tight text-foreground">
                    {o.label}
                  </span>
                  {o.hint && (
                    <span className="block truncate text-[11px] leading-snug text-muted-foreground">
                      {o.hint}
                    </span>
                  )}
                </span>
                {o.action && !o.disabledReason && (
                  <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.06em] text-muted-foreground">
                    {o.action}
                  </span>
                )}
              </button>
            ))}
          </div>
        ))}

        {groups.length === 0 && !showNewAgent && (
          <p className="px-3 py-6 text-center text-[12px] text-muted-foreground">
            Nothing here matches <span className="text-foreground">{query.trim()}</span>.
          </p>
        )}
      </div>
    </div>
  )
}
