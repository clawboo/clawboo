// First-run nudge — a brief, dismissible "next step" card on the post-onboarding
// dashboard. Renders only when the user hasn't dismissed it AND has 0 completed
// board tasks; auto-dismisses on the first task completion. The dismiss persists
// to ~/.clawboo/settings.json (firstRunDismissedAt) via the shared settings POST
// — no second settings writer.

import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Rocket, X } from 'lucide-react'

import { useViewStore } from '@/stores/view'

const muted = (o: number) => `rgb(var(--foreground-rgb) / ${o})`

async function countCompletedTasks(): Promise<number> {
  try {
    const res = await fetch('/api/board?status=done')
    if (!res.ok) return 0
    const body = (await res.json()) as { tasks?: unknown[] }
    return Array.isArray(body.tasks) ? body.tasks.length : 0
  } catch {
    return 0
  }
}

async function persistDismiss(): Promise<void> {
  try {
    await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ firstRunDismissedAt: Date.now() }),
    })
  } catch {
    /* best-effort */
  }
}

export function FirstRunNudge() {
  const [show, setShow] = useState(false)
  const navigateTo = useViewStore((s) => s.navigateTo)

  // Decide visibility once on mount: not previously dismissed AND no completed work.
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const settings = (await (await fetch('/api/settings')).json()) as {
          firstRunDismissedAt?: number | null
        }
        if (settings.firstRunDismissedAt != null) return
        const completed = await countCompletedTasks()
        if (alive && completed === 0) setShow(true)
      } catch {
        /* don't show on error */
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  // Auto-dismiss on the first completed task (poll only while shown).
  useEffect(() => {
    if (!show) return
    const id = setInterval(() => {
      void (async () => {
        if ((await countCompletedTasks()) > 0) {
          setShow(false)
          void persistDismiss()
        }
      })()
    }, 15_000)
    return () => clearInterval(id)
  }, [show])

  function dismiss(): void {
    setShow(false)
    void persistDismiss()
  }

  return (
    <AnimatePresence>
      {show && (
        <motion.div
          data-testid="first-run-nudge"
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 16 }}
          transition={{ type: 'spring', stiffness: 300, damping: 26 }}
          className="surface-overlay-tier"
          style={{
            position: 'fixed',
            bottom: 18,
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 50,
            width: 'min(440px, calc(100vw - 32px))',
            borderRadius: 12,
            padding: '14px 16px',
            display: 'flex',
            gap: 12,
            alignItems: 'flex-start',
          }}
        >
          <span
            aria-hidden
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 32,
              height: 32,
              borderRadius: 9,
              flexShrink: 0,
              color: 'var(--mint)',
              background: 'rgb(var(--mint-rgb) / 0.12)',
            }}
          >
            <Rocket size={16} />
          </span>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--foreground)' }}>
              Your team is ready
            </div>
            <div style={{ fontSize: 11.5, color: muted(0.6), lineHeight: 1.5, marginTop: 2 }}>
              Add a task on the Board and assign it to a runtime — then watch your team pick it up
              and collaborate.
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
              <button
                type="button"
                data-testid="first-run-open-board"
                onClick={() => {
                  navigateTo('board')
                  dismiss()
                }}
                className="rounded-lg px-3 py-1.5 text-[12px] font-semibold transition-[filter,transform] active:scale-[0.98]"
                style={{
                  background: 'var(--primary)',
                  color: 'var(--primary-foreground)',
                  border: 'none',
                  cursor: 'pointer',
                }}
              >
                Open the Board
              </button>
              <button
                type="button"
                data-testid="first-run-dismiss"
                onClick={dismiss}
                className="rounded-lg px-3 py-1.5 text-[12px] font-semibold transition-colors hover:bg-foreground/[0.06]"
                style={{
                  background: 'transparent',
                  color: muted(0.6),
                  border: '1px solid rgb(var(--foreground-rgb) / 0.1)',
                  cursor: 'pointer',
                }}
              >
                Got it
              </button>
            </div>
          </div>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={dismiss}
            style={{
              border: 'none',
              background: 'transparent',
              color: muted(0.4),
              cursor: 'pointer',
              display: 'flex',
              flexShrink: 0,
            }}
          >
            <X size={15} />
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
