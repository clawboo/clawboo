// Memory browser. Browse + manage the MCP memory store the agents share: search
// (fts / vector / hybrid), save a declarative fact, and browse the two tiers
// (facts + versioned procedures). The active embedding provider is shown so the
// user knows whether vector/hybrid are backed (they degrade to FTS when null).

import { useCallback, useEffect, useState } from 'react'

import { motion } from 'framer-motion'
import { Brain, ListChecks, Lock, RefreshCw, Search, SearchX, Users } from 'lucide-react'

import { GitHubStarButton } from '@/features/promo/GitHubStarButton'
import { EmptyState } from '@/features/shared/EmptyState'
import { FormattedAlert } from '@/features/shared/FormattedAlert'
import { Skeleton } from '@/features/shared/Skeleton'
import { Spinner } from '@/features/shared/Spinner'
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
      className="surface-raised-tier"
      style={{
        borderRadius: 10,
        padding: '10px 12px',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
      }}
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

const KICKER = 'font-mono text-[11px] font-semibold uppercase tracking-wider'

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className={KICKER} style={{ color: muted(0.4) }}>
      {children}
    </div>
  )
}

// Shared input chrome. bg is var(--input) (visible in light mode, unlike the
// old white-on-white var(--surface)); focus lifts the border to the brand
// accent with a soft ring. onFocus/onBlur swap inline styles so the treatment
// works on plain <input>/<textarea> without a wrapper.
const inputStyle: React.CSSProperties = {
  width: '100%',
  fontSize: 12,
  padding: '8px 10px',
  borderRadius: 7,
  border: '1px solid rgb(var(--foreground-rgb) / 0.1)',
  background: 'var(--input)',
  color: 'var(--foreground)',
  outline: 'none',
  transition: 'border-color var(--motion-fast), box-shadow var(--motion-fast)',
}

function focusInput(el: HTMLInputElement | HTMLTextAreaElement) {
  el.style.borderColor = 'var(--primary)'
  el.style.boxShadow = '0 0 0 3px rgb(var(--primary-rgb) / 0.12)'
}
function blurInput(el: HTMLInputElement | HTMLTextAreaElement) {
  el.style.borderColor = 'rgb(var(--foreground-rgb) / 0.1)'
  el.style.boxShadow = 'none'
}

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
      <div
        style={{
          height: 44,
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 12px',
          borderBottom: '1px solid rgb(var(--foreground-rgb) / 0.06)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Brain size={15} style={{ color: 'var(--mint)' }} />
          <span
            style={{
              fontSize: 13,
              fontWeight: 600,
              fontFamily: 'var(--font-display)',
              letterSpacing: '-0.01em',
              color: 'var(--foreground)',
            }}
          >
            Memory
          </span>
          <span
            className="font-data"
            style={{
              fontSize: 10,
              color: 'var(--primary)',
              background: 'rgb(var(--primary-rgb) / 0.12)',
              borderRadius: 20,
              padding: '2px 8px',
            }}
          >
            {facts.length} facts · {procedures.length} procs
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button
            type="button"
            onClick={() => void refreshBrowse()}
            aria-label="Refresh"
            className="memory-refresh-btn"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              height: 30,
              padding: '0 11px',
              borderRadius: 7,
              fontSize: 11,
              fontWeight: 500,
              color: muted(0.6),
              background: 'transparent',
              border: '1px solid rgb(var(--foreground-rgb) / 0.1)',
              cursor: 'pointer',
              transition:
                'background var(--motion-fast), border-color var(--motion-fast), color var(--motion-fast)',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'rgb(var(--foreground-rgb) / 0.05)'
              e.currentTarget.style.borderColor = 'rgb(var(--foreground-rgb) / 0.2)'
              e.currentTarget.style.color = 'var(--foreground)'
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'transparent'
              e.currentTarget.style.borderColor = 'rgb(var(--foreground-rgb) / 0.1)'
              e.currentTarget.style.color = muted(0.6)
            }}
          >
            <RefreshCw size={12} /> Refresh
          </button>
          <GitHubStarButton />
        </div>
      </div>

      <div data-testid="memory-panel" style={{ flex: 1, overflow: 'auto', padding: 16 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18, maxWidth: 760 }}>
          {/* Browse-load failure — distinct from a genuinely-empty store. */}
          {!browseOk && (
            <div data-testid="memory-fetch-error">
              <FormattedAlert tone="error">
                <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  Couldn&apos;t load the memory store.
                  <button
                    type="button"
                    onClick={() => void refreshBrowse()}
                    style={{ textDecoration: 'underline', cursor: 'pointer', color: 'inherit' }}
                  >
                    Retry
                  </button>
                </span>
              </FormattedAlert>
            </div>
          )}

          {/* One shared memory — the team's source of truth */}
          <div
            data-testid="memory-shared-banner"
            style={{
              display: 'flex',
              gap: 9,
              alignItems: 'flex-start',
              borderRadius: 10,
              padding: '10px 12px',
              background: 'rgb(var(--mint-rgb) / 0.08)',
              border: '1px solid rgb(var(--mint-rgb) / 0.2)',
            }}
          >
            <Users size={15} style={{ color: 'var(--mint)', flexShrink: 0, marginTop: 1 }} />
            <div style={{ fontSize: 11, color: muted(0.65), lineHeight: 1.55 }}>
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
          <div style={{ fontSize: 11, color: muted(0.5) }}>
            Embedding provider:{' '}
            <span className="font-data" style={{ color: muted(0.75) }}>
              {provider ? `${provider.id} · ${provider.dimensions}d` : 'FTS-only'}
            </span>
            {!provider && (
              <span style={{ color: 'var(--amber)', marginLeft: 8 }}>
                vector / hybrid search degrade to keyword (FTS)
              </span>
            )}
          </div>

          {/* Search */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <SectionLabel>Search</SectionLabel>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input
                data-testid="memory-search-input"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void runSearch()
                }}
                onFocus={(e) => focusInput(e.currentTarget)}
                onBlur={(e) => blurInput(e.currentTarget)}
                placeholder="Search the memory store…"
                style={{ ...inputStyle, flex: 1 }}
              />
              <button
                type="button"
                data-testid="memory-search-run"
                onClick={() => void runSearch()}
                disabled={searching}
                className="memory-action-btn"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 5,
                  fontSize: 12,
                  fontWeight: 600,
                  padding: '8px 12px',
                  borderRadius: 7,
                  border: '1px solid rgb(var(--mint-rgb) / 0.3)',
                  background: 'rgb(var(--mint-rgb) / 0.12)',
                  color: 'var(--mint)',
                  cursor: searching ? 'default' : 'pointer',
                  opacity: searching ? 0.6 : 1,
                  transition: 'background var(--motion-fast)',
                }}
                onMouseEnter={(e) => {
                  if (searching) return
                  e.currentTarget.style.background = 'rgb(var(--mint-rgb) / 0.2)'
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'rgb(var(--mint-rgb) / 0.12)'
                }}
              >
                {searching ? <Spinner size={13} /> : <Search size={13} />} Search
              </button>
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              {MODES.map((m) => {
                const isActive = mode === m
                return (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setMode(m)}
                    className="font-data"
                    style={{
                      fontSize: 11,
                      padding: '3px 10px',
                      borderRadius: 20,
                      border: `1px solid ${isActive ? 'rgb(var(--mint-rgb) / 0.4)' : 'rgb(var(--foreground-rgb) / 0.12)'}`,
                      background: isActive ? 'rgb(var(--mint-rgb) / 0.12)' : 'transparent',
                      color: isActive ? 'var(--mint)' : muted(0.55),
                      cursor: 'pointer',
                      transition: 'background var(--motion-fast), border-color var(--motion-fast)',
                    }}
                    onMouseEnter={(e) => {
                      if (isActive) return
                      e.currentTarget.style.background = 'rgb(var(--foreground-rgb) / 0.05)'
                    }}
                    onMouseLeave={(e) => {
                      if (isActive) return
                      e.currentTarget.style.background = 'transparent'
                    }}
                  >
                    {m}
                  </button>
                )
              })}
            </div>

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
              onFocus={(e) => focusInput(e.currentTarget)}
              onBlur={(e) => blurInput(e.currentTarget)}
              placeholder="Title"
              style={inputStyle}
            />
            <textarea
              data-testid="memory-fact-content"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              onFocus={(e) => focusInput(e.currentTarget)}
              onBlur={(e) => blurInput(e.currentTarget)}
              placeholder="Content"
              rows={3}
              style={{ ...inputStyle, resize: 'vertical', fontFamily: 'inherit' }}
            />
            <input
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              onFocus={(e) => focusInput(e.currentTarget)}
              onBlur={(e) => blurInput(e.currentTarget)}
              placeholder="Tags (comma-separated)"
              style={inputStyle}
            />
            <div>
              <button
                type="button"
                data-testid="memory-save-fact"
                onClick={() => void onSave()}
                disabled={saveDisabled}
                className="memory-action-btn"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  fontSize: 12,
                  fontWeight: 600,
                  padding: '8px 14px',
                  borderRadius: 7,
                  border: '1px solid rgb(var(--mint-rgb) / 0.3)',
                  background: 'rgb(var(--mint-rgb) / 0.12)',
                  color: 'var(--mint)',
                  cursor: saveDisabled ? 'default' : 'pointer',
                  opacity: saveDisabled ? 0.5 : 1,
                  transition: 'background var(--motion-fast)',
                }}
                onMouseEnter={(e) => {
                  if (saveDisabled) return
                  e.currentTarget.style.background = 'rgb(var(--mint-rgb) / 0.2)'
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'rgb(var(--mint-rgb) / 0.12)'
                }}
              >
                {saving && <Spinner size={12} />}
                {saving ? 'Saving…' : 'Save fact'}
              </button>
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
                              fontSize: 10,
                              padding: '1px 6px',
                              borderRadius: 4,
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
