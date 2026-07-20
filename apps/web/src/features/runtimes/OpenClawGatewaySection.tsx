// The OpenClaw Gateway process controls, folded into the OpenClaw runtime row's
// Manage body — this is the OpenClaw runtime's home now (the System panel no
// longer carries a generic "Gateway" section). Shows the live Running/Stopped
// status + port + uptime and a Restart button. Stopping the gateway is the
// row's "Disconnect" action, and starting it from scratch is the row's
// "Reconnect" (offline) flow, so this section only needs Restart + status — a
// standalone Start appears solely as a defensive affordance if the gateway
// happened to die while the body is open.

import { useCallback, useEffect, useRef, useState } from 'react'
import { Play, RotateCw } from 'lucide-react'

import { consumeApiSSE } from '@clawboo/control-client'

import { Button } from '@/features/shared/Button'
import { StatusPill } from '@/features/shared/StatusPill'
import { useToastStore } from '@/stores/toast'

const muted = (o: number) => `rgb(var(--foreground-rgb) / ${o})`

function formatUptime(ms: number | null): string | null {
  if (ms == null || ms <= 0) return null
  const totalSec = Math.floor(ms / 1000)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m`
  return '<1m'
}

interface GatewayState {
  running: boolean
  port: number
  uptimeMs: number | null
}

export function OpenClawGatewaySection({
  onChanged,
}: {
  /** Re-probe the runtimes row after a start/restart so its chip stays fresh. */
  onChanged?: () => void | Promise<void>
}) {
  const addToast = useToastStore((s) => s.addToast)
  const [gw, setGw] = useState<GatewayState | null>(null)
  const [busy, setBusy] = useState<null | 'start' | 'restart'>(null)
  const sseRef = useRef<AbortController | null>(null)

  const refresh = useCallback(async () => {
    try {
      const data = (await fetch('/api/system/status').then((r) => r.json())) as {
        gateway?: GatewayState
      }
      if (data.gateway) setGw(data.gateway)
    } catch {
      // non-fatal — the row's own status chip is the primary signal
    }
  }, [])

  useEffect(() => {
    void refresh()
    const id = setInterval(() => void refresh(), 10_000)
    return () => {
      clearInterval(id)
      sseRef.current?.abort()
    }
  }, [refresh])

  const run = useCallback(
    (action: 'start' | 'restart') => {
      setBusy(action)
      sseRef.current?.abort()
      sseRef.current = consumeApiSSE(
        '/api/system/gateway',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action }),
        },
        {
          onComplete: (e) => {
            setBusy(null)
            if (e.success) {
              addToast({
                message: `Gateway ${action === 'restart' ? 'restarted' : 'started'}`,
                type: 'success',
              })
              void refresh()
              void onChanged?.()
            } else {
              addToast({ message: `Gateway ${action} failed`, type: 'error' })
            }
          },
          onError: (e) => {
            setBusy(null)
            addToast({ message: e.message ?? `Gateway ${action} failed`, type: 'error' })
          },
        },
      )
    },
    [refresh, onChanged, addToast],
  )

  const running = gw?.running ?? false
  const uptime = running ? formatUptime(gw?.uptimeMs ?? null) : null

  return (
    <div className="flex flex-col gap-2" data-testid="openclaw-gateway-section">
      <span
        className="font-mono text-[10px] uppercase tracking-widest"
        style={{ color: muted(0.5) }}
      >
        Gateway
      </span>
      <div className="flex flex-wrap items-center gap-2.5 rounded-xl border border-border px-3.5 py-2.5">
        <StatusPill tone={running ? 'working' : 'idle'} label={running ? 'Running' : 'Stopped'} />
        {gw?.port ? (
          <span className="font-data text-[12px]" style={{ color: muted(0.45) }}>
            :{gw.port}
          </span>
        ) : null}
        {uptime && (
          <span className="text-[12px]" style={{ color: muted(0.4) }}>
            uptime <span className="font-data">{uptime}</span>
          </span>
        )}
        {running ? (
          <Button
            variant="outline"
            size="sm"
            className="ml-auto"
            loading={busy === 'restart'}
            disabled={!!busy}
            onClick={() => run('restart')}
            data-testid="openclaw-gateway-restart"
          >
            {busy !== 'restart' && <RotateCw size={13} strokeWidth={2} />}
            Restart
          </Button>
        ) : (
          <Button
            variant="primary"
            size="sm"
            className="ml-auto"
            loading={busy === 'start'}
            disabled={!!busy}
            onClick={() => run('start')}
            data-testid="openclaw-gateway-start"
          >
            {busy !== 'start' && <Play size={13} strokeWidth={2} />}
            Start
          </Button>
        )}
      </div>
    </div>
  )
}
