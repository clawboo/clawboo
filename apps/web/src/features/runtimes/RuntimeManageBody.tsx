// The inline "Manage" body for a CONNECTED runtime — revealed by the card's
// Manage footer button. Holds (in order): the runtime's body content (its
// provider list — which now carries the ChatGPT-subscription option as a peer
// row — plus OpenClaw's MCP attach config), and an actions row with
// Re-check · Disconnect · Details. "Details" opens the read-only diagnostics
// drawer (health checks, integration); the actions live here now.
//
// Disconnect signs out on EVERY runtime, honestly per runtime:
//   - api-key (native / claude-code / hermes) → stop using its keys; delete the
//     saved ones no other runtime uses (the confirm names each, from the plan the
//     runtime's status carries).
//   - codex (oauth)   → `codex logout` (signs out the shared ChatGPT subscription).
//   - openclaw        → stop the local gateway (reversible).

import { useState, type ReactNode } from 'react'
import { ArrowRight, LogOut, RotateCcw } from 'lucide-react'

import {
  apiFetch,
  disconnectRuntime,
  signOutRuntime,
  type RuntimeId,
  type RuntimeStatus,
} from '@clawboo/control-client'

import { Button } from '@/features/shared/Button'
import { confirm } from '@/stores/confirm'
import { runtimeDisconnectMessage } from './disconnectCopy'
import { useToastStore } from '@/stores/toast'

const muted = (o: number) => `rgb(var(--foreground-rgb) / ${o})`

/** The runtime this Manage body is for — a coding RuntimeId or the OpenClaw host. */
export type ManageRuntimeId = RuntimeId | 'openclaw'

interface DisconnectCopy {
  label: string
  title: string
  message: string
  tone: 'default' | 'danger'
}

// The api-key runtimes' messages are built from the runtime's disconnect plan
// at click time (see `runtimeDisconnectMessage`), so they carry none here.
const DISCONNECT_COPY: Record<ManageRuntimeId, DisconnectCopy> = {
  'clawboo-native': {
    label: 'Disconnect',
    title: 'Disconnect Clawboo Native?',
    message: '',
    tone: 'danger',
  },
  'claude-code': {
    label: 'Disconnect',
    title: 'Disconnect Claude Code?',
    message: '',
    tone: 'danger',
  },
  hermes: {
    label: 'Disconnect',
    title: 'Disconnect Hermes?',
    message: '',
    tone: 'danger',
  },
  codex: {
    label: 'Sign out',
    title: 'Sign out of ChatGPT?',
    message:
      'This runs the Codex CLI sign-out. Any runtime using your ChatGPT subscription (OpenClaw, Hermes) loses access to it too.',
    tone: 'danger',
  },
  openclaw: {
    label: 'Disconnect',
    title: 'Stop the OpenClaw gateway?',
    message:
      'This stops the local OpenClaw gateway. Your OpenClaw agents go offline until you start it again.',
    tone: 'default',
  },
}

export interface RuntimeManageBodyProps {
  runtimeId: ManageRuntimeId
  name: string
  /** The runtime's live status: its disconnect plan names, in the confirm, the
   *  keys a Disconnect deletes and the ones it keeps. */
  status?: RuntimeStatus
  /** Re-probe after a disconnect / sub sign-in. */
  onChanged: () => void | Promise<void>
  /** Open the read-only diagnostics drawer (the "Details" affordance). */
  onDiagnostics?: () => void
  /** Body content above the actions row — the runtime's provider list (which
   *  carries the ChatGPT-subscription row) + OpenClaw's MCP attach config. */
  extra?: ReactNode
}

export function RuntimeManageBody({
  runtimeId,
  name,
  status,
  onChanged,
  onDiagnostics,
  extra,
}: RuntimeManageBodyProps) {
  const [busy, setBusy] = useState(false)
  const addToast = useToastStore((s) => s.addToast)

  async function handleDisconnect(): Promise<void> {
    const copy = DISCONNECT_COPY[runtimeId]
    const keyed = runtimeId !== 'openclaw' && runtimeId !== 'codex'
    if (
      !(await confirm({
        title: copy.title,
        message: keyed
          ? runtimeDisconnectMessage(name, status?.disconnectPlan, {
              ollama: status?.ollamaConnected === true,
            })
          : copy.message,
        confirmLabel: copy.label,
        tone: copy.tone,
      }))
    ) {
      return
    }
    setBusy(true)
    let result: { ok: boolean; error?: string }
    if (runtimeId === 'openclaw') {
      result = await apiFetch('/api/system/gateway', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'stop' }),
      })
        .then((r) => ({ ok: r.ok }) as { ok: boolean })
        .catch(() => ({ ok: false, error: 'Could not reach the server' }))
    } else if (runtimeId === 'codex') {
      result = await signOutRuntime('codex')
    } else {
      result = await disconnectRuntime(runtimeId)
    }
    setBusy(false)
    if (result.ok) {
      addToast({
        message: `${name} ${runtimeId === 'codex' ? 'signed out' : 'disconnected'}`,
        type: 'success',
      })
      void onChanged()
      // Slow-settling disconnects (the OpenClaw gateway stop, the server's operator
      // connection dropping) may still probe "connected" milliseconds after the
      // POST — re-probe once more shortly so the row flips without waiting for
      // the panel's 8s poll.
      setTimeout(() => void onChanged(), 2500)
    } else {
      addToast({ message: result.error ?? `Failed to disconnect ${name}`, type: 'error' })
    }
  }

  async function handleRecheck(): Promise<void> {
    setBusy(true)
    await onChanged()
    setBusy(false)
  }

  return (
    <div className="flex flex-col gap-3" data-testid={`runtime-${runtimeId}-manage`}>
      {extra}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="secondary"
          size="sm"
          onClick={() => void handleRecheck()}
          loading={busy}
          data-testid={`runtime-${runtimeId}-recheck`}
        >
          <RotateCcw size={13} strokeWidth={2} /> Re-check
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void handleDisconnect()}
          disabled={busy}
          data-testid={`runtime-${runtimeId}-disconnect`}
          className="text-primary/80 hover:bg-primary/[0.08] hover:text-primary"
        >
          <LogOut size={13} strokeWidth={2} /> {DISCONNECT_COPY[runtimeId].label}
        </Button>
        {onDiagnostics && (
          <button
            type="button"
            onClick={onDiagnostics}
            data-testid={`runtime-${runtimeId}-details`}
            className="ml-auto inline-flex items-center gap-1 text-[12px] font-medium transition-colors hover:text-foreground"
            style={{
              color: muted(0.5),
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
            }}
          >
            Details <ArrowRight size={12} />
          </button>
        )}
      </div>
    </div>
  )
}
