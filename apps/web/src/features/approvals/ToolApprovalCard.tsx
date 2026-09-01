import { useId, useMemo, useState } from 'react'
import { motion, useReducedMotion } from 'framer-motion'
import { ChevronDown } from 'lucide-react'

import { appForToolkit } from '@clawboo/connector-catalog'
import { Button } from '@/features/shared/Button'
import {
  ConnectorMark,
  ConnectorMarkStyles,
  GenericMark,
} from '@/features/connectors/ConnectorMark'
import { useFleetStore } from '@/stores/fleet'
import { humanizeApproval, type ActionClass } from './humanize'
import type { ToolApproval, ToolDecision } from './usePendingApprovals'

// ─── ToolApprovalCard ──────────────────────────────────────────────────────
// The one place a person is asked to authorise something an agent wants to do.
//
// IT IS A RECEIPT, NOT A DEBUGGER. What it used to show was addressed to whoever
// wrote the tool: a raw `mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL`, a sentence
// repeating that name, and a clipped JSON blob. None of it answered the only
// question that matters, which is what happens to the person if they say yes.
//
// WHAT IS ALWAYS VISIBLE is decided by consequence, not by tidiness: any field
// whose value alone changes who is reached, what leaves the machine, or what is
// destroyed is rendered inline and cannot be collapsed. The disclosure holds the
// remainder. A recipient behind a triangle is not a cleaner card, it is consent
// to something unseen.
//
// WHAT IS DELIBERATELY ABSENT. No autofocus: cards arrive from a 3-second poll
// with no user gesture, and this tray sits directly above the composer, so
// taking focus would eat whatever the user was typing. No Escape binding either:
// Escape belongs to the dismissable-layer stack, and a denial is not a dismissal
// but a recorded decision that fails a live call.

interface ToolApprovalCardProps {
  approval: ToolApproval
  onResolve: (id: string, decision: ToolDecision) => void
  /** Tighter padding + smaller radius for the in-chat tray. */
  compact?: boolean
}

/** The rail and the Allow button take their weight from the same judgement. */
const RAIL: Record<ActionClass, string> = {
  destroys: 'rgb(var(--destructive-rgb))',
  sends: 'rgb(var(--destructive-rgb))',
  changes: 'rgb(var(--amber-rgb))',
  reads: 'rgb(var(--border-strong-rgb, var(--foreground-rgb) / 0.2))',
  unknown: 'rgb(var(--amber-rgb))',
}

export function ToolApprovalCard({ approval, onResolve, compact = false }: ToolApprovalCardProps) {
  const [open, setOpen] = useState(false)
  const panelId = useId()
  const headingId = useId()
  const reduceMotion = useReducedMotion()
  const agents = useFleetStore((s) => s.agents)

  const agentName = approval.agentId
    ? (agents.find((a) => a.id === approval.agentId)?.name ?? approval.agentId)
    : null

  const human = useMemo(
    () =>
      humanizeApproval({
        toolName: approval.toolName,
        argsSummary: approval.argsSummary,
        agentName,
        toolClass: approval.toolClass ?? null,
        toolSummary: approval.toolSummary ?? null,
      }),
    [approval.toolName, approval.argsSummary, agentName, approval.toolClass, approval.toolSummary],
  )

  // REMEMBERABLE MEANS THE SERVER CAN ACTUALLY MINT A RULE. `resolveApproval`
  // requires a `grantId` before it writes one, and every brokered app call has a
  // null grantId because the grant gate does not govern a broker meta-tool. An
  // "Always" offered there would behave exactly as Allow once while promising
  // otherwise, which is a control that lies. It is also withheld when clawboo
  // could not read the request: remembering a call nobody could describe is not
  // a decision anyone can make.
  const rememberable = !approval.neverRemember && Boolean(approval.grantId) && human.confident

  const [remember, setRemember] = useState(false)
  const expiresIn = Math.max(0, Math.round((approval.expiresAt - Date.now()) / 1000))
  const dangerous = human.actionClass === 'sends' || human.actionClass === 'destroys'
  const app = useMemo(() => {
    const m = /your ([A-Za-z ]+)$/.exec(human.chip)
    return m?.[1] ? appForToolkit(m[1].toLowerCase().replace(/ /g, '')) : null
  }, [human.chip])

  const hidden = human.remainder.length + (human.agentNote ? 1 : 0)

  return (
    <motion.div
      data-testid="approval-card"
      layout
      initial={reduceMotion ? false : { opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -4 }}
      transition={{ duration: reduceMotion ? 0 : 0.2, ease: 'easeOut' }}
      role="group"
      aria-labelledby={headingId}
      className={`relative flex flex-col overflow-hidden bg-surface ${
        compact ? 'gap-2 rounded-xl p-3 pl-4' : 'gap-2.5 rounded-2xl p-4 pl-5'
      } border border-border`}
      style={{ boxShadow: 'var(--shadow-raised)' }}
    >
      <ConnectorMarkStyles />
      {/* Redundant with the chip text and the button label, never the only signal. */}
      <span
        aria-hidden="true"
        className="absolute inset-y-0 left-0 w-[3px]"
        style={{ background: RAIL[human.actionClass] }}
      />

      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-2">
          {app ? (
            <ConnectorMark slug={app.slug} displayName={app.name} size={22} />
          ) : (
            <GenericMark size={22} />
          )}
          <span className="truncate text-[12.5px] font-medium text-foreground">
            {app?.name ?? agentName ?? 'Waiting on you'}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-2">
          <span className="rounded-full bg-foreground/[0.06] px-2 py-0.5 text-[10.5px] text-foreground/70">
            {human.chip}
          </span>
          {/* POLITE, not assertive: a countdown that interrupts a screen reader
              every second is pressure, not information. */}
          <span aria-live="polite" className="text-[10.5px] text-muted-foreground tabular-nums">
            {expiresIn}s
          </span>
        </span>
      </div>

      <h3 id={headingId} className="text-[14.5px] leading-[1.35] font-medium text-foreground">
        {human.headline}
      </h3>

      {!approval.agentId && (
        <p className="text-[11.5px] text-muted-foreground">
          clawboo could not tell which agent asked for this.
        </p>
      )}

      {human.decisive.length > 0 && (
        <dl className="flex flex-col gap-1">
          {human.decisive.slice(0, compact ? 2 : 3).map((f) => (
            <div key={f.label} className="flex gap-2 text-[12px]">
              <dt className="w-[74px] shrink-0 text-muted-foreground">{f.label}</dt>
              <dd className="min-w-0 flex-1 break-words text-foreground/90">{f.value}</dd>
            </div>
          ))}
        </dl>
      )}

      {hidden > 0 && (
        <>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-controls={panelId}
            className="flex cursor-pointer items-center gap-1 self-start text-[11.5px] text-muted-foreground transition-colors hover:text-foreground"
          >
            <ChevronDown
              size={12}
              className={`transition-transform ${open ? 'rotate-180' : ''}`}
              aria-hidden="true"
            />
            {open ? 'Hide details' : `Show ${hidden} more ${hidden === 1 ? 'detail' : 'details'}`}
          </button>
          {open && (
            <div id={panelId} className="flex flex-col gap-2">
              {human.remainder.length > 0 && (
                <dl
                  className="font-data flex flex-col gap-1 rounded-lg px-2.5 py-2 text-[11px] text-foreground/75"
                  style={{ background: 'var(--code-block-bg)' }}
                >
                  {human.remainder.map((f) => (
                    <div key={f.label} className="flex gap-2">
                      <dt className="shrink-0 text-foreground/50">{f.label}</dt>
                      <dd className="min-w-0 flex-1 break-all">{f.value}</dd>
                    </div>
                  ))}
                </dl>
              )}
              {/* The agent's own words, quoted and attributed. Never the headline:
                  it is model-written and delivered by a third party, which is
                  exactly what a prompt injection targets. */}
              {human.agentNote && (
                <figure className="border-l-2 border-border pl-2.5">
                  <blockquote className="text-[11.5px] leading-relaxed text-foreground/70">
                    {human.agentNote}
                  </blockquote>
                  <figcaption className="mt-0.5 text-[10.5px] text-muted-foreground">
                    {agentName ?? 'The agent'} described this step. clawboo has not verified it.
                  </figcaption>
                </figure>
              )}
            </div>
          )}
        </>
      )}

      {rememberable && (
        <label className="flex cursor-pointer items-center gap-2 text-[11.5px] text-muted-foreground">
          <input
            type="checkbox"
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
            className="size-3.5 cursor-pointer accent-[rgb(var(--primary-rgb))]"
          />
          Do not ask again for this for 30 days
        </label>
      )}

      {/* TWO buttons, and exactly one filled emphasis. The old card made both
          Allow and Deny red, which reads as two equally weighted alarms and
          leaves the safe choice unmarked. */}
      <div className="grid grid-cols-2 gap-2">
        <Button
          variant={dangerous ? 'danger' : 'solid'}
          size="sm"
          fullWidth
          className="min-h-[36px]"
          onClick={() => onResolve(approval.id, remember ? 'allow_always' : 'allow_once')}
        >
          {/* The label says what the call does, because a generic "Allow" hides the
              difference between reading an inbox and emptying it, and a WRONG
              label is worse than a generic one: this said "Send it" over a fetch
              until the verb classifier was fixed. */}
          {human.actionClass === 'sends'
            ? 'Send it'
            : human.actionClass === 'destroys'
              ? 'Delete it'
              : human.actionClass === 'reads'
                ? 'Allow read'
                : 'Allow'}
        </Button>
        <Button
          variant="outline"
          size="sm"
          fullWidth
          className="min-h-[36px] border-border-strong"
          onClick={() => onResolve(approval.id, 'deny')}
        >
          Don&apos;t allow
        </Button>
      </div>
    </motion.div>
  )
}
