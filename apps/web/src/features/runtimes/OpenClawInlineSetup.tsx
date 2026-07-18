// Compact, IN-PLACE OpenClaw setup — runs inside the OpenClaw tab pane (Settings
// Runtimes + onboarding Add-runtimes) instead of navigating to a separate full-
// screen flow. It REUSES the provider key already connected (native onboarding /
// Providers hub) via POST /api/system/auto-configure-openclaw, so it NEVER re-asks
// for an LLM key: detect → (install if needed) → start Gateway → connect. Only if
// nothing is connected does it fall back to a compact key prompt.
//
// Drives the existing SSE endpoints (install, gateway start) + the shared connect
// helper; NOT_PAIRED is handled inline via DevicePairingApproval. Onboarding passes
// `onConnected` so the wizard tracks the client itself (staying in the wizard);
// Settings omits it → enterGatewayMode surfaces the client globally.

import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowRight, Check, Eye, EyeOff, Loader2, Terminal } from 'lucide-react'

import type { GatewayClient } from '@clawboo/gateway-client'
import { GatewayResponseError } from '@clawboo/gateway-client'
import { connectProvider, consumeApiSSE } from '@clawboo/control-client'

import { connectGatewayFromSettings } from '@/lib/gatewayConnect'
import { enterGatewayMode } from '@/features/connection/GatewayBootstrap'
import { DevicePairingApproval } from '@/features/connection/DevicePairingApproval'
import { Button } from '@/features/shared/Button'
import { FormattedAlert } from '@/features/shared/FormattedAlert'
import { Select } from '@/features/shared/Select'
import { ProviderIcon, type ProviderId } from '@/features/onboarding/ProviderIcon'
import { ChatGptSignIn } from './ChatGptSignIn'
import { InstalledAck } from './InstalledAck'

const muted = (o: number) => `rgb(var(--foreground-rgb) / ${o})`

type Phase =
  | 'preparing'
  | 'needs-key'
  | 'needs-codex-auth'
  | 'installing'
  | 'starting'
  | 'pairing'
  | 'connected'
  | 'error'

export interface OpenClawInlineSetupProps {
  /** Called with the live client on connect. When provided (onboarding) the host
   *  wires it into its OWN client state instead of the global enterGatewayMode
   *  (which would exit the wizard). Settings omits it. */
  onConnected?: (client: GatewayClient, gatewayUrl: string) => void
  /** Setup connected successfully — collapse the inline setup. */
  onFinish: () => void
  /** User cancelled the setup. */
  onCancel: () => void
}

const KEY_PROVIDERS: { id: ProviderId; name: string; placeholder: string }[] = [
  { id: 'anthropic', name: 'Anthropic', placeholder: 'sk-ant-…' },
  { id: 'openai', name: 'OpenAI', placeholder: 'sk-…' },
  { id: 'openrouter', name: 'OpenRouter', placeholder: 'sk-or-…' },
]

export function OpenClawInlineSetup({ onConnected, onFinish, onCancel }: OpenClawInlineSetupProps) {
  const [phase, setPhase] = useState<Phase>('preparing')
  const [log, setLog] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [keyProvider, setKeyProvider] = useState<ProviderId>('anthropic')
  const [apiKey, setApiKey] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [busy, setBusy] = useState(false)
  const [codexLoginCommand, setCodexLoginCommand] = useState(
    'openclaw models auth login --provider openai-codex',
  )
  // Set only when THIS run installed the OpenClaw binary → the "installed" ack.
  const [justInstalled, setJustInstalled] = useState(false)
  const firedRef = useRef(false)

  const appendLog = useCallback((line?: string) => {
    if (line) setLog((prev) => [...prev, line].slice(-200))
  }, [])

  // Drive one SSE endpoint to completion. Resolves on `complete{success:true}`,
  // rejects otherwise. (No abort on unmount — an install runs to completion
  // server-side regardless, matching the RuntimeConnectionCard pattern.)
  const runSSE = useCallback(
    (path: string, body: unknown): Promise<void> =>
      new Promise((resolve, reject) => {
        consumeApiSSE(
          path,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          },
          {
            onProgress: (e) => appendLog(typeof e.message === 'string' ? e.message : undefined),
            onOutput: (e) => appendLog(typeof e.line === 'string' ? e.line : undefined),
            onComplete: (e) => (e.success ? resolve() : reject(new Error('step failed'))),
            onError: (e) =>
              reject(new Error(typeof e.message === 'string' ? e.message : 'step failed')),
          },
        )
      }),
    [appendLog],
  )

  const connectAndFinish = useCallback(async () => {
    try {
      const { client, gatewayUrl } = await connectGatewayFromSettings()
      if (onConnected) onConnected(client, gatewayUrl)
      else await enterGatewayMode(client, gatewayUrl)
      setPhase('connected')
      setTimeout(() => onFinish(), 900)
    } catch (e) {
      if (e instanceof GatewayResponseError && e.code === 'NOT_PAIRED') {
        setPhase('pairing')
        return
      }
      throw e
    }
  }, [onConnected, onFinish])

  const run = useCallback(async () => {
    setError(null)
    try {
      setPhase('preparing')
      // Reuse an already-connected credential — a provider key, or an existing
      // OpenClaw ChatGPT-subscription (openai-codex) auth profile.
      const auto = (await fetch('/api/system/auto-configure-openclaw', { method: 'POST' })
        .then((r) => r.json())
        .catch(() => ({ ok: false, needsKey: true }))) as {
        ok?: boolean
        needsKey?: boolean
        needsCodexAuth?: boolean
        loginCommand?: string
      }
      if (!auto.ok) {
        if (auto.needsCodexAuth) {
          // The subscription EXISTS (codex login) but OpenClaw needs its OWN
          // sign-in — which needs the BINARY, so ensure the install FIRST
          // (showing `openclaw models auth login …` with no openclaw is useless).
          if (typeof auto.loginCommand === 'string' && auto.loginCommand) {
            setCodexLoginCommand(auto.loginCommand)
          }
          const st = (await fetch('/api/system/status')
            .then((r) => r.json())
            .catch(() => null)) as { openclaw?: { installed?: boolean } } | null
          if (!st?.openclaw?.installed) {
            setPhase('installing')
            await runSSE('/api/system/install-openclaw', {})
            setJustInstalled(true) // acknowledge the install in the sign-in panel
          }
          setPhase('needs-codex-auth')
          return
        }
        setPhase('needs-key')
        return
      }
      const status = (await fetch('/api/system/status')
        .then((r) => r.json())
        .catch(() => null)) as { openclaw?: { installed?: boolean } } | null
      if (!status?.openclaw?.installed) {
        setPhase('installing')
        await runSSE('/api/system/install-openclaw', {})
      }
      setPhase('starting')
      await runSSE('/api/system/gateway', { action: 'start' })
      await connectAndFinish()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setPhase('error')
    }
  }, [runSSE, connectAndFinish])

  // Fire once on mount (StrictMode-safe).
  useEffect(() => {
    if (firedRef.current) return
    firedRef.current = true
    void run()
  }, [run])

  const handleConnectKey = useCallback(async () => {
    const key = apiKey.trim()
    if (!key) return
    setBusy(true)
    setError(null)
    const r = await connectProvider(keyProvider, key)
    setBusy(false)
    if (!r.ok) {
      setError(r.error ?? 'Failed to save the key')
      return
    }
    setApiKey('')
    void run() // a key now exists → auto-configure succeeds
  }, [apiKey, keyProvider, run])

  const busyPhase = phase === 'preparing' || phase === 'installing' || phase === 'starting'
  const busyLabel =
    phase === 'preparing'
      ? 'Preparing OpenClaw…'
      : phase === 'installing'
        ? 'Installing OpenClaw…'
        : 'Starting the Gateway…'

  return (
    <div className="flex flex-col gap-3.5" data-testid="openclaw-inline-setup">
      <div className="flex items-center justify-between">
        <span className="text-[13.5px] font-semibold text-foreground">Set up OpenClaw</span>
        {phase !== 'connected' && (
          <Button variant="ghost" size="sm" onClick={onCancel} data-testid="openclaw-inline-cancel">
            Cancel
          </Button>
        )}
      </div>

      {busyPhase && (
        <span className="flex items-center gap-2 text-[12.5px]" style={{ color: muted(0.6) }}>
          <Loader2 size={14} className="animate-spin" /> {busyLabel}
        </span>
      )}

      {(phase === 'installing' || phase === 'starting') && (log.length > 0 || true) && (
        <div
          className="overflow-y-auto rounded-lg p-2.5"
          style={{ maxHeight: 150, background: 'var(--terminal-bg, #0d1117)' }}
        >
          {log.length === 0 ? (
            <div
              className="flex items-center gap-1.5 font-mono text-[11px]"
              style={{ color: 'rgb(201 209 217 / 0.7)' }}
            >
              <Terminal size={11} /> Working…
            </div>
          ) : (
            log.map((line, i) => (
              <div
                key={i}
                className="font-mono text-[11px] leading-relaxed"
                style={{ color: 'rgb(201 209 217 / 0.7)' }}
              >
                {line}
              </div>
            ))
          )}
        </div>
      )}

      {phase === 'needs-key' && (
        <div className="flex flex-col gap-2.5">
          <p className="text-[12px] leading-relaxed" style={{ color: muted(0.55) }}>
            Connect a provider key for OpenClaw to use. It powers the local Gateway.
          </p>
          <div className="flex items-center gap-2">
            <ProviderIcon id={keyProvider} size={32} />
            <Select
              value={keyProvider}
              onChange={(v) => setKeyProvider(v as ProviderId)}
              options={KEY_PROVIDERS.map((p) => ({ value: p.id, label: p.name }))}
              style={{ width: 150 }}
            />
          </div>
          <div className="relative">
            <input
              type={showKey ? 'text' : 'password'}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleConnectKey()
              }}
              placeholder={KEY_PROVIDERS.find((p) => p.id === keyProvider)?.placeholder ?? 'sk-…'}
              aria-label="OpenClaw provider API key"
              data-testid="openclaw-inline-key"
              className="w-full rounded-lg border border-border bg-surface px-3 py-2.5 pr-10 font-mono text-[12.5px] text-foreground outline-none transition placeholder:text-foreground/30 focus:border-primary focus:ring-4 focus:ring-primary/15"
            />
            <button
              type="button"
              tabIndex={-1}
              aria-label={showKey ? 'Hide key' : 'Show key'}
              onClick={() => setShowKey((s) => !s)}
              className="absolute right-1.5 top-1/2 flex -translate-y-1/2 cursor-pointer items-center justify-center rounded-md p-1.5 text-foreground/45 transition-colors hover:bg-foreground/[0.06] hover:text-foreground/70"
            >
              {showKey ? <EyeOff size={15} /> : <Eye size={15} />}
            </button>
          </div>
          <div>
            <Button
              variant="primary"
              size="sm"
              disabled={!apiKey.trim()}
              loading={busy}
              onClick={() => void handleConnectKey()}
              data-testid="openclaw-inline-connect-key"
            >
              Connect &amp; set up <ArrowRight size={13} />
            </Button>
          </div>
        </div>
      )}

      {phase === 'needs-codex-auth' && (
        <div className="flex flex-col gap-2.5" data-testid="openclaw-inline-codex-auth">
          {justInstalled && <InstalledAck name="OpenClaw" testId="openclaw-inline-installed-ack" />}
          <p className="text-[12px] leading-relaxed" style={{ color: muted(0.55) }}>
            <span className="font-medium" style={{ color: muted(0.75) }}>
              Codex is connected.
            </span>{' '}
            OpenClaw can run on your ChatGPT subscription too. Each runtime keeps its own sign-in,
            so it needs one quick browser sign-in here (no code to type).
          </p>
          {/* One-click sign-in (the server spawns OpenClaw's own browser-PKCE
              login under a PTY); on-disk success re-runs the setup pipeline
              automatically. The manual command surfaces inside the flow's
              failure states. */}
          <ChatGptSignIn
            tool="openclaw"
            loginCommand={codexLoginCommand}
            onLoggedIn={() => void run()}
          />
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setPhase('needs-key')}
              data-testid="openclaw-inline-use-key"
            >
              Use an API key instead
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void run()}
              data-testid="openclaw-inline-codex-recheck"
            >
              Re-check
            </Button>
          </div>
        </div>
      )}

      {phase === 'pairing' && <DevicePairingApproval onApproved={() => void connectAndFinish()} />}

      {phase === 'connected' && (
        <span className="flex items-center gap-2 text-[12.5px] font-medium text-mint">
          <Check size={14} /> OpenClaw connected
        </span>
      )}

      {phase === 'error' && (
        <div className="flex flex-col gap-2.5">
          {error && <FormattedAlert tone="error">{error}</FormattedAlert>}
          <div>
            <Button variant="secondary" size="sm" onClick={() => void run()}>
              Retry
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
