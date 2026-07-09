import { useCallback, useState } from 'react'
import { motion } from 'framer-motion'
import { CheckCircle2, ShieldCheck } from 'lucide-react'
import { Button } from '@/features/shared/Button'

// ─── Types ────────────────────────────────────────────────────────────────────

export type DevicePairingApprovalProps = {
  /**
   * Called after a successful approval — caller is responsible for retrying
   * the failed Gateway connect attempt.
   */
  onApproved: () => void
  /** Optional cancel handler (e.g. to return to the connect form). */
  onCancel?: () => void
}

type Phase = 'idle' | 'approving' | 'approved' | 'error'

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * Renders an inline "Approve this device" UI when the WebSocket connect
 * fails with `code === 'NOT_PAIRED'`. Triggered by `GatewayConnectScreen`
 * and `GatewayBootstrap` when OpenClaw 2026.5.x rejects the proxy's device
 * because it hasn't been approved yet.
 *
 * Single button → `POST /api/system/approve-device` → on 200, calls
 * `onApproved` so the caller can retry the connect.
 */
export function DevicePairingApproval({ onApproved, onCancel }: DevicePairingApprovalProps) {
  const [phase, setPhase] = useState<Phase>('idle')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const handleApprove = useCallback(async () => {
    setPhase('approving')
    setErrorMessage(null)
    try {
      const res = await fetch('/api/system/approve-device', { method: 'POST' })
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean
        error?: string
        details?: string
      }
      if (!res.ok || !data.ok) {
        setErrorMessage(
          data.error ||
            data.details ||
            `Approval failed (HTTP ${res.status}). Check that OpenClaw is installed and the Gateway is running.`,
        )
        setPhase('error')
        return
      }
      setPhase('approved')
      // Brief success flash, then hand off to caller to retry the connect.
      setTimeout(() => {
        onApproved()
      }, 700)
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err))
      setPhase('error')
    }
  }, [onApproved])

  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18 }}
      className="flex flex-col gap-4"
      data-testid="device-pairing-approval"
    >
      {/* Header */}
      <div className="flex items-start gap-3">
        <div
          className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl"
          style={{
            background: 'rgb(var(--primary-rgb) / 0.1)',
            boxShadow: '0 0 0 1px rgb(var(--primary-rgb) / 0.2)',
          }}
        >
          <ShieldCheck className="h-4 w-4 text-primary" strokeWidth={2.25} />
        </div>
        <div className="flex flex-col gap-1">
          <h2 className="text-[15px] font-semibold text-foreground" style={{ letterSpacing: '-0.01em' }}>
            Approve this device
          </h2>
          <p className="text-[12px] leading-snug text-foreground/50">
            OpenClaw 2026.5+ requires you to approve new devices before they can connect. This is a
            one-time step on this machine.
          </p>
        </div>
      </div>

      {/* Status / error */}
      {phase === 'error' && errorMessage && (
        <div
          role="alert"
          data-testid="device-pairing-error"
          className="rounded-xl border border-destructive/25 bg-destructive/[0.08] px-3.5 py-2.5 text-[12px] leading-snug text-destructive"
        >
          {errorMessage}
        </div>
      )}

      {phase === 'approved' && (
        <div
          role="status"
          className="flex items-center gap-2 rounded-xl border px-3.5 py-2.5 text-[12px] leading-snug text-mint"
          style={{
            background: 'rgb(var(--mint-rgb) / 0.08)',
            borderColor: 'rgb(var(--mint-rgb) / 0.25)',
          }}
        >
          <CheckCircle2 className="h-3.5 w-3.5" strokeWidth={2.5} />
          Approved. Reconnecting…
        </div>
      )}

      {/* Actions */}
      <div className="flex gap-2">
        <Button
          variant="primary"
          size="lg"
          fullWidth
          loading={phase === 'approving'}
          disabled={phase === 'approving' || phase === 'approved'}
          onClick={() => void handleApprove()}
          data-testid="device-pairing-approve-button"
        >
          {phase === 'approved' && <CheckCircle2 className="h-4 w-4" strokeWidth={2.5} />}
          {phase === 'approving'
            ? 'Approving…'
            : phase === 'approved'
              ? 'Approved'
              : 'Approve this device'}
        </Button>
        {onCancel && phase !== 'approving' && phase !== 'approved' && (
          <Button
            variant="outline"
            size="lg"
            onClick={onCancel}
            data-testid="device-pairing-cancel-button"
          >
            Cancel
          </Button>
        )}
      </div>

      {/* Footer hint — how to do it manually */}
      <p className="font-mono text-[10px] leading-relaxed text-foreground/40">
        Or from your terminal:{' '}
        <code className="rounded bg-foreground/[0.05] px-1 py-0.5 text-foreground/60">
          openclaw devices approve --latest
        </code>{' '}
        then{' '}
        <code className="rounded bg-foreground/[0.05] px-1 py-0.5 text-foreground/60">
          openclaw devices approve &lt;requestId&gt;
        </code>
        .
      </p>
    </motion.div>
  )
}
