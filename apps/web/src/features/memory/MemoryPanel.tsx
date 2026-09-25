// Memory browser. Browse + manage the MCP memory store the agents share: search
// (fts / vector / hybrid), save a declarative fact, and browse the two tiers
// (facts + versioned procedures). Fact rows surface the learning overlay
// (status pill + outcome trail + Helpful/Outdated feedback) and provenance.
//
// ─── Layout rule: content first, reference last ──────────────────────────────
//
// The order is search, then the memories, then an "About this store" footnote:
// the first screen shows memories, and reference material sits at the foot.
//
// Colour is reserved for real state: the fetch error, the amber degrade note,
// and the learning pills. Nothing else is tinted. Rows live in ONE hairline
// container per section rather than one bordered, shadowed card apiece.

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'

import { motion } from 'framer-motion'
import {
  Brain,
  History,
  ListChecks,
  Plus,
  RefreshCw,
  SearchX,
  ThumbsDown,
  ThumbsUp,
  X,
} from 'lucide-react'

import { GitHubStarButton } from '@/features/promo/GitHubStarButton'
import { resolveRuntimeMark } from '@/features/runtimes/RuntimeBrand'
import { Button, IconButton } from '@/features/shared/Button'
import { Chip } from '@/features/shared/Chip'
import { EmptyState } from '@/features/shared/EmptyState'
import { FormattedAlert } from '@/features/shared/FormattedAlert'
import { PanelHeader } from '@/features/shared/PanelHeader'
import { SearchInput } from '@/features/shared/SearchInput'
import { Skeleton } from '@/features/shared/Skeleton'
import { useFleetStore } from '@/stores/fleet'
import { useToastStore } from '@/stores/toast'
import { ENTER_SPRING, listDelay } from '@/lib/motion'
import {
  browseMemory,
  getOutcomes,
  getProvider,
  recordFeedback,
  saveFact,
  searchMemory,
  type EmbeddingProviderInfo,
  type LearningEntry,
  type MemoryFact,
  type MemoryOutcome,
  type MemoryProcedure,
  type MemorySearchResult,
  type SearchMode,
} from '@/lib/memoryClient'
import { LearningPill, OutcomeTrail, provenanceCaption } from './learningUi'

const muted = (o: number) => `rgb(var(--foreground-rgb) / ${o})`
const MODES: SearchMode[] = ['fts', 'vector', 'hybrid']

const KICKER =
  'font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground'

/** Section label + an optional right-aligned action, on one baseline. */
function SectionRow({ label, action }: { label: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex min-h-[26px] items-center justify-between gap-3">
      <div className={KICKER}>{label}</div>
      {action}
    </div>
  )
}

/** One hairline container holding a section's rows, rather than a bordered,
 *  shadowed card per row. */
function RowGroup({ children }: { children: ReactNode }) {
  return (
    <div className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface">
      {children}
    </div>
  )
}

const META_LINE = 'font-data flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[10.5px]'

/** The scope of a record WITHIN the shared store. Team-shared is the common
 *  case, so it reads as plain metadata rather than a filled pill: only the
 *  exceptions deserve to catch the eye. */
function scopeLabel(agentId: string | null, teamId: string | null): string {
  return agentId ? 'Agent-scoped' : teamId ? 'Team-shared' : 'Global'
}

const INPUT_CLASS =
  'w-full rounded-lg border border-border bg-input px-3 py-2 text-[13.5px] text-foreground outline-none transition placeholder:text-foreground/35 focus:border-primary focus:ring-4 focus:ring-primary/15'

export function MemoryPanel({ headerExtra }: { headerExtra?: ReactNode } = {}) {
  const addToast = useToastStore((s) => s.addToast)
  const agents = useFleetStore((s) => s.agents)
  const [mode, setMode] = useState<SearchMode>('hybrid')
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<MemorySearchResult[]>([])
  const [searched, setSearched] = useState(false)
  const [searching, setSearching] = useState(false)

  const [composerOpen, setComposerOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [tags, setTags] = useState('')
  const [saving, setSaving] = useState(false)

  const [facts, setFacts] = useState<MemoryFact[]>([])
  const [procedures, setProcedures] = useState<MemoryProcedure[]>([])
  const [learning, setLearning] = useState<Record<string, LearningEntry>>({})
  const [provider, setProvider] = useState<EmbeddingProviderInfo | null>(null)
  const [loadingBrowse, setLoadingBrowse] = useState(true)
  const [browseOk, setBrowseOk] = useState(true) // false when the browse load failed → error/retry

  // Outcome-trail expansion (one card at a time) + lazily-fetched full history.
  const [expandedFactId, setExpandedFactId] = useState<string | null>(null)
  const [history, setHistory] = useState<MemoryOutcome[] | null>(null)

  const agentName = useCallback(
    (agentId: string | null) =>
      agentId ? (agents.find((a) => a.id === agentId)?.name ?? agentId.slice(0, 8)) : null,
    [agents],
  )

  // The runtimes actually present on this fleet, never a fixed list: an
  // install that has not connected a runtime must not be told it has.
  const runtimeNames = useMemo(() => {
    const seen = new Set<string>()
    for (const a of agents) seen.add(resolveRuntimeMark(a.runtime).label)
    return [...seen].sort()
  }, [agents])

  const refreshBrowse = useCallback(async () => {
    setLoadingBrowse(true)
    try {
      const b = await browseMemory({ limit: 50 })
      setBrowseOk(b.ok)
      setFacts(b.facts)
      setProcedures(b.procedures)
      setLearning(b.learning)
    } finally {
      setLoadingBrowse(false)
    }
  }, [])

  // Helpful/Outdated → POST feedback → patch the local learning map from the
  // returned entry (no full refetch; the pill updates in place).
  const sendFeedback = useCallback(async (factId: string, outcome: 'useful' | 'dead_end') => {
    const entry = await recordFeedback(factId, outcome)
    if (entry) setLearning((prev) => ({ ...prev, [factId]: entry }))
  }, [])

  const toggleExpanded = useCallback((factId: string) => {
    setHistory(null)
    setExpandedFactId((prev) => (prev === factId ? null : factId))
  }, [])

  useEffect(() => {
    void refreshBrowse()
    void getProvider().then(setProvider)
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
      setComposerOpen(false)
      void refreshBrowse()
    } else {
      // saveFact returns null on a network/non-2xx failure — surface it instead
      // of a silent no-op that looks like the save worked.
      addToast({ type: 'error', message: 'Could not save the fact. Please try again.' })
    }
  }, [title, content, tags, refreshBrowse, addToast])

  const saveDisabled = saving || !title.trim() || !content.trim()
  const firstLoad = loadingBrowse && facts.length === 0 && procedures.length === 0

  // Collapse to the latest version per (name, scope) — the SAME semantic the
  // graph view uses for its procedure count, so the Graph/List toggle never
  // shows two different procedure numbers for the same data.
  const collapsedProcedures = useMemo(() => {
    const groups = new Map<string, { latest: MemoryProcedure; versionCount: number }>()
    for (const p of procedures) {
      const key = `${p.name} ${p.scopeTeamId ?? ''} ${p.scopeAgentId ?? ''}`
      const g = groups.get(key)
      if (!g) groups.set(key, { latest: p, versionCount: 1 })
      else {
        g.versionCount += 1
        if (p.version > g.latest.version) g.latest = p
      }
    }
    return [...groups.values()]
  }, [procedures])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <PanelHeader
        title="Memory"
        subtitle={`${facts.length} facts · ${collapsedProcedures.length} procedures`}
        icon={Brain}
        border
        actions={
          <>
            {headerExtra}
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

      <div data-testid="memory-panel" style={{ flex: 1, overflow: 'auto' }} className="px-6 py-5">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 26, maxWidth: 760 }}>
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

          {/* ── Search ─────────────────────────────────────────────────────
              No red primary here. Searching a store you own is not a
              destructive commitment, and the accent is worth more reserved
              for the one thing on the page that writes. */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <SearchInput
                data-testid="memory-search-input"
                value={query}
                onChange={setQuery}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void runSearch()
                }}
                placeholder="Search the memory store…"
                aria-label="Search the memory store"
              />
              <Button
                data-testid="memory-search-run"
                onClick={() => void runSearch()}
                loading={searching}
                variant="secondary"
                size="md"
                className="shrink-0"
              >
                Search
              </Button>
            </div>

            {/* The mode picker is only honest when an embedding provider backs
                it. With none, vector and hybrid both fall through to keyword,
                so offering three equal choices would be a lie; the note says
                why instead. */}
            {provider && (
              <div style={{ display: 'flex', gap: 6 }}>
                {MODES.map((m) => (
                  <Chip key={m} size="sm" active={mode === m} onClick={() => setMode(m)}>
                    {m}
                  </Chip>
                ))}
              </div>
            )}
            {!provider && (
              <p className="text-[11.5px]" style={{ color: 'var(--muted-foreground)' }}>
                No embedding provider, so search matches on keywords only.
              </p>
            )}

            {results.length > 0 && (
              <RowGroup>
                {results.map((r, i) => (
                  <motion.div
                    key={r.id}
                    data-testid="memory-result"
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ ...ENTER_SPRING, delay: listDelay(i) }}
                    className="px-3.5 py-3"
                  >
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="text-[13px] font-semibold text-foreground">{r.title}</span>
                      <span className="flex shrink-0 items-center gap-2">
                        <LearningPill learning={r.learning} />
                        <span
                          className="font-data text-[10.5px]"
                          style={{ color: 'var(--muted-foreground)' }}
                        >
                          {r.matchedVia} {r.score.toFixed(2)}
                        </span>
                      </span>
                    </div>
                    <div
                      className="mt-1 text-[12px] leading-relaxed"
                      style={{ color: 'var(--muted-foreground)' }}
                    >
                      {r.content.slice(0, 240)}
                      {r.content.length > 240 ? '…' : ''}
                    </div>
                  </motion.div>
                ))}
              </RowGroup>
            )}
            {searched && results.length === 0 && (
              <EmptyState
                icon={SearchX}
                title="No matches"
                helper="Nothing in the shared store matched this query. Try a different term."
                paddingTop={20}
              />
            )}
          </div>

          {/* ── Facts ──────────────────────────────────────────────────── */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <SectionRow
              label={`Facts (${facts.length})`}
              action={
                !composerOpen && (
                  <Button
                    data-testid="memory-add-fact"
                    variant="ghost"
                    size="sm"
                    onClick={() => setComposerOpen(true)}
                  >
                    <Plus size={13} strokeWidth={2} /> Add a fact
                  </Button>
                )
              }
            />

            {/* Writing a fact by hand is the rare case: agents own this store.
                So the composer is disclosed, not three empty inputs parked
                above the content on every visit. */}
            {composerOpen && (
              <motion.div
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                transition={ENTER_SPRING}
                className="flex flex-col gap-2 rounded-xl border border-border bg-surface p-3.5"
              >
                <input
                  data-testid="memory-fact-title"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Title"
                  autoFocus
                  className={INPUT_CLASS}
                />
                <textarea
                  data-testid="memory-fact-content"
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                  placeholder="What should the team remember?"
                  rows={3}
                  className={`${INPUT_CLASS} resize-y`}
                />
                <input
                  value={tags}
                  onChange={(e) => setTags(e.target.value)}
                  placeholder="Tags (comma-separated)"
                  className={INPUT_CLASS}
                />
                <div className="flex items-center gap-2">
                  <Button
                    data-testid="memory-save-fact"
                    onClick={() => void onSave()}
                    disabled={saveDisabled}
                    loading={saving}
                    variant="primary"
                    size="sm"
                  >
                    {saving ? 'Saving…' : 'Save fact'}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setComposerOpen(false)}>
                    <X size={13} strokeWidth={2} /> Cancel
                  </Button>
                </div>
              </motion.div>
            )}

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
                paddingTop={24}
              />
            ) : (
              <RowGroup>
                {facts.map((f, i) => {
                  const entry = learning[f.id] ?? null
                  const caption = provenanceCaption(f, agentName(f.createdByAgentId))
                  const expanded = expandedFactId === f.id
                  return (
                    <motion.div
                      key={f.id}
                      initial={{ opacity: 0, y: 4 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ ...ENTER_SPRING, delay: listDelay(i) }}
                    >
                      {/* Row click toggles the outcome trail; the feedback
                          buttons stopPropagation so they never flip it. */}
                      <div
                        data-testid="memory-fact-card"
                        onClick={() => toggleExpanded(f.id)}
                        className="cursor-pointer px-3.5 py-3 transition-colors hover:bg-foreground/[0.02]"
                      >
                        <div className="flex items-baseline justify-between gap-3">
                          <span className="text-[13px] font-semibold text-foreground">
                            {f.title}
                          </span>
                          <span className="shrink-0">
                            <LearningPill learning={entry} />
                          </span>
                        </div>

                        <div
                          className="mt-1 text-[12px] leading-relaxed"
                          style={{ color: 'var(--muted-foreground)' }}
                        >
                          {f.content.slice(0, 200)}
                          {f.content.length > 200 ? '…' : ''}
                        </div>

                        <div className="mt-2 flex items-end justify-between gap-3">
                          {/* Scope and provenance are ONE span, not two joined
                              by a separator span: a standalone "·" becomes a
                              stranded bullet at the end of a line the moment
                              this wraps, which it does at modal width. */}
                          <div className={META_LINE} style={{ color: 'var(--muted-foreground)' }}>
                            {f.tags.map((t) => (
                              <span
                                key={t}
                                className="rounded px-1.5 py-0.5"
                                style={{ background: muted(0.05) }}
                              >
                                {t}
                              </span>
                            ))}
                            {/* The testid stays on the caption ALONE: a test
                                asserts its exact text, so it must not pick up
                                the tags and scope sharing this line. */}
                            <span>
                              {scopeLabel(f.scopeAgentId, f.scopeTeamId)}
                              {caption && ' · '}
                              {caption && <span data-testid="memory-provenance">{caption}</span>}
                            </span>
                          </div>
                          {/* Icon-only: a per-row action repeated down a list
                              must not carry the same weight as the titles. */}
                          <div className="flex shrink-0 items-center gap-0.5">
                            <IconButton
                              data-testid="memory-fact-helpful"
                              label="Helpful"
                              variant="ghost"
                              size="sm"
                              onClick={(e) => {
                                e.stopPropagation()
                                void sendFeedback(f.id, 'useful')
                              }}
                            >
                              <ThumbsUp size={13} strokeWidth={2} />
                            </IconButton>
                            <IconButton
                              data-testid="memory-fact-outdated"
                              label="Outdated"
                              variant="ghost"
                              size="sm"
                              onClick={(e) => {
                                e.stopPropagation()
                                void sendFeedback(f.id, 'dead_end')
                              }}
                            >
                              <ThumbsDown size={13} strokeWidth={2} />
                            </IconButton>
                          </div>
                        </div>

                        {expanded && (
                          <div
                            data-testid="memory-fact-trail"
                            onClick={(e) => e.stopPropagation()}
                            style={{
                              display: 'flex',
                              flexDirection: 'column',
                              gap: 6,
                              marginTop: 10,
                              paddingTop: 10,
                              borderTop: `1px solid ${muted(0.07)}`,
                              cursor: 'default',
                            }}
                          >
                            <OutcomeTrail items={entry?.recentTrail ?? []} />
                            {history && history.length > 0 && (
                              <div
                                data-testid="memory-fact-history"
                                style={{ display: 'flex', flexDirection: 'column', gap: 4 }}
                              >
                                <div className={KICKER}>Full history</div>
                                <OutcomeTrail
                                  items={history.map((o) => ({
                                    kind: o.outcome,
                                    createdAt: o.createdAt,
                                    agentId: o.agentId,
                                    taskId: o.taskId,
                                    runtime: o.runtime,
                                    note: o.note,
                                  }))}
                                />
                              </div>
                            )}
                            {(entry?.uses ?? 0) > 0 && history === null && (
                              <div>
                                <Button
                                  data-testid="memory-fact-full-history"
                                  variant="ghost"
                                  size="sm"
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    void getOutcomes(f.id).then(setHistory)
                                  }}
                                >
                                  <History size={12} strokeWidth={2} /> Full history
                                </Button>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    </motion.div>
                  )
                })}
              </RowGroup>
            )}
          </div>

          {/* ── Procedures (collapsed to latest version per name+scope,
              matching the graph; older versions summarised by a "+N"). ─── */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <SectionRow label={`Procedures (${collapsedProcedures.length})`} />
            {firstLoad ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {[0, 1].map((i) => (
                  <Skeleton key={i} height={62} radius={10} />
                ))}
              </div>
            ) : collapsedProcedures.length === 0 ? (
              <EmptyState
                icon={ListChecks}
                title="No procedures yet"
                helper="Versioned, reusable procedures the team builds up will be listed here."
                paddingTop={24}
              />
            ) : (
              <RowGroup>
                {collapsedProcedures.map(({ latest: p, versionCount }, i) => (
                  <motion.div
                    key={p.id}
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ ...ENTER_SPRING, delay: listDelay(i) }}
                    className="px-3.5 py-3"
                  >
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="text-[13px] font-semibold text-foreground">{p.name}</span>
                      <span
                        className="font-data shrink-0 text-[10.5px]"
                        style={{ color: 'var(--muted-foreground)' }}
                      >
                        v{p.version}
                        {versionCount > 1 ? ` +${versionCount - 1}` : ''}
                      </span>
                    </div>
                    <div
                      className="mt-1 text-[12px] leading-relaxed"
                      style={{ color: 'var(--muted-foreground)' }}
                    >
                      {p.content.slice(0, 200)}
                      {p.content.length > 200 ? '…' : ''}
                    </div>
                    <div
                      className={`${META_LINE} mt-2`}
                      style={{ color: 'var(--muted-foreground)' }}
                    >
                      {scopeLabel(p.scopeAgentId, p.scopeTeamId)}
                    </div>
                  </motion.div>
                ))}
              </RowGroup>
            )}
          </div>

          {/* ── About this store ────────────────────────────────────────
              Reference, not an announcement: a caption and a two-row spec
              table at the foot of the page, below the content the user came
              for. */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <SectionRow label="About this store" />
            <p
              data-testid="memory-shared-banner"
              className="text-[12px] leading-relaxed"
              style={{ color: 'var(--muted-foreground)', maxWidth: '62ch' }}
            >
              Every runtime on the team reads and writes this one store through the Memory tool.
              Each also keeps a private self-model that stays with that runtime and is never edited
              here.
            </p>
            <div className="overflow-hidden rounded-xl border border-border bg-surface">
              <dl className="divide-y divide-border">
                <div className="flex items-baseline gap-4 px-3.5 py-2.5">
                  <dt
                    className="w-[140px] shrink-0 text-[12px]"
                    style={{ color: 'var(--muted-foreground)' }}
                  >
                    Embedding provider
                  </dt>
                  <dd className="flex flex-1 flex-col gap-1">
                    <span
                      data-testid="memory-embedding-provider"
                      className="font-data text-[12px] text-foreground"
                    >
                      {provider
                        ? `${provider.id} · ${provider.dimensions}d`
                        : 'None, keyword search only'}
                    </span>
                  </dd>
                </div>
                <div className="flex items-baseline gap-4 px-3.5 py-2.5">
                  <dt
                    className="w-[140px] shrink-0 text-[12px]"
                    style={{ color: 'var(--muted-foreground)' }}
                  >
                    Private self-models
                  </dt>
                  <dd className="font-data flex-1 text-[12px] text-foreground">
                    {runtimeNames.length > 0 ? runtimeNames.join(', ') : 'managed by each runtime'}
                  </dd>
                </div>
              </dl>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
