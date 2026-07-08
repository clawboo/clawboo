import { useState, useEffect, useRef, useCallback } from 'react'
import { ChevronDown, ChevronUp, Play, RotateCw, Square } from 'lucide-react'
import { useSystemStore } from '@/stores/system'
import { consumeApiSSE } from '@clawboo/control-client'
import { Button } from '@/features/shared/Button'
import { StatusPill } from '@/features/shared/StatusPill'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatUptime(ms: number | null): string | null {
  if (ms == null || ms <= 0) return null
  const totalSec = Math.floor(ms / 1000)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m`
  return '<1m'
}

async function fetchStatus() {
  const res = await fetch('/api/system/status')
  return res.json() as Promise<{
    node: { version: string; major: number; sufficient: boolean; path: string }
    openclaw: {
      installed: boolean
      version: string | null
      path: string | null
      stateDir: string
      configExists: boolean
      envExists: boolean
    }
    gateway: {
      running: boolean
      port: number
      pid: number | null
      managedByClawboo: boolean
      uptimeMs: number | null
    }
  }>
}

// ─── Component ───────────────────────────────────────────────────────────────

export function GatewayControls() {
  const info = useSystemStore((s) => s.info)
  const gatewayControlStatus = useSystemStore((s) => s.gatewayControlStatus)
  const gatewayLog = useSystemStore((s) => s.gatewayLog)

  const [showLog, setShowLog] = useState(false)
  const logEndRef = useRef<HTMLDivElement>(null)
  const sseRef = useRef<AbortController | null>(null)

  const refreshStatus = useCallback(async () => {
    try {
      const data = await fetchStatus()
      useSystemStore.getState().setInfo(data)
    } catch {
      // non-fatal
    }
  }, [])

  // Initial fetch + polling
  useEffect(() => {
    void refreshStatus()
    const id = setInterval(() => void refreshStatus(), 10_000)
    return () => {
      clearInterval(id)
      sseRef.current?.abort()
    }
  }, [refreshStatus])

  // Auto-scroll log
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [gatewayLog.length])

  const isRunning = info?.gateway.running ?? false
  const isBusy = gatewayControlStatus === 'starting' || gatewayControlStatus === 'stopping'

  const handleStartOrRestart = useCallback(
    (action: 'start' | 'restart') => {
      const store = useSystemStore.getState()
      store.clearGatewayLog()
      store.setGatewayControlStatus('starting')

      sseRef.current?.abort()
      sseRef.current = consumeApiSSE(
        '/api/system/gateway',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action }),
        },
        {
          onProgress: (e) => {
            if (e.message) store.appendGatewayLog(e.message)
          },
          onOutput: (e) => {
            if (e.line) store.appendGatewayLog(e.line)
          },
          onComplete: (e) => {
            store.setGatewayControlStatus(e.success ? 'running' : 'error')
            if (e.success) void refreshStatus()
          },
          onError: (e) => {
            store.setGatewayControlStatus('error')
            if (e.message) store.appendGatewayLog(`Error: ${e.message}`)
          },
        },
      )
    },
    [refreshStatus],
  )

  const handleStop = useCallback(async () => {
    const store = useSystemStore.getState()
    store.clearGatewayLog()
    store.setGatewayControlStatus('stopping')
    try {
      const res = await fetch('/api/system/gateway', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'stop' }),
      })
      const data = (await res.json()) as { ok?: boolean; stopped?: boolean; message?: string }
      store.setGatewayControlStatus(data.stopped ? 'stopped' : 'error')
      if (data.message) store.appendGatewayLog(data.message)
      void refreshStatus()
    } catch (err) {
      store.setGatewayControlStatus('error')
      store.appendGatewayLog(err instanceof Error ? err.message : 'Stop failed')
    }
  }, [refreshStatus])

  return (
    <div className="flex flex-col gap-4">
      {/* Status row */}
      <div className="flex flex-wrap items-center gap-2.5">
        <StatusPill
          tone={isRunning ? 'working' : 'idle'}
          label={isRunning ? 'Running' : 'Stopped'}
        />

        {info?.gateway.port && (
          <span className="font-data text-[12px] text-foreground/45">:{info.gateway.port}</span>
        )}

        {isRunning && formatUptime(info?.gateway.uptimeMs ?? null) && (
          <span className="text-[12px] text-foreground/40">
            uptime{' '}
            <span className="font-data">{formatUptime(info?.gateway.uptimeMs ?? null)}</span>
          </span>
        )}
      </div>

      {/* Buttons */}
      <div className="flex gap-2">
        <Button
          variant="primary"
          size="sm"
          disabled={isRunning || isBusy}
          loading={gatewayControlStatus === 'starting'}
          onClick={() => handleStartOrRestart('start')}
        >
          {gatewayControlStatus !== 'starting' && <Play size={14} strokeWidth={2} />}
          Start
        </Button>

        <Button
          variant="secondary"
          size="sm"
          disabled={!isRunning || isBusy}
          loading={gatewayControlStatus === 'stopping'}
          onClick={() => void handleStop()}
        >
          {gatewayControlStatus !== 'stopping' && <Square size={14} strokeWidth={2} />}
          Stop
        </Button>

        <Button
          variant="outline"
          size="sm"
          disabled={!isRunning || isBusy}
          onClick={() => handleStartOrRestart('restart')}
        >
          <RotateCw size={14} strokeWidth={2} />
          Restart
        </Button>
      </div>

      {/* Collapsible log */}
      {gatewayLog.length > 0 && (
        <div>
          <Button variant="ghost" size="sm" onClick={() => setShowLog((v) => !v)}>
            {showLog ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
            {showLog ? 'Hide log' : 'Show log'}
          </Button>

          {showLog && (
            <div
              className="font-data mt-2 max-h-[180px] overflow-y-auto rounded-xl border border-border p-3 text-[11px] leading-relaxed text-foreground/60"
              style={{ background: 'var(--terminal-bg)', color: 'rgba(201,209,217,0.72)' }}
            >
              {gatewayLog.map((line, i) => (
                <div key={i}>{line}</div>
              ))}
              <div ref={logEndRef} />
            </div>
          )}
        </div>
      )}
    </div>
  )
}
