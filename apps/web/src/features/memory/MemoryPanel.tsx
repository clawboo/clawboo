// Memory browser. Browse + manage the MCP memory store the agents share: search
// (fts / vector / hybrid), save a declarative fact, and browse the two tiers
// (facts + versioned procedures). The active embedding provider is shown so the
// user knows whether vector/hybrid are backed (they degrade to FTS when null).

import { useCallback, useEffect, useState } from 'react'

import { motion } from 'framer-motion'
import { Brain, Cpu, ListChecks, Lock, RefreshCw, Search, SearchX, Users } from 'lucide-react'

import { GitHubStarButton } from '@/features/promo/GitHubStarButton'
import { Button } from '@/features/shared/Button'
import { EmptyState } from '@/features/shared/EmptyState'
import { FormattedAlert } from '@/features/shared/FormattedAlert'
import { PanelHeader } from '@/features/shared/PanelHeader'
import { SegmentedControl } from '@/features/shared/SegmentedControl'
import { Skeleton } from '@/features/shared/Skeleton'
import { StatusPill } from '@/features/shared/StatusPill'
import { useToastStore } from '@/stores/toast'
import { ENTER_SPRING, listDelay } from '@/lib/motion'
import {
  browseMemory,
  getProvider,
  saveFact,
  searchMemory,
  type EmbeddingProviderInfo,
  type MemoryFact,
  type MemoryProcedure,
  type MemorySearchResult,
  type SearchMode,
} from '@/lib/memoryClient'

const muted = (o: number) => `rgb(var(--foreground-rgb) / ${o})`
const MODES: SearchMode[] = ['fts', 'vector', 'hybrid']

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="flex flex-col gap-1.5 rounded-2xl border border-border bg-surface p-4 transition-colors hover:border-border-strong"
      style={{ boxShadow: 'var(--shadow-raised)' }}
    >
      {children}
    </div>
  )
}

/** The scope of a fact WITHIN the shared store — team-shared (the common case),
 *  agent-scoped, or global. Read-only signal; not the runtime's private memory. */
function ScopeBadge({ agentId, teamId }: { agentId: string | null; teamId: string | null }) {
  const label = agentId ? 'Agent-scoped' : teamId ? 'Team-shared' : 'Global'
  return <StatusPill tone="idle" label={label} style={{ flexShrink: 0 }} />
}

const KICKER = 'font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-foreground/45'

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className={KICKER}>{children}</div>
}

// Shared input chrome — token-driven, with the standard brand focus ring (no
// imperative onFocus/onBlur style mutation). bg-input stays visible in light.
const INPUT_CLASS =
  'w-full rounded-xl border border-border bg-input px-4 py-2.5 text-[14px] text-foreground outline-none transition placeholder:text-foreground/35 focus:border-primary focus:ring-4 focus:ring-primary/15'

export function MemoryPanel() {
  const addToast = useToastStore((s) => s.addToast)
  const [mode, setMode] = useState<SearchMode>('hybrid')
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<MemorySearchResult[]>([])
  const [searched, setSearched] = useState(false)
  const [searching, setSearching] = useState(false)

  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [tags, setTags] = useState('')
  const [saving, setSaving] = useState(false)

  const [facts, setFacts] = useState<MemoryFact[]>([])
  const [procedures, setProcedures] = useState<MemoryProcedure[]>([])
  const [provider, setProvider] = useState<EmbeddingProviderInfo | null>(null)
  const [loadingBrowse, setLoadingBrowse] = useState(true)
  const [browseOk, setBrowseOk] = useState(true) // false when the browse load failed → error/retry

  const refreshBrowse = useCallback(async () => {
    setLoadingBrowse(true)
    try {
      const [b, p] = await Promise.all([browseMemory({ limit: 50 }), getProvider()])
      setBrowseOk(b.ok)
      setFacts(b.facts)
      setProcedures(b.procedures)
      setProvider(p)
    } finally {
      setLoadingBrowse(false)
    }
  }, [])

  useEffect(() => {
    void refreshBrowse()
  }, [refreshBrowse])

  const runSearch = useCallback(async () => {
    if (!query.trim()) return
    setSearching(true)
    try {
      setResults(await searchMemory(query.trim(), mode, { limit: 25 }))
      setSearched(true)
    } finally {
      setSearching(false)
    }
  }, [query, mode])

  const onSave = useCallback(async () => {
    if (!title.trim() || !content.trim()) return
    setSaving(true)
    const parsedTags = tags
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean)
    const fact = await saveFact({ title: title.trim(), content: content.trim(), tags: parsedTags })
    setSaving(false)
    if (fact) {
      setTitle('')
      setContent('')
      setTags('')
      void refreshBrowse()
    } else {
      // saveFact returns null on a network/non-2xx failure — surface it instead
      // of a silent no-op that looks like the save worked.
      addToast({ type: 'error', message: 'Could not save the fact. Please try again.' })
    }
  }, [title, content, tags, refreshBrowse, addToast])

  const saveDisabled = saving || !title.trim() || !content.trim()
  const firstLoad = loadingBrowse && facts.length === 0 && procedures.length === 0

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <PanelHeader
        title="Memory"
        subtitle={`${facts.length} facts · ${procedures.length} procedures`}
        icon={Brain}
        border
        actions={
          <>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void refreshBrowse()}
              aria-label="Refresh"
              className="memory-refresh-btn"
            >
              <RefreshCw size={14} strokeWidth={2} /> Refresh
            </Button>
            <GitHubStarButton />
          </>
        }
      />

      <div
        data-testid="memory-panel"
        style={{ flex: 1, overflow: 'auto' }}
        className="px-6 py-5"
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18, maxWidth: 760 }}>
          {/* Browse-load failure — distinct from a genuinely-empty store. */}
          {!browseOk && (
            <div data-testid="memory-fetch-error">
              <FormattedAlert tone="error">
                <span className="flex items-center gap-2">
                  Couldn&apos;t load the memory store.
                  <Button variant="ghost" size="sm" onClick={() => void refreshBrowse()}>
                    Retry
                  </Button>
                </span>
              </FormattedAlert>
            </div>
          )}

          {/* One shared memory — the team's source of truth */}
          <div
            data-testid="memory-shared-banner"
            style={{
              display: 'flex',
              gap: 10,
              alignItems: 'flex-start',
              borderRadius: 16,
              padding: '12px 14px',
              background: 'rgb(var(--mint-rgb) / 0.08)',
              border: '1px solid rgb(var(--mint-rgb) / 0.2)',
            }}
          >
            <Users size={16} style={{ color: 'var(--mint)', flexShrink: 0, marginTop: 1 }} />
            <div style={{ fontSize: 12, color: muted(0.65), lineHeight: 1.55 }}>
              <strong style={{ color: 'var(--foreground)' }}>One shared memory.</strong> Every
              runtime on the team reads and writes this store through the Memory tool — it's the
              team's source of truth. Each runtime ALSO keeps its own private self-model, which
              stays with that runtime and is never edited here.
            </div>
          </div>

          {/* Per-runtime private self-models — present, not editable here */}
          <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
            <span
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 5,
                fontSize: 11,
                color: muted(0.45),
              }}
            >
              <Lock size={11} /> Private self-models (read-only):
            </span>
            {['clawboo Native', 'Hermes', 'Claude Code'].map((rt) => (
              <StatusPill key={rt} tone="idle" label={rt} />
            ))}
            <span style={{ fontSize: 11, color: muted(0.4) }}>· managed by each runtime</span>
          </div>

          {/* Provider */}
          <div
            className="rounded-2xl border border-border bg-surface p-4"
            style={{ boxShadow: 'var(--shadow-raised)' }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
              <span
                aria-hidden
                className="flex shrink-0 items-center justify-center rounded-lg"
                style={{
                  width: 28,
                  height: 28,
                  color: muted(0.55),
                  background: 'rgb(var(--foreground-rgb) / 0.05)',
                }}
              >
                <Cpu size={15} strokeWidth={2} />
              </span>
              <div className="min-w-0">
                <div className={KICKER}>Embedding provider</div>
                <div className="font-data mt-0.5 text-[13px] text-foreground">
                  {provider ? `${provider.id} · ${provider.dimensions}d` : 'FTS-only'}
                </div>
              </div>
              {!provider && (
                <span style={{ marginLeft: 'auto' }}>
                  <StatusPill tone="warning" label="FTS fallback" />
                </span>
              )}
            </div>
            {!provider && (
              <p style={{ fontSize: 11, color: muted(0.5), marginTop: 8, lineHeight: 1.55 }}>
                No embedding provider — vector / hybrid search degrade to keyword (FTS).
              </p>
            )}
          </div>

          {/* Search */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <SectionLabel>Search</SectionLabel>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <div className="relative flex-1">
                <Search
                  size={15}
                  strokeWidth={2}
                  className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-foreground/35"
                />
                <input
                  data-testid="memory-search-input"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void runSearch()
                  }}
                  placeholder="Search the memory store…"
                  className={`${INPUT_CLASS} pl-10`}
                />
              </div>
              <Button
                data-testid="memory-search-run"
                onClick={() => void runSearch()}
                loading={searching}
                variant="primary"
                size="md"
                className="memory-action-btn"
              >
                {searching ? null : <Search size={15} strokeWidth={2} />} Search
              </Button>
            </div>
            <SegmentedControl<SearchMode>
              options={MODES.map((m) => ({ id: m, label: m }))}
              value={mode}
              onChange={setMode}
              size="sm"
              aria-label="Search mode"
            />

            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 2 }}>
              {results.map((r, i) => (
                <motion.div
                  key={r.id}
                  data-testid="memory-result"
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ ...ENTER_SPRING, delay: listDelay(i) }}
                >
                  <Card>
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 8,
                      }}
                    >
                      <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--foreground)' }}>
                        {r.title}
                      </span>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <StatusPill tone="done" label={r.matchedVia} />
                        <span className="font-data" style={{ fontSize: 10, color: muted(0.45) }}>
                          {r.score.toFixed(2)}
                        </span>
                      </span>
                    </div>
                    <div style={{ fontSize: 11, color: muted(0.65), lineHeight: 1.5 }}>
                      {r.content.slice(0, 240)}
                      {r.content.length > 240 ? '…' : ''}
                    </div>
                  </Card>
                </motion.div>
              ))}
              {searched && results.length === 0 && (
                <EmptyState
                  icon={SearchX}
                  title="No matches"
                  helper="Nothing in the shared store matched this query. Try a different term or search mode."
                  paddingTop={28}
                />
              )}
            </div>
          </div>

          {/* Save a fact */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <SectionLabel>Save a fact</SectionLabel>
            <input
              data-testid="memory-fact-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Title"
              className={INPUT_CLASS}
            />
            <textarea
              data-testid="memory-fact-content"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="Content"
              rows={3}
              className={`${INPUT_CLASS} resize-y`}
            />
            <input
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder="Tags (comma-separated)"
              className={INPUT_CLASS}
            />
            <div>
              <Button
                data-testid="memory-save-fact"
                onClick={() => void onSave()}
                disabled={saveDisabled}
                loading={saving}
                variant="primary"
                size="md"
                className="memory-action-btn"
              >
                {saving ? 'Saving…' : 'Save fact'}
              </Button>
            </div>
          </div>

          {/* Browse — facts */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <SectionLabel>Facts ({facts.length})</SectionLabel>
            {firstLoad ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {[0, 1, 2].map((i) => (
                  <Skeleton key={i} height={62} radius={10} />
                ))}
              </div>
            ) : facts.length === 0 ? (
              <EmptyState
                icon={Brain}
                title="No facts yet"
                helper="Declarative facts your agents save to the shared store will appear here."
                paddingTop={28}
              />
            ) : (
              facts.map((f, i) => (
                <motion.div
                  key={f.id}
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ ...ENTER_SPRING, delay: listDelay(i) }}
                >
                  <Card>
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 8,
                      }}
                    >
                      <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--foreground)' }}>
                        {f.title}
                      </span>
                      <ScopeBadge agentId={f.scopeAgentId} teamId={f.scopeTeamId} />
                    </div>
                    <div style={{ fontSize: 11, color: muted(0.6), lineHeight: 1.5 }}>
                      {f.content.slice(0, 200)}
                      {f.content.length > 200 ? '…' : ''}
                    </div>
                    {f.tags.length > 0 && (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                        {f.tags.map((t) => (
                          <span
                            key={t}
                            className="font-data"
                            style={{
                              fontSize: 10.5,
                              padding: '2px 8px',
                              borderRadius: 6,
                              background: muted(0.06),
                              color: muted(0.6),
                            }}
                          >
                            {t}
                          </span>
                        ))}
                      </div>
                    )}
                  </Card>
                </motion.div>
              ))
            )}
          </div>

          {/* Browse — procedures */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <SectionLabel>Procedures ({procedures.length})</SectionLabel>
            {firstLoad ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {[0, 1].map((i) => (
                  <Skeleton key={i} height={62} radius={10} />
                ))}
              </div>
            ) : procedures.length === 0 ? (
              <EmptyState
                icon={ListChecks}
                title="No procedures yet"
                helper="Versioned, reusable procedures the team builds up will be listed here."
                paddingTop={28}
              />
            ) : (
              procedures.map((p, i) => (
                <motion.div
                  key={p.id}
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ ...ENTER_SPRING, delay: listDelay(i) }}
                >
                  <Card>
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                      }}
                    >
                      <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--foreground)' }}>
                        {p.name}
                      </span>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <ScopeBadge agentId={p.scopeAgentId} teamId={p.scopeTeamId} />
                        <span className="font-data" style={{ fontSize: 10, color: muted(0.45) }}>
                          v{p.version}
                        </span>
                      </span>
                    </div>
                    <div style={{ fontSize: 11, color: muted(0.6), lineHeight: 1.5 }}>
                      {p.content.slice(0, 200)}
                      {p.content.length > 200 ? '…' : ''}
                    </div>
                  </Card>
                </motion.div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
