// What a paused item shows wherever it shows: that it is paused, who or what paused
// it, and a Resume. `PauseToggle` is the button that pauses or resumes one thing from
// a header, for the screens with no right-click menu.

import { useState } from 'react'
import { Pause, Play } from 'lucide-react'

import { confirm } from '@/stores/confirm'
import {
  pausedByWords,
  pauseSubjectWords,
  pauseTarget,
  usePauseStore,
  type PauseKind,
  type PauseTarget,
  type PauseView,
} from '@/stores/pauses'
import { useToastStore } from '@/stores/toast'

/** Ask, then pause. Says what happens to the work, since runs stop at once. */
export async function pauseWithConfirm(target: PauseTarget, name: string): Promise<boolean> {
  const what =
    target.kind === 'agent'
      ? { title: `Pause ${name}?`, of: 'Its' }
      : target.kind === 'team'
        ? { title: `Pause the ${name} team?`, of: 'Its' }
        : { title: 'Pause this task and the tasks under it?', of: 'Their' }
  const ok = await confirm({
    title: what.title,
    message: `${what.of} runs stop now, and nothing new starts until you resume. Tasks keep their agents and start again on resume.`,
    confirmLabel: 'Pause',
  })
  if (!ok) return false
  const paused = await usePauseStore.getState().pause(target)
  useToastStore.getState().addToast({
    type: paused ? 'success' : 'error',
    message: paused
      ? 'Paused. Nothing new starts until you resume.'
      : 'Could not pause. Try again.',
  })
  return paused
}

export async function resumeWithToast(target: PauseTarget): Promise<boolean> {
  const resumed = await usePauseStore.getState().resume(target)
  useToastStore.getState().addToast({
    type: resumed ? 'success' : 'error',
    message: resumed ? 'Resumed. Waiting work starts again.' : 'Could not resume. Try again.',
  })
  return resumed
}

/** The banner on a paused agent's chat, a paused team's chat and a paused task. */
export function PausedNotice({
  pause,
  note,
  onChanged,
}: {
  pause: PauseView
  /** One more thing to say, such as what this pause does not cover. */
  note?: string
  onChanged?: () => void
}) {
  const [busy, setBusy] = useState(false)
  return (
    <div
      role="status"
      data-testid="paused-notice"
      className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-border bg-foreground/[0.03] px-4 py-2.5 text-[13px] text-foreground"
    >
      <Pause size={14} strokeWidth={2} aria-hidden className="shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 basis-48">
        <span className="font-medium">{pauseSubjectWords(pause)}.</span>{' '}
        <span className="text-muted-foreground">
          {pausedByWords(pause)}
          {pause.reason ? `: ${pause.reason.replace(/\.$/, '')}.` : '.'} {note ?? ''}
        </span>
      </span>
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          setBusy(true)
          void resumeWithToast(pauseTarget(pause)).finally(() => {
            setBusy(false)
            onChanged?.()
          })
        }}
        className="inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border border-border bg-surface px-2.5 py-1 text-[12px] font-medium text-foreground transition-colors hover:bg-foreground/[0.06] disabled:cursor-default disabled:opacity-60"
      >
        <Play size={12} strokeWidth={2} aria-hidden />
        Resume
      </button>
    </div>
  )
}

/** A small button that pauses one thing, or resumes it when its own pause holds it.
 *  An agent covered by its team's pause is resumed from the team: its banner says so. */
export function PauseToggle({
  target,
  name,
  ownPause,
  onChanged,
  compact = false,
  className = '',
}: {
  target: PauseTarget
  name: string
  /** The pause on this very thing, not one covering it from above. */
  ownPause: PauseView | null
  onChanged?: () => void
  /** The icon alone, for a tight header. Its name stays for a screen reader. */
  compact?: boolean
  className?: string
}) {
  const [busy, setBusy] = useState(false)
  const label = `${ownPause ? 'Resume' : 'Pause'} ${TARGET_WORD[target.kind](name)}`
  const Icon = ownPause ? Play : Pause
  return (
    <button
      type="button"
      disabled={busy}
      aria-label={label}
      title={label}
      data-testid="pause-toggle"
      onClick={() => {
        setBusy(true)
        const acting = ownPause ? resumeWithToast(target) : pauseWithConfirm(target, name)
        void acting.finally(() => {
          setBusy(false)
          onChanged?.()
        })
      }}
      className={`inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-lg px-1.5 py-1 text-[12px] text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground disabled:cursor-default disabled:opacity-60 ${className}`}
    >
      <Icon size={14} strokeWidth={2} aria-hidden />
      <span className={compact ? 'sr-only' : 'max-sm:sr-only'}>
        {ownPause ? 'Resume' : 'Pause'}
      </span>
    </button>
  )
}

const TARGET_WORD: Record<PauseTarget['kind'], (name: string) => string> = {
  agent: (name) => name,
  team: (name) => `the ${name} team`,
  task: () => 'this task and the tasks under it',
}

/** The pause on this very thing, if any. */
export function ownPauseOf(
  pauses: readonly PauseView[],
  kind: PauseKind,
  id: string,
): PauseView | null {
  return pauses.find((p) => p.kind === kind && p.id === id) ?? null
}
