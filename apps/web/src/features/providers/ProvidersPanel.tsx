// Settings → Providers — the multi-provider hub. Connect one or many; keys are
// stored encrypted (the vault) AND mirrored to OpenClaw's config, so each powers
// every runtime on its provider (Clawboo Native, Claude Code, Hermes, OpenClaw).
// A key value is never displayed — only per-provider connection status.
//
// This panel is ALSO the home of the ChatGPT subscription (a dedicated row, not
// a key): signing in here (via the Codex CLI's own browser login) is how clawboo
// KNOWS the subscription exists — the runtime surfaces (Hermes / OpenClaw setup)
// only offer their optional subscription links once this is a detected fact.

import { Fragment, useCallback, useEffect, useState } from 'react'
import { ChevronDown, ExternalLink, Eye, EyeOff, KeyRound } from 'lucide-react'

import {
  connectProvider,
  disconnectProvider,
  fetchProviders,
  fetchRuntimes,
  type ProviderStatus,
} from '@clawboo/control-client'

import { PROVIDER_CATALOG, type ProviderCatalogEntry } from '@/lib/providerCatalog'
import { ProviderIcon } from '@/features/onboarding/ProviderIcon'
import { ChatGptSignIn } from '@/features/runtimes/ChatGptSignIn'
import { PanelHeader } from '@/features/shared/PanelHeader'
import { Button } from '@/features/shared/Button'
import { StatusPill } from '@/features/shared/StatusPill'
import { Skeleton } from '@/features/shared/Skeleton'
import { GitHubStarButton } from '@/features/promo/GitHubStarButton'
import { useToastStore } from '@/stores/toast'
import { confirm } from '@/stores/confirm'

// ─── Provider row ────────────────────────────────────────────────────────────

function ProviderRow({
  entry,
  status,
  onChanged,
}: {
  entry: ProviderCatalogEntry
  status: ProviderStatus | undefined
  onChanged: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [apiKey, setApiKey] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [busy, setBusy] = useState(false)
  const addToast = useToastStore((s) => s.addToast)

  const connected = status?.connected ?? false
  const powers = status?.poweredRuntimes ?? []

  const handleSave = useCallback(async () => {
    const key = apiKey.trim()
    if (!key) return
    setBusy(true)
    const r = await connectProvider(entry.id, key)
    setBusy(false)
    if (r.ok) {
      addToast({ message: `${entry.name} connected`, type: 'success' })
      setApiKey('')
      setEditing(false)
      setShowKey(false)
      onChanged()
    } else {
      addToast({ message: r.error ?? 'Failed to save key', type: 'error' })
    }
  }, [apiKey, entry, addToast, onChanged])

  const handleDisconnect = useCallback(async () => {
    const ok = await confirm({
      title: `Disconnect ${entry.name}?`,
      message: "This removes its API key from the encrypted vault and OpenClaw's config.",
      confirmLabel: 'Disconnect',
      tone: 'danger',
    })
    if (!ok) return
    setBusy(true)
    const r = await disconnectProvider(entry.id)
    setBusy(false)
    if (r.ok) {
      addToast({ message: `${entry.name} disconnected`, type: 'success' })
      onChanged()
    } else {
      addToast({ message: r.error ?? 'Failed to disconnect', type: 'error' })
    }
  }, [entry, addToast, onChanged])

  return (
    <div
      className="flex flex-col gap-3 rounded-2xl border border-border bg-surface p-4"
      style={{ boxShadow: 'var(--shadow-raised)' }}
    >
      <div className="flex items-center gap-3">
        <ProviderIcon id={entry.id} size={38} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[13.5px] font-semibold text-foreground">{entry.name}</span>
            {connected && <StatusPill tone="success" label="Connected" />}
          </div>
          {powers.length > 0 && (
            <div className="mt-0.5 truncate text-[11px] text-foreground/45">
              {connected ? 'Powers' : 'Used by'} {powers.join(' · ')}
            </div>
          )}
        </div>

        {editing ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setEditing(false)
              setApiKey('')
              setShowKey(false)
            }}
          >
            Cancel
          </Button>
        ) : connected ? (
          <>
            <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
              Update
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => void handleDisconnect()}
            >
              Disconnect
            </Button>
          </>
        ) : (
          <Button variant="primary" size="sm" onClick={() => setEditing(true)}>
            Connect
          </Button>
        )}
      </div>

      {editing && (
        <div className="flex items-center gap-2 pl-[50px]">
          <div className="relative flex-1">
            <input
              type={showKey ? 'text' : 'password'}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && apiKey.trim()) void handleSave()
              }}
              placeholder={entry.placeholder}
              autoFocus
              spellCheck={false}
              autoComplete="off"
              aria-label={`${entry.name} API key`}
              className="w-full rounded-xl border border-border bg-surface px-4 py-2.5 pr-11 font-mono text-[13px] text-foreground outline-none transition placeholder:text-foreground/30 focus:border-primary focus:ring-4 focus:ring-primary/15"
            />
            <button
              type="button"
              tabIndex={-1}
              aria-label={showKey ? 'Hide API key' : 'Show API key'}
              onClick={() => setShowKey((v) => !v)}
              className="absolute right-3 top-1/2 -translate-y-1/2 cursor-pointer rounded-md border-none bg-transparent p-1 text-foreground/40 transition-colors hover:text-foreground/70"
            >
              {showKey ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
          {entry.keyUrl && (
            <a
              href={entry.keyUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex shrink-0 items-center gap-1 text-[12px] font-medium text-primary underline-offset-2 hover:underline"
            >
              Get a key <ExternalLink size={11} />
            </a>
          )}
          <Button
            variant="primary"
            size="sm"
            disabled={!apiKey.trim()}
            loading={busy}
            onClick={() => void handleSave()}
          >
            Save
          </Button>
        </div>
      )}
    </div>
  )
}

// ─── ChatGPT subscription row ────────────────────────────────────────────────
//
// Not an API key — a distinct way to power runtimes (OpenAI's Codex OAuth,
// billed to the ChatGPT plan). Signing in spawns the OFFICIAL `codex login`
// locally (browser-PKCE; clawboo never touches tokens). Once connected it also
// unlocks the OPTIONAL subscription links on the Hermes / OpenClaw surfaces.

function ChatGptSubscriptionRow({
  connected,
  onChanged,
}: {
  connected: boolean
  onChanged: () => void
}) {
  const [expanded, setExpanded] = useState(false)

  return (
    <div
      className="flex flex-col gap-3 rounded-2xl border border-border bg-surface p-4"
      style={{ boxShadow: 'var(--shadow-raised)' }}
      data-testid="provider-row-chatgpt"
    >
      <div className="flex items-center gap-3">
        <ProviderIcon id="openai-codex" size={38} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[13.5px] font-semibold text-foreground">
              ChatGPT subscription
            </span>
            {connected && <StatusPill tone="success" label="Connected" />}
          </div>
          <div className="mt-0.5 truncate text-[11px] text-foreground/45">
            {connected
              ? 'Signed in. Powers Codex, and optionally OpenClaw and Hermes'
              : 'No API key needed. Sign in with your ChatGPT account'}
          </div>
        </div>

        {connected ? (
          <span className="text-[11px] text-foreground/40">Managed by the Codex CLI</span>
        ) : expanded ? (
          <Button variant="ghost" size="sm" onClick={() => setExpanded(false)}>
            Cancel
          </Button>
        ) : (
          <Button
            variant="primary"
            size="sm"
            onClick={() => setExpanded(true)}
            data-testid="provider-chatgpt-connect"
          >
            Connect
          </Button>
        )}
      </div>

      {expanded && !connected && (
        <div className="pl-[50px]">
          <ChatGptSignIn
            tool="codex"
            loginCommand="codex login"
            onLoggedIn={() => {
              setExpanded(false)
              onChanged()
            }}
          />
        </div>
      )}
    </div>
  )
}

// ─── Panel ───────────────────────────────────────────────────────────────────

export function ProvidersPanel() {
  const [statuses, setStatuses] = useState<Record<string, ProviderStatus> | null>(null)
  const [codexReady, setCodexReady] = useState(false)
  const [showMore, setShowMore] = useState(false)

  const refresh = useCallback(async () => {
    const [list, runtimes] = await Promise.all([fetchProviders(), fetchRuntimes()])
    setStatuses(Object.fromEntries(list.map((p) => [p.id, p])))
    setCodexReady(runtimes.some((r) => r.id === 'codex' && r.connectionState === 'ready'))
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const primary = PROVIDER_CATALOG.filter((p) => p.tier === 'primary')
  const more = PROVIDER_CATALOG.filter((p) => p.tier === 'more')

  return (
    <div className="flex h-full flex-col bg-background">
      <PanelHeader
        title="Providers"
        subtitle="Connect one or many. Each is stored encrypted and reused across every runtime."
        icon={KeyRound}
        border
        actions={
          <>
            <Button variant="secondary" size="sm" onClick={() => void refresh()}>
              Refresh
            </Button>
            <GitHubStarButton />
          </>
        }
      />
      <div className="flex-1 overflow-auto px-6 py-5">
        <div className="flex max-w-[760px] flex-col gap-3">
          {statuses === null ? (
            [0, 1, 2, 3].map((i) => <Skeleton key={i} height={72} radius={16} />)
          ) : (
            <>
              {primary.map((entry) => (
                <Fragment key={entry.id}>
                  <ProviderRow entry={entry} status={statuses[entry.id]} onChanged={refresh} />
                  {/* The subscription row sits beside its sibling: OpenAI the
                      key, ChatGPT the plan — two billing paths, one brand. */}
                  {entry.id === 'openai' && (
                    <ChatGptSubscriptionRow
                      connected={codexReady}
                      onChanged={() => void refresh()}
                    />
                  )}
                </Fragment>
              ))}

              <button
                type="button"
                onClick={() => setShowMore((v) => !v)}
                className="mt-1 flex items-center gap-1.5 self-start text-[12px] font-medium text-foreground/60 transition-colors hover:text-foreground/85"
              >
                <ChevronDown
                  size={14}
                  style={{
                    transform: showMore ? 'rotate(180deg)' : 'none',
                    transition: 'transform var(--motion-fast)',
                  }}
                />
                {showMore ? 'Fewer providers' : `More providers (${more.length})`}
              </button>
              {showMore &&
                more.map((entry) => (
                  <ProviderRow
                    key={entry.id}
                    entry={entry}
                    status={statuses[entry.id]}
                    onChanged={refresh}
                  />
                ))}

              <p className="mt-2 text-[12px] leading-relaxed text-foreground/45">
                Connect as many providers as you like. Keys are stored encrypted in Clawboo's vault
                and mirrored to OpenClaw's config, so one key works across Clawboo Native, Claude
                Code, Hermes, and OpenClaw. The ChatGPT subscription signs in through the Codex CLI
                instead of a key. Ollama runs locally and needs no key.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
