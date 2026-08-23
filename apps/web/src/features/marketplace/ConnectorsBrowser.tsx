// The connectors tab body, kept out of MarketplacePanel because that file is
// already 695 lines across three tabs.
//
// PART directory, PART installer, and the copy now says exactly which is which.
// clawboo can run a curated, credential-free stdio server itself; everything
// else it can only describe, so those tiles offer a config block to paste into a
// runtime you already use and say plainly why they cannot be connected here.
//
// Which half a tile falls into is decided by `connectRefusal` in
// @clawboo/connector-catalog -- the SAME predicate the REST handler enforces.
// A tile therefore cannot offer a button the server would refuse, which is the
// affordance-shaped lie this file exists to avoid.
//
// No fetch, no loading state: the catalog is committed data.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import {
  Check,
  Copy,
  Globe,
  Info,
  KeyRound,
  Plug,
  SearchX,
  ShieldAlert,
  Terminal,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import {
  CONNECT_REFUSAL_COPY,
  connectorCounts,
  connectorSnippet,
  connectRefusal,
  isConnectable,
  searchConnectors,
  SNIPPET_DIALECTS,
  type ConnectorCategory,
  type ConnectorDefinition,
  type SnippetDialect,
} from '@clawboo/connector-catalog'
import { Button } from '@/features/shared/Button'
import { Chip } from '@/features/shared/Chip'
import { EmptyState } from '@/features/shared/EmptyState'
import { SearchInput } from '@/features/shared/SearchInput'
import { CollapsiblePillRow, type PillOption } from './CollapsiblePillRow'
import { useToastStore } from '@/stores/toast'
import { useMarketplaceStore } from '@/stores/marketplace'
import { connectConnector, disconnectConnector, listLiveConnectors } from './connectConnector'

// ─── Category pills ─────────────────────────────────────────────────────────

const CATEGORY_LABELS: Record<ConnectorCategory, string> = {
  dev: 'Dev',
  issues: 'Issues',
  chat: 'Chat',
  docs: 'Docs',
  data: 'Data',
  observability: 'Observability',
  browser: 'Browser',
  search: 'Search',
  productivity: 'Productivity',
  finance: 'Finance',
}

/**
 * The status word a user reads.
 *
 * A CONNECTABLE entry now reports its connection STATE. It used to say "Active"
 * on the grounds that a no-auth server is ready the moment it is attached, and
 * that was true while this tab was a directory and nothing more. It is exactly
 * the set that now offers a Connect button, so leaving it would put "Active"
 * next to "Connect" on the same tile and claim a state the backend does not
 * have.
 */
function authLabel(
  def: ConnectorDefinition,
  connected: boolean,
): { label: string; icon?: LucideIcon; active: boolean } {
  if (isConnectable(def)) {
    return connected
      ? { label: 'Connected', icon: Plug, active: true }
      : { label: 'Not connected', active: false }
  }
  if (def.auth.kind === 'oauth') return { label: 'Sign in', icon: KeyRound, active: false }
  if (def.auth.kind === 'none') return { label: 'Copy config', active: false }
  return { label: 'Needs a key', icon: KeyRound, active: false }
}

/** How many trifecta legs this connector can arm, at its most permissive. */
function legCount(def: ConnectorDefinition): number {
  const t = def.trifecta
  return (t.readsPrivateData ? 1 : 0) + (t.ingestsUntrustedContent ? 1 : 0) + (t.canEgress ? 1 : 0)
}

// ─── Card ───────────────────────────────────────────────────────────────────

function ConnectorCard({
  def,
  index,
  connected,
  onOpen,
}: {
  def: ConnectorDefinition
  index: number
  connected: boolean
  onOpen: (def: ConnectorDefinition) => void
}) {
  const auth = authLabel(def, connected)
  const legs = legCount(def)
  const remote = def.launch.transport === 'streamable-http'

  return (
    <motion.button
      type="button"
      onClick={() => onOpen(def)}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18, delay: Math.min(index * 0.02, 0.4) }}
      className="group flex flex-col gap-3 rounded-2xl border border-border bg-surface p-5 text-left transition-[border-color,box-shadow,transform] duration-150 hover:-translate-y-px hover:border-border-strong focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      style={{ boxShadow: 'var(--shadow-raised)' }}
      aria-label={`${def.displayName} connector — ${auth.label}, ${legs} of 3 risk signals`}
    >
      <div className="flex items-center gap-3">
        <div
          className="flex size-10 shrink-0 items-center justify-center rounded-xl"
          style={{ background: 'color-mix(in srgb, var(--category-other) 14%, transparent)' }}
        >
          <Plug size={18} style={{ color: 'var(--category-other)' }} aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-foreground">{def.displayName}</div>
          <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
            {remote ? <Globe size={11} aria-hidden /> : <Terminal size={11} aria-hidden />}
            <span>{remote ? 'Remote' : 'Local process'}</span>
            <span aria-hidden>·</span>
            <span>{CATEGORY_LABELS[def.category]}</span>
          </div>
        </div>
      </div>

      <p className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">
        {def.description}
      </p>

      <div className="mt-auto flex flex-wrap items-center gap-1.5">
        <Chip size="sm" icon={auth.icon} active={auth.active}>
          {auth.label}
        </Chip>
        {legs >= 2 && (
          <Chip size="sm" icon={ShieldAlert} accent="var(--amber)">
            {legs}/3 risk
          </Chip>
        )}
        {def.provenance === 'community' && <Chip size="sm">Community</Chip>}
      </div>
    </motion.button>
  )
}

// ─── Detail: the copy-paste snippet ─────────────────────────────────────────

/**
 * Connect / Disconnect, or an honest statement of why neither is offered.
 *
 * The refusal copy comes from the catalog package, which is the same predicate
 * the REST handler enforces. A tile therefore cannot offer a button the server
 * would refuse, and cannot withhold one the server would accept.
 */
function ConnectAction({
  def,
  connected,
  onChanged,
}: {
  def: ConnectorDefinition
  connected: boolean
  onChanged: () => void
}) {
  const [busy, setBusy] = useState(false)
  const refusal = connectRefusal(def)

  if (refusal) {
    return (
      <section className="rounded-xl border border-border bg-surface-subtle p-4">
        <div className="flex items-center gap-2 text-xs font-semibold text-foreground">
          <Info size={13} aria-hidden />
          Not connectable yet
        </div>
        {/* Verbatim from the shared predicate: the actual obstacle, not a status. */}
        <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
          {CONNECT_REFUSAL_COPY[refusal]}
        </p>
        <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
          You can still copy the config below into a runtime you already use.
        </p>
      </section>
    )
  }

  async function run() {
    setBusy(true)
    try {
      if (connected) await disconnectConnector(def.slug, def.displayName)
      else await connectConnector(def.slug, def.displayName)
      onChanged()
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="rounded-xl border border-border bg-surface-subtle p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs font-semibold text-foreground">
            {connected ? 'Connected' : 'Run this connector'}
          </div>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            {connected
              ? 'Its tools are available to agents attached over HTTP. Agents running in-process cannot reach them yet. Disconnecting stops the process.'
              : /* Named plainly: this starts a process on your machine, and the
                   first run downloads the pinned package. */
                'clawboo starts this server as a local process and lists its tools. The first run downloads the pinned package.'}
          </p>
        </div>
        <Button
          size="sm"
          variant={connected ? 'secondary' : 'primary'}
          onClick={run}
          disabled={busy}
        >
          {busy ? 'Working…' : connected ? 'Disconnect' : 'Connect'}
        </Button>
      </div>
    </section>
  )
}

function ConnectorDetail({
  def,
  connected,
  onConnected,
  onClose,
}: {
  def: ConnectorDefinition
  connected: boolean
  onConnected: () => void
  onClose: () => void
}) {
  const [dialect, setDialect] = useState<SnippetDialect>('claude-code')
  const [copied, setCopied] = useState(false)
  const addToast = useToastStore((s) => s.addToast)
  const snippet = useMemo(() => connectorSnippet(def, dialect), [def, dialect])

  async function copy() {
    try {
      await navigator.clipboard.writeText(snippet.body)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    } catch {
      // Clipboard is permission-gated and fails silently in some contexts. Say so
      // rather than leaving the button looking like it worked.
      addToast({
        type: 'error',
        message: 'Could not copy — select the block and copy manually.',
      })
    }
  }

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto px-6 py-5">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold text-foreground">{def.displayName}</h2>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{def.description}</p>
        </div>
        <Button size="sm" variant="secondary" onClick={onClose}>
          Back
        </Button>
      </div>

      {/* The connect action, or the reason there isn't one. Above the snippet
          because running it here is now the primary verb; pasting a config into
          your own runtime is the fallback for everything clawboo cannot run. */}
      <ConnectAction def={def} connected={connected} onChanged={onConnected} />

      {/* What it is allowed to reach. Shown before the snippet on purpose: the
          decision a user is making is "should this run at all", not "where do I
          paste it". */}
      <section className="rounded-xl border border-border bg-surface-subtle p-4">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          What it can reach
        </h3>
        <ul className="mt-2 space-y-1 text-xs text-foreground">
          <li>
            {def.launch.transport === 'stdio'
              ? `Runs locally: ${def.launch.command} ${def.launch.args.join(' ')}`
              : `Talks to ${def.launch.url}`}
          </li>
          <li>
            Network:{' '}
            {def.egressAllow.length === 0
              ? 'none — local only'
              : def.egressAllow.includes('*')
                ? 'any host (a browser can go anywhere)'
                : def.egressAllow.join(', ')}
          </li>
          {def.auth.inputs.length > 0 && (
            <li>
              Needs: {def.auth.inputs.map((i) => i.key).join(', ')}{' '}
              <span className="text-muted-foreground">
                (stored in clawboo&rsquo;s vault, never in a config file)
              </span>
            </li>
          )}
          {def.auth.scopesRationale && <li>Scopes: {def.auth.scopesRationale}</li>}
        </ul>
      </section>

      {def.auth.setupGuide && (
        <section className="rounded-xl border border-border p-4">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Setup — {def.auth.setupGuide.console}
          </h3>
          <ol className="mt-2 list-inside list-decimal space-y-1 text-xs text-foreground">
            {def.auth.setupGuide.steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
          <a
            href={def.auth.setupGuide.url}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-2 inline-block text-xs text-accent underline"
          >
            Open {def.auth.setupGuide.console}
          </a>
        </section>
      )}

      {/* The snippet. Framed as "paste this into your own runtime" because that is
          literally what it does — clawboo writes nothing. */}
      <section className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Add it to your runtime
          </h3>
          {/* A pressed-state group, NOT role="tablist". The ARIA tab pattern
              obliges arrow-key roving, a roving tabindex and an aria-controls
              tabpanel; announcing a widget that does not behave the way it was
              announced is worse for a screen reader than plain buttons. */}
          <div className="flex gap-1" role="group" aria-label="Config dialect">
            {SNIPPET_DIALECTS.map((d) => (
              <button
                key={d.id}
                type="button"
                aria-pressed={dialect === d.id}
                onClick={() => setDialect(d.id)}
                className={`rounded-md px-2 py-1 text-[11px] transition-colors ${
                  dialect === d.id
                    ? 'bg-surface-strong text-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {d.label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
          <code>{snippet.file}</code>
          <Button size="sm" variant="secondary" onClick={copy}>
            {copied ? <Check size={12} aria-hidden /> : <Copy size={12} aria-hidden />}
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>

        <pre className="max-h-72 overflow-auto rounded-xl border border-border bg-surface-subtle p-3 text-[11px] leading-relaxed">
          <code>{snippet.body}</code>
        </pre>

        {snippet.requiredEnv.length > 0 && (
          <p className="text-[11px] text-muted-foreground">
            You will also need to set {snippet.requiredEnv.join(', ')} in your environment. The
            block references them by name so it stays safe to commit.
          </p>
        )}
      </section>

      {def.homepage && (
        <a
          href={def.homepage}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-accent underline"
        >
          Connector source and documentation
        </a>
      )}
    </div>
  )
}

// ─── Browser ────────────────────────────────────────────────────────────────

export function ConnectorsBrowser() {
  const searchQuery = useMarketplaceStore((s) => s.connectorSearchQuery)
  const setSearchQuery = useMarketplaceStore((s) => s.setConnectorSearchQuery)
  const categoryFilter = useMarketplaceStore((s) => s.connectorCategoryFilter)
  const setCategoryFilter = useMarketplaceStore((s) => s.setConnectorCategoryFilter)
  const [selected, setSelected] = useState<ConnectorDefinition | null>(null)

  const counts = connectorCounts()
  // Stated rather than implied. The header used to read "a directory, not an
  // installer", which was true when nothing here could run and is now false for
  // exactly the connectable set.
  const connectableCount = useMemo(() => searchConnectors('').filter(isConnectable).length, [])

  const results = useMemo(() => {
    const matched = searchConnectors(searchQuery)
    return categoryFilter === 'all' ? matched : matched.filter((c) => c.category === categoryFilter)
  }, [searchQuery, categoryFilter])

  const categoryOptions: PillOption[] = useMemo(() => {
    const present = new Set(searchConnectors('').map((c) => c.category))
    return [
      { key: 'all', label: 'All' },
      ...[...present].sort().map((c) => ({ key: c, label: CATEGORY_LABELS[c] })),
    ]
  }, [])

  // Which connectors are live, by slug. Fetched rather than assumed: a connector
  // survives a page reload because the PROCESS is owned by the server, so a
  // client-side guess would be wrong on every refresh.
  const [liveSlugs, setLiveSlugs] = useState<ReadonlySet<string>>(new Set())
  const refreshLive = useCallback(() => {
    void listLiveConnectors().then((rows) => setLiveSlugs(new Set(rows.map((r) => r.slug))))
  }, [])
  useEffect(refreshLive, [refreshLive])

  if (selected) {
    return (
      <ConnectorDetail
        def={selected}
        connected={liveSlugs.has(selected.slug)}
        onConnected={refreshLive}
        onClose={() => setSelected(null)}
      />
    )
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 flex-col gap-2.5 border-b border-border px-6 py-3.5">
        <SearchInput
          size="sm"
          placeholder="Search connectors…"
          value={searchQuery}
          onChange={setSearchQuery}
        />
        <CollapsiblePillRow
          aria-label="Filter connectors by category"
          options={categoryOptions}
          activeKey={categoryFilter}
          onSelect={(key) => setCategoryFilter(key as ConnectorCategory | 'all')}
        />
      </div>

      {/* The count is always a SPLIT, never one total. "1000+" is the claim the
          reference implementations make and cannot support. */}
      <div className="shrink-0 px-6 pt-3 text-[11px] text-muted-foreground">
        {counts.curated} curated
        {counts.community > 0 && <> · {counts.community} community</>} · {connectableCount}{' '}
        {connectableCount === 1 ? 'runs' : 'run'} here; the rest are a directory, so copy their
        config into a runtime you already use
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-4">
        {results.length === 0 ? (
          <EmptyState
            icon={SearchX}
            title="No connectors match"
            helper="Try a different search or clear the category filter."
          />
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {results.map((def, i) => (
              <ConnectorCard
                key={def.slug}
                def={def}
                index={i}
                connected={liveSlugs.has(def.slug)}
                onOpen={setSelected}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
