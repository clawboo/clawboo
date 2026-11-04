// UpdateChip — a subtle, dismissible "update available" chip pinned bottom-left
// (like Claude Code's). Appears when a newer `clawboo` version is published.
//
// The chip IS the action (no popover, no second click):
//   - Global npm install (applyable): one click installs clawboo@latest, restarts
//     the server into it, and reloads the page. The chip reads "Click to update".
//     When agent runs are still going once it is installed, the server waits for
//     them before it restarts; the chip says so and offers "Restart now".
//   - npx / dev (can't self-update in place): one click copies the exact command
//     (`npx clawboo@latest`) instead, since the running process can't hot-swap.
// A small × dismisses it (keyed to the latest version, so a newer release brings
// it back). The check always targets npm's single `latest`, so accumulated
// releases collapse to just the newest version, never a list.
//
// Visual: MINT accent dot ("new / available", non-alarming); the version and CTA
// are the calm muted subtext colour.

import { useCallback, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { AlertCircle, Check, Copy, X } from 'lucide-react'
import { consumeApiSSE, fetchEngineCapabilities, type SSEEvent } from '@clawboo/control-client'

import { Spinner } from '@/features/shared/Spinner'
import { useUpdateCheck } from './useUpdateCheck'

const muted = (o: number) => `rgb(var(--foreground-rgb) / ${o})`

type Phase = 'idle' | 'applying' | 'waiting' | 'restarting' | 'manual' | 'error'

/** How long to watch for the new version after losing the stream mid-wait: the
 *  server's 10-minute wait for agent runs, plus the usual 90 s for a restart. */
const WAITING_RELOAD_TIMEOUT_MS = 10 * 60_000 + 90_000

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * After the server signals it's restarting, poll the engine's capabilities until
 * an engine on a version other than `fromVersion` answers, then hard-reload onto
 * the freshly-installed UI. The version is what tells the successor apart from the
 * server that is still on its way out; any answer at all would not. Gives up after
 * ~90s and surfaces a manual note.
 */
async function pollThenReload(
  fromVersion: string,
  onTimeout: () => void,
  timeoutMs = 90_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await sleep(1000)
    // Null while the server is restarting (no answer, or not one yet).
    const caps = await fetchEngineCapabilities()
    if (caps && caps.version !== fromVersion) {
      window.location.reload()
      return
    }
  }
  onTimeout()
}

export function UpdateChip() {
  const { info, shouldShow, dismiss } = useUpdateCheck()
  const [phase, setPhase] = useState<Phase>('idle')
  const [statusText, setStatusText] = useState('')
  const [copied, setCopied] = useState(false)

  // phaseRef lets the SSE error handler tell a real failure from the expected
  // stream-drop when the server exits to restart.
  const phaseRef = useRef<Phase>('idle')
  phaseRef.current = phase

  const copyCommand = useCallback(async () => {
    if (!info) return
    try {
      await navigator.clipboard.writeText(info.updateCommand)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    } catch {
      /* clipboard blocked — nothing else to do here */
    }
  }, [info])

  const startUpdate = useCallback(() => {
    const fromVersion = info?.current ?? ''
    const onPollTimeout = (): void => {
      setStatusText('Update installed. Restart Clawboo to finish.')
      setPhase('manual')
    }
    setPhase('applying')
    setStatusText('')
    consumeApiSSE(
      '/api/system/self-update',
      { method: 'POST' },
      {
        onError: (e: SSEEvent) => {
          // The stream drops when the server exits to restart — expected, not a
          // failure. Ignore errors once we're past 'installed'.
          if (phaseRef.current === 'restarting') return
          // Lost while the server waits for agent runs: the update is installed
          // and the restart still comes, within the server's wait of up to 10
          // minutes, so keep watching for the new version.
          if (phaseRef.current === 'waiting') {
            setPhase('restarting')
            void pollThenReload(fromVersion, onPollTimeout, WAITING_RELOAD_TIMEOUT_MS)
            return
          }
          setStatusText(e.message ?? 'Update failed.')
          setPhase('error')
        },
        onEvent: (e: SSEEvent) => {
          switch (e.type) {
            case 'progress':
              // Installed, and waiting for agent runs to finish before it restarts.
              if (e.step === 'waiting') {
                setStatusText(e.message ?? 'Waiting for agent runs to finish.')
                setPhase('waiting')
              }
              break
            case 'restarting':
              setPhase('restarting')
              void pollThenReload(fromVersion, onPollTimeout)
              break
            case 'unsupported':
            case 'installed-elsewhere':
              setStatusText(
                typeof e.message === 'string'
                  ? e.message
                  : 'Update installed. Restart Clawboo to finish.',
              )
              setPhase('manual')
              break
            default:
              break
          }
        },
      },
    )
  }, [info])

  // Restart without waiting for the agent runs still going: the update waiting
  // on the first stream restarts, and that stream reports it as usual.
  const restartNow = useCallback(() => {
    consumeApiSSE(
      '/api/system/self-update',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ force: true }),
      },
      {},
    )
  }, [])

  // One click = the whole action. Global install → update in place; otherwise
  // copy the command (the running npx/dev process can't hot-swap itself).
  const handlePrimary = useCallback(() => {
    if (!info) return
    if (info.applyable) startUpdate()
    else void copyCommand()
  }, [info, startUpdate, copyCommand])

  if (!shouldShow || !info) return null

  const busy = phase === 'applying' || phase === 'waiting' || phase === 'restarting'

  return (
    <motion.div
      data-testid="update-chip"
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: 'spring', stiffness: 300, damping: 26 }}
      style={{
        position: 'fixed',
        bottom: 16,
        left: 72,
        zIndex: 50,
        display: 'flex',
        alignItems: 'stretch',
        borderRadius: 8,
        border: '1px solid var(--border)',
        background: 'var(--surface)',
        overflow: 'hidden',
      }}
    >
      {phase === 'waiting' ? (
        <div
          className="flex items-center gap-2 px-2.5 py-1.5 text-[12px]"
          style={{ color: 'var(--foreground)' }}
        >
          <span style={{ color: 'var(--mint)', display: 'flex' }}>
            <Spinner size={14} />
          </span>
          <span data-testid="update-chip-waiting" style={{ maxWidth: 220 }}>
            {statusText}
          </span>
          <button
            type="button"
            data-testid="update-chip-restart-now"
            onClick={restartNow}
            title="Restart now. Agent runs still going are stopped."
            className="transition-colors hover:bg-foreground/[0.06]"
            style={{
              border: '1px solid var(--border)',
              borderRadius: 6,
              background: 'transparent',
              color: muted(0.75),
              cursor: 'pointer',
              fontSize: 11.5,
              padding: '2px 6px',
              whiteSpace: 'nowrap',
            }}
          >
            Restart now
          </button>
        </div>
      ) : busy ? (
        <div
          className="flex items-center gap-2 px-2.5 py-1.5 text-[12.5px]"
          style={{ color: 'var(--foreground)' }}
        >
          <span style={{ color: 'var(--mint)', display: 'flex' }}>
            <Spinner size={14} />
          </span>
          {phase === 'restarting' ? 'Restarting…' : 'Installing update…'}
        </div>
      ) : phase === 'manual' || phase === 'error' ? (
        <div className="flex items-center gap-2 px-2.5 py-1.5">
          <AlertCircle
            size={14}
            style={{ color: phase === 'error' ? 'var(--primary)' : muted(0.5), flexShrink: 0 }}
          />
          <span
            className="text-[11.5px]"
            style={{ color: phase === 'error' ? 'var(--primary)' : muted(0.7), maxWidth: 190 }}
          >
            {statusText || (phase === 'error' ? 'Update failed.' : 'Update installed.')}
          </span>
          <button
            type="button"
            aria-label="Copy update command"
            data-testid="update-chip-copy"
            onClick={() => void copyCommand()}
            style={{
              border: 'none',
              background: 'transparent',
              color: copied ? 'var(--mint)' : muted(0.55),
              cursor: 'pointer',
              display: 'flex',
              padding: 2,
            }}
          >
            {copied ? <Check size={14} /> : <Copy size={14} />}
          </button>
          <button
            type="button"
            aria-label="Dismiss"
            data-testid="update-chip-dismiss"
            onClick={dismiss}
            style={{
              border: 'none',
              background: 'transparent',
              color: muted(0.4),
              cursor: 'pointer',
              display: 'flex',
              padding: 2,
            }}
          >
            <X size={13} />
          </button>
        </div>
      ) : (
        <>
          <button
            type="button"
            data-testid="update-chip-action"
            onClick={handlePrimary}
            title={
              info.applyable
                ? `Update to v${info.latest} and restart`
                : `Copy: ${info.updateCommand}`
            }
            className="group flex items-center gap-2 px-2.5 py-1.5 text-left transition-colors hover:bg-foreground/[0.03]"
            style={{ border: 'none', background: 'transparent', cursor: 'pointer' }}
          >
            <span
              aria-hidden
              style={{
                width: 7,
                height: 7,
                borderRadius: '50%',
                background: 'var(--mint)',
                flexShrink: 0,
                animation: 'clawboo-status-pulse 2s ease-in-out infinite',
              }}
            />
            <span className="flex flex-col leading-tight">
              <span className="text-[12.5px] font-semibold text-foreground">Update available</span>
              <span
                data-testid="update-chip-version"
                className="mt-0.5 text-[10.5px]"
                style={{ fontFamily: 'var(--font-mono)', color: muted(0.55) }}
              >
                v{info.latest}
                {' · '}
                {info.applyable ? (
                  <span style={{ color: muted(0.8), fontWeight: 500 }}>Click to update →</span>
                ) : copied ? (
                  <span style={{ color: 'var(--mint)', fontWeight: 500 }}>Copied ✓</span>
                ) : (
                  <span style={{ color: muted(0.8), fontWeight: 500 }}>Copy command</span>
                )}
              </span>
            </span>
          </button>
          <button
            type="button"
            aria-label="Dismiss"
            data-testid="update-chip-dismiss"
            onClick={dismiss}
            className="transition-colors hover:bg-foreground/[0.06]"
            style={{
              border: 'none',
              borderLeft: '1px solid var(--border)',
              background: 'transparent',
              color: muted(0.4),
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              padding: '0 7px',
            }}
          >
            <X size={13} />
          </button>
        </>
      )}
    </motion.div>
  )
}
