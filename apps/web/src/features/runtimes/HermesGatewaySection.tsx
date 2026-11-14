// The Hermes gateway Clawboo supervises, in the Hermes row's Manage body, like
// OpenClaw's Gateway section. Every Hermes agent runs through this one process:
// it shows whether it is running, its port, how long it has been up, the Hermes
// version, and why it stopped when it did. Restart (or Start, when it is not
// running) is the one action: Clawboo starts it on its own for a run and stops it
// with Clawboo.

import { useCallback, useEffect, useState } from 'react'
import { Play, RotateCw } from 'lucide-react'

import { apiFetch } from '@clawboo/control-client'

import { Button } from '@/features/shared/Button'
import { FormattedAlert } from '@/features/shared/FormattedAlert'
import { StatusPill } from '@/features/shared/StatusPill'
import { useToastStore } from '@/stores/toast'
import { useReadSequencer } from '@/lib/useReadSequencer'
import { useVisiblePolling } from '@/lib/useVisiblePolling'

const muted = (o: number) => `rgb(var(--foreground-rgb) / ${o})`

export interface HermesGatewayStatus {
  state: 'stopped' | 'starting' | 'running' | 'restarting' | 'failed' | 'not-installed'
  port: number | null
  pid: number | null
  startedAt: number | null
  restarts: number
  lastError: string | null
  version: string | null
}

function formatUptime(startedAt: number | null): string | null {
  if (!startedAt) return null
  const totalSec = Math.floor((Date.now() - startedAt) / 1000)
  if (totalSec <= 0) return null
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m`
  return '<1m'
}

const LABEL: Record<HermesGatewayStatus['state'], string> = {
  running: 'Running',
  starting: 'Starting',
  restarting: 'Restarting',
  stopped: 'Stopped',
  failed: 'Not running',
  'not-installed': 'Not installed',
}

export function HermesGatewaySection({
  onChanged,
}: {
  /** Re-probe the runtimes row after a start/restart so its chip stays fresh. */
  onChanged?: () => void | Promise<void>
}) {
  const addToast = useToastStore((s) => s.addToast)
  const [gw, setGw] = useState<HermesGatewayStatus | null>(null)
  const [busy, setBusy] = useState<null | 'start' | 'restart'>(null)
  const reads = useReadSequencer()

  const refresh = useCallback(async () => {
    const read = reads.beginRead()
    try {
      const data = (await apiFetch('/api/runtimes/hermes/gateway').then((r) =>
        r.json(),
      )) as HermesGatewayStatus
      if (read.isCurrent()) setGw(data)
    } catch {
      // non-fatal: the row's own status chip is the primary signal
    }
  }, [reads])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useVisiblePolling(() => void refresh(), 10_000)

  const run = useCallback(
    async (action: 'start' | 'restart') => {
      setBusy(action)
      try {
        const res = await apiFetch('/api/runtimes/hermes/gateway', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action }),
        })
        const body = (await res.json().catch(() => ({}))) as {
          error?: string
          status?: HermesGatewayStatus
        }
        if (body.status) setGw(body.status)
        if (res.ok) {
          addToast({
            message: `Hermes gateway ${action === 'restart' ? 'restarted' : 'started'}`,
            type: 'success',
          })
          void onChanged?.()
        } else {
          addToast({ message: body.error ?? `Hermes gateway ${action} failed`, type: 'error' })
        }
      } catch {
        addToast({ message: `Hermes gateway ${action} failed`, type: 'error' })
      } finally {
        setBusy(null)
        void refresh()
      }
    },
    [addToast, onChanged, refresh],
  )

  const state = gw?.state ?? 'stopped'
  const running = state === 'running'
  const uptime = running ? formatUptime(gw?.startedAt ?? null) : null
  const tone = running
    ? 'working'
    : state === 'failed'
      ? 'error'
      : state === 'starting' || state === 'restarting'
        ? 'warning'
        : 'idle'

  return (
    <div className="flex flex-col gap-2" data-testid="hermes-gateway-section">
      <span
        className="font-mono text-[10px] uppercase tracking-widest"
        style={{ color: muted(0.5) }}
      >
        Gateway
      </span>
      <div className="flex flex-wrap items-center gap-2.5 rounded-xl border border-border px-3.5 py-2.5">
        <StatusPill tone={tone} label={LABEL[state]} />
        {gw?.port ? (
          <span className="font-data text-[12px]" style={{ color: muted(0.45) }}>
            127.0.0.1:{gw.port}
          </span>
        ) : null}
        {uptime && (
          <span className="text-[12px]" style={{ color: muted(0.4) }}>
            uptime <span className="font-data">{uptime}</span>
          </span>
        )}
        {gw?.version && gw.version !== 'unknown' ? (
          <span className="font-data text-[12px]" style={{ color: muted(0.4) }}>
            v{gw.version}
          </span>
        ) : null}
        {state !== 'not-installed' &&
          (running ? (
            <Button
              variant="outline"
              size="sm"
              className="ml-auto"
              loading={busy === 'restart'}
              disabled={!!busy}
              onClick={() => void run('restart')}
              data-testid="hermes-gateway-restart"
            >
              {busy !== 'restart' && <RotateCw size={13} strokeWidth={2} />}
              Restart
            </Button>
          ) : (
            <Button
              variant="primary"
              size="sm"
              className="ml-auto"
              loading={busy === 'start' || state === 'starting' || state === 'restarting'}
              disabled={!!busy}
              onClick={() => void run('start')}
              data-testid="hermes-gateway-start"
            >
              {busy !== 'start' && <Play size={13} strokeWidth={2} />}
              Start
            </Button>
          ))}
      </div>
      {state === 'failed' && gw?.lastError ? (
        <FormattedAlert tone="error">{gw.lastError}</FormattedAlert>
      ) : null}
      <p className="text-[11.5px]" style={{ color: muted(0.45) }}>
        Hermes&apos;s own gateway, with only its API server on, on this computer. Every Hermes agent
        runs through it. Clawboo starts it when a Hermes agent works and stops it when Clawboo
        stops.
      </p>
    </div>
  )
}
