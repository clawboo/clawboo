// Settings → Providers — the multi-provider key hub. Connect any provider once;
// the key is stored encrypted (the vault) AND mirrored to OpenClaw's config, so it
// powers every runtime (Clawboo Native, Claude Code, Hermes, OpenClaw). A key value
// is never displayed — only per-provider connection status.

import { useCallback, useEffect, useState } from 'react'
import { ChevronDown, ExternalLink, Eye, EyeOff, KeyRound } from 'lucide-react'

import {
  connectProvider,
  disconnectProvider,
  fetchProviders,
  type ProviderStatus,
} from '@clawboo/control-client'

import { PROVIDER_CATALOG, type ProviderCatalogEntry } from '@/lib/providerCatalog'
import { ProviderIcon } from '@/features/onboarding/ProviderIcon'
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
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => void handleDisconnect()}>
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

// ─── Panel ───────────────────────────────────────────────────────────────────

export function ProvidersPanel() {
  const [statuses, setStatuses] = useState<Record<string, ProviderStatus> | null>(null)
  const [showMore, setShowMore] = useState(false)

  const refresh = useCallback(async () => {
    const list = await fetchProviders()
    setStatuses(Object.fromEntries(list.map((p) => [p.id, p])))
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
        subtitle="Connect once — your keys are stored encrypted and reused across every runtime."
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
                <ProviderRow
                  key={entry.id}
                  entry={entry}
                  status={statuses[entry.id]}
                  onChanged={refresh}
                />
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
                Keys are stored encrypted in Clawboo's vault and mirrored to OpenClaw's config, so
                one key works across Clawboo Native, Claude Code, Hermes, and OpenClaw. Ollama runs
                locally and needs no key.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
