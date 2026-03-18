import { useState, useEffect, useRef, useCallback } from 'react'
import { Loader2, ChevronDown, ChevronUp } from 'lucide-react'
import { useSystemStore } from '@/stores/system'
import { consumeSSE } from '@/lib/sseClient'

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
      sseRef.current = consumeSSE(
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* Status row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        {/* Pulsing dot */}
        <span style={{ position: 'relative', display: 'inline-flex', width: 10, height: 10 }}>
          {isRunning && (
            <span
              style={{
                position: 'absolute',
                inset: 0,
                borderRadius: '50%',
                background: '#34D399',
                animation: 'pulse 1.4s ease-out infinite',
                opacity: 0.5,
              }}
            />
          )}
          <span
            style={{
              position: 'relative',
              width: 10,
              height: 10,
              borderRadius: '50%',
              background: isRunning ? '#34D399' : 'rgba(233,69,96,0.7)',
            }}
          />
        </span>

        <span style={{ fontSize: 14, fontWeight: 600, color: '#E8E8E8' }}>
          {isRunning ? 'Running' : 'Stopped'}
        </span>

        {info?.gateway.port && (
          <span
            style={{
              fontSize: 11,
              color: 'rgba(232,232,232,0.4)',
              fontFamily: 'var(--font-geist-mono, monospace)',
            }}
          >
            :{info.gateway.port}
          </span>
        )}

        {isRunning && formatUptime(info?.gateway.uptimeMs ?? null) && (
          <span style={{ fontSize: 11, color: 'rgba(232,232,232,0.35)' }}>
            uptime {formatUptime(info?.gateway.uptimeMs ?? null)}
          </span>
        )}
      </div>

      {/* Buttons */}
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          type="button"
          disabled={isRunning || isBusy}
          onClick={() => handleStartOrRestart('start')}
          style={{
            height: 32,
            padding: '0 12px',
            fontSize: 11,
            fontWeight: 600,
            borderRadius: 8,
            border: 'none',
            cursor: isRunning || isBusy ? 'default' : 'pointer',
            background: isRunning || isBusy ? 'rgba(52,211,153,0.15)' : '#34D399',
            color: isRunning || isBusy ? 'rgba(52,211,153,0.4)' : '#0A0E1A',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            transition: 'all 0.15s',
          }}
        >
          {gatewayControlStatus === 'starting' && (
            <Loader2 style={{ width: 12, height: 12, animation: 'spin 1s linear infinite' }} />
          )}
          Start
        </button>

        <button
          type="button"
          disabled={!isRunning || isBusy}
          onClick={() => void handleStop()}
          style={{
            height: 32,
            padding: '0 12px',
            fontSize: 11,
            fontWeight: 600,
            borderRadius: 8,
            border: 'none',
            cursor: !isRunning || isBusy ? 'default' : 'pointer',
            background: !isRunning || isBusy ? 'rgba(251,191,36,0.15)' : '#FBBF24',
            color: !isRunning || isBusy ? 'rgba(251,191,36,0.4)' : '#0A0E1A',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            transition: 'all 0.15s',
          }}
        >
          {gatewayControlStatus === 'stopping' && (
            <Loader2 style={{ width: 12, height: 12, animation: 'spin 1s linear infinite' }} />
          )}
          Stop
        </button>

        <button
          type="button"
          disabled={!isRunning || isBusy}
          onClick={() => handleStartOrRestart('restart')}
          style={{
            height: 32,
            padding: '0 12px',
            fontSize: 11,
            fontWeight: 600,
            borderRadius: 8,
            border: 'none',
            cursor: !isRunning || isBusy ? 'default' : 'pointer',
            background: !isRunning || isBusy ? 'rgba(233,69,96,0.15)' : '#E94560',
            color: !isRunning || isBusy ? 'rgba(233,69,96,0.4)' : '#fff',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            transition: 'all 0.15s',
          }}
        >
          Restart
        </button>
      </div>

      {/* Collapsible log */}
      {gatewayLog.length > 0 && (
        <div>
          <button
            type="button"
            onClick={() => setShowLog((v) => !v)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              fontSize: 11,
              color: 'rgba(232,232,232,0.4)',
              padding: 0,
            }}
          >
            {showLog ? (
              <ChevronUp style={{ width: 12, height: 12 }} />
            ) : (
              <ChevronDown style={{ width: 12, height: 12 }} />
            )}
            {showLog ? 'Hide log' : 'Show log'}
          </button>

          {showLog && (
            <div
              style={{
                marginTop: 8,
                background: 'rgba(255,255,255,0.03)',
                border: '1px solid rgba(255,255,255,0.06)',
                borderRadius: 8,
                padding: '10px 12px',
                maxHeight: 180,
                overflowY: 'auto',
                fontFamily: 'var(--font-geist-mono, monospace)',
                fontSize: 11,
                lineHeight: 1.6,
                color: 'rgba(232,232,232,0.55)',
              }}
            >
              {gatewayLog.map((line, i) => (
                <div key={i}>{line}</div>
              ))}
              <div ref={logEndRef} />
            </div>
          )}
        </div>
      )}

      {/* CSS animation for pulsing dot */}
      <style>{`
        @keyframes pulse {
          0% { transform: scale(1); opacity: 0.6; }
          100% { transform: scale(2); opacity: 0; }
        }
      `}</style>
    </div>
  )
}
