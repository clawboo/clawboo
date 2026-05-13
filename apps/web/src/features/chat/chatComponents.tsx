import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ChangeEvent,
} from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { AnimatePresence, motion } from 'framer-motion'
import { ArrowRight, ChevronRight, Clock, SendHorizontal, Square, Wrench } from 'lucide-react'
import { BooAvatar, resolveBooTint } from '@clawboo/ui'
import type { TranscriptEntry } from '@clawboo/protocol'
import { AgentBooAvatar } from '@/components/AgentBooAvatar'
import { useFleetStore } from '@/stores/fleet'
import { useChatStore } from '@/stores/chat'
import { useBooZeroStore } from '@/stores/booZero'
import { calculateCostUsd, formatCost } from '@/features/cost/costUtils'
import {
  buildDelegationLinkages,
  type DelegationLinkage,
} from '@/features/group-chat/buildDelegationLinkages'
import { splitAssistantText } from './splitAssistantText'

// ─── Helpers ──────────────────────────────────────────────────────────────────

export const formatTimestamp = (ms: number) =>
  new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  }).format(new Date(ms))

export const formatDuration = (ms: number) => {
  const s = ms / 1000
  if (!Number.isFinite(s) || s <= 0) return '0s'
  return s < 10 ? `${s.toFixed(1)}s` : `${Math.round(s)}s`
}

/** Parse [[tool]] / [[tool-result]] lines from the protocol. */
export function parseToolEntry(
  text: string,
): { kind: 'call' | 'result'; name: string; body: string } | null {
  const isCall = text.startsWith('[[tool]]')
  const isResult = text.startsWith('[[tool-result]]')
  if (!isCall && !isResult) return null
  const prefix = isCall ? '[[tool]]' : '[[tool-result]]'
  const rest = text.slice(prefix.length)
  const nl = rest.indexOf('\n')
  const name = (nl === -1 ? rest : rest.slice(0, nl)).trim()
  const body = nl === -1 ? '' : rest.slice(nl + 1).trim()
  return { kind: isCall ? 'call' : 'result', name, body }
}

/**
 * Inline @mention highlighting for group chat messages.
 * Highlights @AgentName at message start using longest-prefix, case-insensitive match.
 */
function renderMentionInline(text: string, knownAgentNames: string[]): import('react').ReactNode {
  if (!text.startsWith('@')) return text
  const afterAt = text.slice(1)
  const sorted = [...knownAgentNames].sort((a, b) => b.length - a.length)
  for (const name of sorted) {
    if (afterAt.toLowerCase().startsWith(name.toLowerCase())) {
      const rest = afterAt.slice(name.length)
      if (rest.length === 0 || /^\s/.test(rest)) {
        return (
          <>
            <span className="font-semibold text-accent">@{name}</span>
            {rest}
          </>
        )
      }
    }
  }
  return text
}

// ─── Relay message helpers ────────────────────────────────────────────────────

/** Check if an assistant entry is a relay message (starts with [Team Update]). */
function isTeamUpdateEntry(entry: TranscriptEntry | null): boolean {
  return entry?.text?.startsWith('[Team Update]') ?? false
}

/** Strip the [Team Update] prefix and return the clean text. */
function stripRelayPrefix(text: string): string {
  return text.replace(/^\[Team Update\]\s*/, '')
}

// ─── Grouping: flatten TranscriptEntry[] → render blocks ─────────────────────

export type MetaBlock = { kind: 'meta'; entry: TranscriptEntry }
export type UserBlock = { kind: 'user'; entry: TranscriptEntry }
export type AssistantBlock = {
  kind: 'assistant-turn'
  assistant: TranscriptEntry | null
  thinking: TranscriptEntry[]
  tools: TranscriptEntry[]
  timestampMs: number | null
  thinkingDurationMs?: number
}
export type RenderBlock = MetaBlock | UserBlock | AssistantBlock

// InProgressTurn is the mutable accumulator — separate from AssistantBlock
// so TypeScript can track it cleanly without closure-narrowing ambiguity.
export type InProgressTurn = {
  thinking: TranscriptEntry[]
  tools: TranscriptEntry[]
  assistant: TranscriptEntry | null
  timestampMs: number | null
  thinkingDurationMs?: number
}

export function groupEntriesToBlocks(entries: TranscriptEntry[]): RenderBlock[] {
  const blocks: RenderBlock[] = []
  let activeTurn: InProgressTurn | null = null

  const commitTurn = () => {
    const t = activeTurn
    if (!t) return
    activeTurn = null
    if (t.assistant || t.thinking.length > 0 || t.tools.length > 0) {
      blocks.push({
        kind: 'assistant-turn',
        assistant: t.assistant,
        thinking: t.thinking,
        tools: t.tools,
        timestampMs: t.timestampMs,
        thinkingDurationMs: t.thinkingDurationMs,
      })
    }
  }

  const getOrCreateTurn = (entry: TranscriptEntry): InProgressTurn => {
    if (!activeTurn) {
      activeTurn = { thinking: [], tools: [], assistant: null, timestampMs: entry.timestampMs }
    }
    return activeTurn
  }

  for (const entry of entries) {
    // Skip injected context preamble entries (should not appear in UI)
    if (entry.text.startsWith('[Team Context')) continue

    if (entry.kind === 'meta') {
      commitTurn()
      blocks.push({ kind: 'meta', entry })
      continue
    }

    if (entry.kind === 'user') {
      commitTurn()
      blocks.push({ kind: 'user', entry })
      continue
    }

    if (entry.kind === 'thinking') {
      getOrCreateTurn(entry).thinking.push(entry)
      continue
    }

    if (entry.kind === 'tool') {
      getOrCreateTurn(entry).tools.push(entry)
      continue
    }

    // entry.kind === 'assistant'
    // Snapshot activeTurn into a const so TS narrows cleanly (avoids
    // "never" inference caused by mutation inside closure helpers).
    const snapshot = activeTurn as InProgressTurn | null
    if (snapshot !== null && snapshot.assistant !== null) commitTurn()
    const t = getOrCreateTurn(entry)
    t.assistant = entry
    if (entry.timestampMs !== null) t.timestampMs = entry.timestampMs
  }

  commitTurn()
  return blocks
}

// ─── Markdown renderer ────────────────────────────────────────────────────────

export const MD_COMPONENTS: React.ComponentProps<typeof ReactMarkdown>['components'] = {
  code({ className, children, ...rest }) {
    const isBlock = /language-/.test(className ?? '')
    if (isBlock) {
      return (
        <pre className="my-2 overflow-x-auto rounded-md bg-black/30 p-3 text-[12px]">
          <code className={`font-mono ${className ?? ''}`} {...rest}>
            {children}
          </code>
        </pre>
      )
    }
    return (
      <code className="rounded bg-white/8 px-1 py-0.5 font-mono text-[0.875em] text-mint" {...rest}>
        {children}
      </code>
    )
  },
  a({ children, href }) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        className="text-mint underline underline-offset-2 hover:text-mint/80"
      >
        {children}
      </a>
    )
  },
  p({ children }) {
    return <p className="my-1 leading-relaxed">{children}</p>
  },
}

// ─── TypingIndicator ──────────────────────────────────────────────────────────

export const TypingIndicator = memo(function TypingIndicator() {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="flex items-center gap-2 rounded-md bg-surface px-3 py-2 text-secondary"
    >
      <span className="font-mono text-[11px] tracking-wide">Thinking</span>
      <span className="flex gap-1">
        {[0, 1, 2].map((i) => (
          <motion.span
            key={i}
            className="inline-block h-1 w-1 rounded-full bg-secondary"
            animate={{ opacity: [0.3, 1, 0.3] }}
            transition={{ repeat: Infinity, duration: 1.2, delay: i * 0.2 }}
          />
        ))}
      </span>
    </motion.div>
  )
})

// ─── ToolCallCard ─────────────────────────────────────────────────────────────

export const ToolCallCard = memo(function ToolCallCard({ entry }: { entry: TranscriptEntry }) {
  const [open, setOpen] = useState(false)
  const parsed = parseToolEntry(entry.text)
  if (!parsed) return null

  const label = `${parsed.kind === 'call' ? '⬆' : '⬇'} ${parsed.name.toUpperCase()}`
  const hasBody = Boolean(parsed.body)

  return (
    <div className="rounded-md border border-white/8 bg-black/20 text-[11px]">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left"
        onClick={() => hasBody && setOpen((v) => !v)}
        disabled={!hasBody}
      >
        <Wrench className="h-3 w-3 shrink-0 text-amber" strokeWidth={2} />
        <span className="font-mono font-semibold tracking-wider text-amber/80">{label}</span>
        {hasBody && (
          <ChevronRight
            className={`ml-auto h-3 w-3 shrink-0 text-secondary transition-transform ${open ? 'rotate-90' : ''}`}
          />
        )}
      </button>
      <AnimatePresence initial={false}>
        {open && hasBody && (
          <motion.div
            key="body"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="overflow-hidden"
          >
            <pre className="overflow-x-auto border-t border-white/8 px-3 py-2 font-mono text-[11px] text-secondary">
              {parsed.body}
            </pre>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
})

// ─── ThinkingSection ──────────────────────────────────────────────────────────

export const ThinkingSection = memo(function ThinkingSection({
  entries,
  thinkingDurationMs,
  streaming,
}: {
  entries: TranscriptEntry[]
  thinkingDurationMs?: number
  streaming?: boolean
}) {
  const [open, setOpen] = useState(false)
  const fullText = entries.map((e) => e.text).join('\n\n')
  if (!fullText && !streaming) return null

  return (
    <div className="rounded-md bg-surface text-[11px] text-secondary">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left opacity-70 hover:opacity-100"
        onClick={() => setOpen((v) => !v)}
      >
        <ChevronRight
          className={`h-3 w-3 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}
        />
        <span className="font-mono font-medium tracking-wide">Thinking (internal)</span>
        {typeof thinkingDurationMs === 'number' && (
          <span className="ml-1 flex items-center gap-1 opacity-70">
            <Clock className="h-2.5 w-2.5" />
            {formatDuration(thinkingDurationMs)}
          </span>
        )}
        {streaming && (
          <span className="ml-1 flex gap-1">
            {[0, 1, 2].map((i) => (
              <motion.span
                key={i}
                className="inline-block h-1 w-1 rounded-full bg-secondary"
                animate={{ opacity: [0.3, 1, 0.3] }}
                transition={{ repeat: Infinity, duration: 1.2, delay: i * 0.2 }}
              />
            ))}
          </span>
        )}
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="content"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18 }}
            className="overflow-hidden"
          >
            <div className="px-4 pb-3 pt-1 text-[12px] leading-relaxed text-text/70">
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>
                {fullText || '…'}
              </ReactMarkdown>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
})

// ─── MetaMessageCard ─────────────────────────────────────────────────────────

export const MetaMessageCard = memo(function MetaMessageCard({
  entry,
}: {
  entry: TranscriptEntry
}) {
  return (
    <div className="flex justify-center">
      <p className="rounded-full bg-surface px-4 py-1.5 font-mono text-[11px] text-secondary/60">
        {entry.text}
      </p>
    </div>
  )
})

// ─── UserMessageCard ──────────────────────────────────────────────────────────

export const UserMessageCard = memo(function UserMessageCard({
  entry,
  targetAgentName,
  knownAgentNames,
}: {
  entry: TranscriptEntry
  targetAgentName?: string
  /** Known agent names for @mention highlighting in group chat. */
  knownAgentNames?: string[]
}) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[70ch] overflow-hidden rounded-xl rounded-br-sm bg-blue/60 shadow-sm">
        <div className="flex items-center justify-between gap-4 border-b border-white/8 px-3 py-1.5">
          <span className="font-mono text-[10px] font-semibold uppercase tracking-widest text-text/70">
            {targetAgentName ? `You → ${targetAgentName}` : 'You'}
          </span>
          {entry.timestampMs && (
            <time className="font-mono text-[10px] text-secondary/60">
              {formatTimestamp(entry.timestampMs)}
            </time>
          )}
        </div>
        <div className="px-3 py-2.5 text-[13px] leading-relaxed text-text">
          {knownAgentNames && entry.text.startsWith('@') ? (
            renderMentionInline(entry.text, knownAgentNames)
          ) : (
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>
              {entry.text}
            </ReactMarkdown>
          )}
        </div>
      </div>
    </div>
  )
})

// ─── DelegationCard ───────────────────────────────────────────────────────────
// Renders a `<delegate to="@Name">task</delegate>` block as a styled card
// inside the assistant turn. When a `linkage` is supplied (group-chat path),
// the target's reply nests inside the card via a collapsible body. Without
// a linkage (1:1 chat path), the card renders header-only, matching the
// pre-nesting behaviour.

const MAX_NEST_DEPTH = 4

export const DelegationCard = memo(function DelegationCard({
  targetName,
  task,
  linkage,
  teamId,
  defaultExpanded = true,
  depth = 0,
  latestSourceEntryId,
}: {
  targetName: string
  task: string
  linkage?: DelegationLinkage
  teamId?: string
  defaultExpanded?: boolean
  depth?: number
  latestSourceEntryId?: string | null
}) {
  // Resolve target agent — prefer the linkage's resolved id (covers cases
  // where the LLM wrote a partial / case-mismatched name and we already
  // mapped it to the canonical roster entry).
  const targetAgentIdFromStore = useFleetStore(
    (s) => s.agents.find((a) => a.name === targetName)?.id ?? null,
  )
  const targetAgentId = linkage?.targetAgentId ?? targetAgentIdFromStore
  const booZeroAgentId = useBooZeroStore((s) => s.booZeroAgentId)
  const isBooZero = targetAgentId !== null && targetAgentId === booZeroAgentId
  const avatarSeed = targetAgentId ?? targetName

  // Target tint — same hex the avatar paints with, lifted from boo-avatar.
  // Fall back to the existing emerald when we can't resolve a target.
  const tint = targetAgentId ? resolveBooTint(targetAgentId, isBooZero) : '#10b981'

  // Streaming text for the target — only the FIRST pending delegation per
  // target session owns the live stream. Subsequent pending delegations
  // wait their turn (queued by the Gateway anyway).
  const ownsStreaming = Boolean(linkage?.isPending && linkage?.targetSessionKey && teamId)
  const streamingText = useChatStore((s) =>
    ownsStreaming && linkage?.targetSessionKey
      ? (s.streamingText.get(linkage.targetSessionKey) ?? null)
      : null,
  )

  const hasLinkedBody = Boolean(
    linkage && (linkage.linkedEntries.length > 0 || streamingText !== null || linkage.isPending),
  )
  const canCollapse = hasLinkedBody && depth < MAX_NEST_DEPTH

  const [expanded, setExpanded] = useState(defaultExpanded)

  return (
    <div
      className="flex flex-col gap-1.5 rounded-lg py-2 pr-3 pl-3"
      style={{
        borderLeft: `2px solid ${tint}66`,
        background: `${tint}0a`,
      }}
      data-testid="delegation-card"
      data-delegation-id={linkage?.delegationId}
    >
      <div className="flex items-center gap-2">
        <BooAvatar seed={avatarSeed} size={20} />
        <ArrowRight size={11} style={{ color: `${tint}b3` }} />
        <span
          className="font-mono text-[10px] font-semibold uppercase tracking-widest"
          style={{ color: tint }}
        >
          Delegated to
        </span>
        <span className="font-mono text-[10px] font-medium text-text">@{targetName}</span>
        {canCollapse && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="ml-auto flex h-5 w-5 items-center justify-center rounded hover:bg-white/5"
            aria-label={expanded ? 'Collapse delegation' : 'Expand delegation'}
            data-testid="delegation-toggle"
          >
            <ChevronRight
              size={12}
              style={{ color: tint }}
              className={`shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`}
            />
          </button>
        )}
      </div>
      <div className="text-[12px] leading-relaxed whitespace-pre-wrap text-secondary/80">
        {task}
      </div>
      <AnimatePresence initial={false}>
        {expanded && hasLinkedBody && linkage && (
          <motion.div
            key="body"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18 }}
            className="overflow-hidden"
            data-testid="delegation-card-body"
          >
            <div
              className="mt-1.5 flex flex-col gap-2 border-t pt-2 text-[13px] leading-relaxed text-text/95"
              style={{ borderColor: `${tint}1a` }}
            >
              <NestedDelegationBody
                entries={linkage.linkedEntries}
                streamingText={streamingText}
                teamId={teamId}
                depth={depth + 1}
                latestSourceEntryId={latestSourceEntryId}
              />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
})

// ─── NestedDelegationBody ─────────────────────────────────────────────────────
// Renders the target's reply chunk inside a DelegationCard: thinking section,
// tool calls, assistant prose (with recursive nested DelegationCards for any
// `<delegate>` blocks the target itself emitted), and the live streaming
// text when the target is still typing.

const NestedDelegationBody = memo(function NestedDelegationBody({
  entries,
  streamingText,
  teamId,
  depth,
  latestSourceEntryId,
}: {
  entries: TranscriptEntry[]
  streamingText: string | null
  teamId?: string
  depth: number
  latestSourceEntryId?: string | null
}) {
  // Group entries into the same Thinking / Tool / Assistant buckets the
  // top-level renderer uses, so the nested body mirrors the visual rhythm.
  const grouped = useMemo(() => groupEntriesToBlocks(entries), [entries])
  // Linkages for any nested `<delegate>` blocks inside the target's reply.
  // Built per-source so we don't need to re-derive across the whole
  // conversation here — the parent computation already covers ancestors
  // and the deeper levels are scoped to this body.
  const nestedLinkages = useNestedLinkages(entries, teamId)

  const hasContent = entries.length > 0 || (streamingText !== null && streamingText.length > 0)
  if (!hasContent) {
    return <TypingIndicator />
  }

  return (
    <>
      {grouped.map((block, i) => {
        if (block.kind === 'meta') {
          return <MetaMessageCard key={block.entry.entryId} entry={block.entry} />
        }
        if (block.kind === 'user') {
          return <UserMessageCard key={block.entry.entryId} entry={block.entry} />
        }
        return (
          <NestedAssistantContent
            key={`nested-${i}`}
            block={block}
            linkagesBySourceEntry={nestedLinkages}
            teamId={teamId}
            depth={depth}
            latestSourceEntryId={latestSourceEntryId}
          />
        )
      })}
      {streamingText !== null && streamingText.length > 0 && (
        <div className="whitespace-pre-wrap text-text/80" data-testid="delegation-streaming">
          {streamingText}
        </div>
      )}
      {streamingText !== null && streamingText.length === 0 && <TypingIndicator />}
    </>
  )
})

// Build linkages for delegations that appear INSIDE the target's reply,
// scoped to those entries only. Pure derivation; no Zustand subscription.
function useNestedLinkages(
  entries: TranscriptEntry[],
  teamId: string | undefined,
): Map<string, DelegationLinkage[]> {
  // Pull participants from the fleet store ONCE — the team-id filter is
  // applied inside the helper. We include Boo Zero (teamless) too so its
  // delegations from nested replies resolve.
  const agents = useFleetStore((s) => s.agents)
  const booZeroAgentId = useBooZeroStore((s) => s.booZeroAgentId)
  return useMemo(() => {
    if (!teamId || entries.length === 0) return new Map()
    const teamAgents = agents
      .filter((a) => a.teamId === teamId)
      .map((a) => ({ id: a.id, name: a.name }))
    const booZero = booZeroAgentId ? agents.find((a) => a.id === booZeroAgentId) : null
    const participants = booZero
      ? [...teamAgents, { id: booZero.id, name: booZero.name }]
      : teamAgents
    // Defensive dedup (same shape as GroupChatPanel.participants).
    const seen = new Set<string>()
    const deduped = participants.filter((p) => {
      if (seen.has(p.id)) return false
      seen.add(p.id)
      return true
    })
    const blocks = groupEntriesToBlocks(entries)
    const result = buildDelegationLinkages({
      blocks,
      mergedEntries: entries,
      teamId,
      participants: deduped,
    })
    return result.linkagesBySourceEntry
  }, [agents, booZeroAgentId, entries, teamId])
}

// ─── NestedAssistantContent ───────────────────────────────────────────────────
// Compact assistant renderer used INSIDE a DelegationCard body. Skips the
// outer agent-identity header/footer (the parent card already conveys who
// is replying) and recurses into nested DelegationCards for any `<delegate>`
// blocks inside.

const NestedAssistantContent = memo(function NestedAssistantContent({
  block,
  linkagesBySourceEntry,
  teamId,
  depth,
  latestSourceEntryId,
}: {
  block: AssistantBlock
  linkagesBySourceEntry: Map<string, DelegationLinkage[]>
  teamId?: string
  depth: number
  latestSourceEntryId?: string | null
}) {
  const isRelay = isTeamUpdateEntry(block.assistant)
  const hasThinking = block.thinking.length > 0
  const hasTools = block.tools.length > 0
  const hasText = Boolean(block.assistant?.text)
  const linkagesForBlock = block.assistant
    ? (linkagesBySourceEntry.get(block.assistant.entryId) ?? [])
    : []
  const linkageByBlockStart = useMemo(() => {
    const map = new Map<number, DelegationLinkage>()
    for (const l of linkagesForBlock) map.set(l.blockStart, l)
    return map
  }, [linkagesForBlock])

  return (
    <div className="flex flex-col gap-2">
      {hasThinking && (
        <ThinkingSection entries={block.thinking} thinkingDurationMs={block.thinkingDurationMs} />
      )}
      {hasTools && (
        <div className="flex flex-col gap-1">
          {block.tools.map((entry) => (
            <ToolCallCard key={entry.entryId} entry={entry} />
          ))}
        </div>
      )}
      {hasText && (
        <div className="flex flex-col gap-2 text-[13px] leading-relaxed text-text/95">
          {splitAssistantText(
            isRelay ? stripRelayPrefix(block.assistant!.text) : block.assistant!.text,
          ).map((segment, idx) => {
            if (segment.kind === 'delegation') {
              const nestedLinkage = linkageByBlockStart.get(segment.blockStart)
              const expandedDefault = block.assistant
                ? block.assistant.entryId === latestSourceEntryId
                : true
              return (
                <DelegationCard
                  key={`nested-delegation-${idx}`}
                  targetName={segment.targetName}
                  task={segment.task}
                  linkage={nestedLinkage}
                  teamId={teamId}
                  defaultExpanded={expandedDefault}
                  depth={depth}
                  latestSourceEntryId={latestSourceEntryId}
                />
              )
            }
            return (
              <ReactMarkdown
                key={`nested-prose-${idx}`}
                remarkPlugins={[remarkGfm]}
                components={MD_COMPONENTS}
              >
                {segment.text}
              </ReactMarkdown>
            )
          })}
        </div>
      )}
    </div>
  )
})

// ─── AssistantTurnCard ────────────────────────────────────────────────────────

export const AssistantTurnCard = memo(function AssistantTurnCard({
  block,
  agentId,
  agentName,
  streaming,
  linkagesBySourceEntry,
  teamId,
  latestSourceEntryId,
}: {
  block: AssistantBlock
  agentId: string
  agentName: string
  streaming?: boolean
  /** Group-chat-only: pass-through so DelegationCard segments can nest target replies. */
  linkagesBySourceEntry?: Map<string, DelegationLinkage[]>
  /** Group-chat-only: needed by nested DelegationCards to resolve target session keys. */
  teamId?: string
  /** Group-chat-only: source entryId whose delegations default-expand (newest exposed). */
  latestSourceEntryId?: string | null
}) {
  const isRelay = isTeamUpdateEntry(block.assistant)
  const hasThinking = block.thinking.length > 0
  const hasTools = block.tools.length > 0
  const hasText = Boolean(block.assistant?.text)
  const charCount = block.assistant?.text?.length ?? 0
  const runId = block.assistant?.runId ?? null
  const tokenUsage = useChatStore((s) => (runId ? (s.lastTokenUsage.get(runId) ?? null) : null))
  const agent = useFleetStore((s) => s.agents.find((a) => a.id === agentId))
  const costUsd =
    tokenUsage && agent?.model
      ? calculateCostUsd(agent.model, tokenUsage.inputTokens, tokenUsage.outputTokens)
      : null

  return (
    <div
      className={`flex flex-col gap-2${isRelay ? ' border-l-2 border-emerald-500/40 pl-3 opacity-80' : ''}`}
    >
      {/* Header */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <AgentBooAvatar agentId={agentId} size={22} />
          <span className="font-mono text-[10px] font-semibold uppercase tracking-widest text-secondary/70">
            {agentName}
          </span>
          {isRelay && (
            <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 font-mono text-[9px] font-medium text-emerald-400">
              Team Update
            </span>
          )}
        </div>
        {block.timestampMs && (
          <time className="font-mono text-[10px] text-secondary/50">
            {formatTimestamp(block.timestampMs)}
          </time>
        )}
      </div>

      {/* Thinking trace */}
      {(hasThinking || (streaming && !hasText)) && (
        <ThinkingSection
          entries={block.thinking}
          thinkingDurationMs={block.thinkingDurationMs}
          streaming={streaming && !hasText}
        />
      )}

      {/* Tool calls */}
      {hasTools && (
        <div className="flex flex-col gap-1">
          {block.tools.map((entry) => (
            <ToolCallCard key={entry.entryId} entry={entry} />
          ))}
        </div>
      )}

      {/* Assistant text — strip prefix for relay messages, split structured
          delegation blocks out into their own cards. Relay messages don't
          contain `<delegate>` blocks (they're condensed summaries), so the
          split returns a single prose segment for them. */}
      {hasText && (
        <div className="flex flex-col gap-2 text-[13px] leading-relaxed text-text">
          {splitAssistantText(
            isRelay ? stripRelayPrefix(block.assistant!.text) : block.assistant!.text,
          ).map((segment, idx) => {
            if (segment.kind === 'delegation') {
              const matchedLinkage =
                block.assistant && linkagesBySourceEntry
                  ? linkagesBySourceEntry
                      .get(block.assistant.entryId)
                      ?.find((l) => l.blockStart === segment.blockStart)
                  : undefined
              const expandedDefault = block.assistant
                ? block.assistant.entryId === latestSourceEntryId
                : true
              return (
                <DelegationCard
                  key={`delegation-${idx}`}
                  targetName={segment.targetName}
                  task={segment.task}
                  linkage={matchedLinkage}
                  teamId={teamId}
                  defaultExpanded={expandedDefault}
                  latestSourceEntryId={latestSourceEntryId}
                />
              )
            }
            return (
              <ReactMarkdown
                key={`prose-${idx}`}
                remarkPlugins={[remarkGfm]}
                components={MD_COMPONENTS}
              >
                {segment.text}
              </ReactMarkdown>
            )
          })}
        </div>
      )}

      {/* Streaming text */}
      {streaming && !hasText && !hasThinking && <TypingIndicator />}

      {/* Token usage (real from Gateway) or estimated from char count */}
      {!streaming && hasText && (
        <p className="font-mono text-[10px] text-secondary/40">
          {tokenUsage
            ? `${tokenUsage.inputTokens.toLocaleString()} in · ${tokenUsage.outputTokens.toLocaleString()} out${costUsd !== null ? ` · ${formatCost(costUsd)}` : ''}`
            : `~${Math.ceil(charCount / 4).toLocaleString()} tokens`}
        </p>
      )}
    </div>
  )
})

// ─── Live streaming card (uncommitted text) ───────────────────────────────────

export const StreamingCard = memo(function StreamingCard({
  text,
  agentId,
  agentName,
}: {
  text: string
  agentId: string
  agentName: string
}) {
  const hasText = Boolean(text.trim())
  // Split out completed `<delegate>` blocks during streaming. A partial /
  // half-streamed delegation tag won't match the regex (closing tag is
  // required), so it remains in the prose segment until it completes — at
  // which point the next render flips it into a card.
  const segments = useMemo(() => splitAssistantText(text), [text])
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <AgentBooAvatar agentId={agentId} size={22} />
        <span className="font-mono text-[10px] font-semibold uppercase tracking-widest text-secondary/70">
          {agentName}
        </span>
      </div>
      {hasText ? (
        <div className="flex flex-col gap-2 text-[13px] leading-relaxed text-text opacity-80">
          {segments.map((segment, idx) =>
            segment.kind === 'delegation' ? (
              <DelegationCard
                key={`stream-delegation-${idx}`}
                targetName={segment.targetName}
                task={segment.task}
              />
            ) : (
              <div key={`stream-prose-${idx}`} className="whitespace-pre-wrap">
                {segment.text}
              </div>
            ),
          )}
        </div>
      ) : (
        <TypingIndicator />
      )}
    </div>
  )
})

// ─── MessageList ──────────────────────────────────────────────────────────────

export const NEAR_BOTTOM_PX = 80

export const MessageList = memo(function MessageList({
  blocks,
  streamingText,
  agentId,
  agentName,
  isRunning,
}: {
  blocks: RenderBlock[]
  streamingText: string | null
  agentId: string
  agentName: string
  isRunning: boolean
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const pinnedRef = useRef(true)
  const rafRef = useRef<number | null>(null)

  const scrollToBottom = useCallback(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'instant' })
  }, [])

  const scheduleScroll = useCallback(() => {
    if (rafRef.current !== null) return
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null
      scrollToBottom()
    })
  }, [scrollToBottom])

  // Auto-scroll when content changes (if pinned)
  useEffect(() => {
    if (pinnedRef.current) scheduleScroll()
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
    }
  }, [blocks.length, streamingText, scheduleScroll])

  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX
  }, [])

  const isEmpty = blocks.length === 0 && !streamingText
  const showLive = isRunning && streamingText !== null

  return (
    <div
      ref={scrollRef}
      data-testid="chat-message-list"
      className="flex-1 overflow-y-auto px-4 py-4"
      onScroll={handleScroll}
    >
      {isEmpty ? (
        <div className="flex h-full items-center justify-center">
          <p className="font-mono text-[12px] text-secondary/40">No messages yet.</p>
        </div>
      ) : (
        <div className="flex flex-col gap-5 pb-2">
          {blocks.map((block, i) => {
            if (block.kind === 'meta') {
              return <MetaMessageCard key={block.entry.entryId} entry={block.entry} />
            }
            if (block.kind === 'user') {
              return <UserMessageCard key={block.entry.entryId} entry={block.entry} />
            }
            return (
              <AssistantTurnCard
                key={`turn-${i}`}
                block={block}
                agentId={agentId}
                agentName={agentName}
                streaming={isRunning && i === blocks.length - 1 && !showLive}
              />
            )
          })}

          {/* Live uncommitted stream */}
          {showLive && (
            <StreamingCard text={streamingText ?? ''} agentId={agentId} agentName={agentName} />
          )}

          <div ref={bottomRef} aria-hidden />
        </div>
      )}
    </div>
  )
})

// ─── MessageComposer ──────────────────────────────────────────────────────────

// ─── MessageComposer ─────────────────────────────────────────────────────────

export interface MessageComposerHandle {
  /** Insert @AgentName at the start of the draft and focus the textarea. */
  insertMention: (agentName: string) => void
}

/**
 * Mention candidate for the composer dropdown. Can be either a team agent
 * (renders as the agent's Boo avatar) OR a team (renders as the team's
 * emoji + colored disc — same chrome as `TeamChips`). When `icon` is set,
 * `color` should also be set so the disc matches the chip styling.
 */
export type MentionCandidate = {
  id: string
  name: string
  /** Team emoji (e.g. "🚀"). When provided, renders emoji instead of a Boo avatar. */
  icon?: string
  /** Team accent color (hex). Used as a 33%-opacity disc background behind the emoji. */
  color?: string
}

export const MessageComposer = memo(
  forwardRef<
    MessageComposerHandle,
    {
      onSend: (message: string) => void
      disabled: boolean
      placeholder?: string
      /** @mention autocomplete candidates — team agents (group chat) or teams (Boo Zero chat). */
      mentionAgents?: MentionCandidate[]
      /**
       * When `isActive` is true AND `onStop` is provided, the send button
       * is replaced by a red Stop button. Click → `onStop()`. Always
       * clickable regardless of `disabled` (the whole point of Stop is to
       * interrupt a state where Send is unavailable).
       */
      onStop?: () => void
      isActive?: boolean
    }
  >(function MessageComposer(
    { onSend, disabled, placeholder, mentionAgents, onStop, isActive = false },
    ref,
  ) {
    const showStop = isActive && Boolean(onStop)
    const [draft, setDraft] = useState('')
    const textareaRef = useRef<HTMLTextAreaElement>(null)
    const rafRef = useRef<number | null>(null)

    // ── Mention autocomplete state ─────────────────────────────────────────────
    const [mentionOpen, setMentionOpen] = useState(false)
    const [mentionQuery, setMentionQuery] = useState('')
    const [mentionIndex, setMentionIndex] = useState(0)
    const [mentionStartPos, setMentionStartPos] = useState<number | null>(null)

    const filteredMentionAgents = useMemo(() => {
      if (!mentionAgents || !mentionOpen) return []
      if (!mentionQuery) return mentionAgents
      const q = mentionQuery.toLowerCase()
      return mentionAgents.filter((a) => a.name.toLowerCase().startsWith(q))
    }, [mentionAgents, mentionOpen, mentionQuery])

    // ── Imperative handle for AgentChips ────────────────────────────────────────
    useImperativeHandle(
      ref,
      () => ({
        insertMention: (agentName: string) => {
          setDraft((prev) => `@${agentName} ${prev}`)
          requestAnimationFrame(() => {
            const pos = agentName.length + 2 // @name + space
            textareaRef.current?.setSelectionRange(pos, pos)
            textareaRef.current?.focus()
          })
        },
      }),
      [],
    )

    // ── Auto-resize textarea ────────────────────────────────────────────────────
    const resize = useCallback(() => {
      const el = textareaRef.current
      if (!el) return
      el.style.height = 'auto'
      el.style.height = `${Math.min(el.scrollHeight, 180)}px`
    }, [])

    useEffect(() => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null
        resize()
      })
      return () => {
        if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
      }
    }, [draft, resize])

    // ── Send handler ────────────────────────────────────────────────────────────
    const handleSend = useCallback(() => {
      const text = draft.trim()
      if (!text || disabled) return
      setDraft('')
      setMentionOpen(false)
      onSend(text)
    }, [draft, disabled, onSend])

    // ── Mention selection ───────────────────────────────────────────────────────
    const handleMentionSelect = useCallback(
      (agentName: string) => {
        if (mentionStartPos === null) return
        const cursorPos = textareaRef.current?.selectionStart ?? draft.length
        const before = draft.slice(0, mentionStartPos)
        const after = draft.slice(cursorPos)
        const newDraft = `${before}@${agentName} ${after}`
        setDraft(newDraft)
        setMentionOpen(false)
        requestAnimationFrame(() => {
          const pos = before.length + 1 + agentName.length + 1
          textareaRef.current?.setSelectionRange(pos, pos)
          textareaRef.current?.focus()
        })
      },
      [draft, mentionStartPos],
    )

    // ── Change handler with mention detection ───────────────────────────────────
    const handleChange = useCallback(
      (e: ChangeEvent<HTMLTextAreaElement>) => {
        const value = e.target.value
        setDraft(value)

        if (!mentionAgents) return

        const cursorPos = e.target.selectionStart
        const textUpToCursor = value.slice(0, cursorPos)

        // Find the last @ before cursor that doesn't have whitespace after it
        const lastAtIndex = textUpToCursor.lastIndexOf('@')
        if (lastAtIndex >= 0) {
          const textAfterAt = textUpToCursor.slice(lastAtIndex + 1)
          // No whitespace between @ and cursor means we're in a mention query
          // Allow spaces in query since agent names can have spaces (e.g. "Code Reviewer Boo")
          // But close on empty @ followed by another @ or special chars
          if (!/\n/.test(textAfterAt)) {
            setMentionOpen(true)
            setMentionQuery(textAfterAt)
            setMentionStartPos(lastAtIndex)
            setMentionIndex(0)
            return
          }
        }
        setMentionOpen(false)
      },
      [mentionAgents],
    )

    // ── Key handler with mention intercept ───────────────────────────────────────
    const handleKeyDown = useCallback(
      (e: KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.nativeEvent.isComposing) return

        // When mention dropdown is open, intercept navigation keys
        if (mentionOpen && filteredMentionAgents.length > 0) {
          if (e.key === 'ArrowUp') {
            e.preventDefault()
            setMentionIndex((i) => (i <= 0 ? filteredMentionAgents.length - 1 : i - 1))
            return
          }
          if (e.key === 'ArrowDown') {
            e.preventDefault()
            setMentionIndex((i) => (i >= filteredMentionAgents.length - 1 ? 0 : i + 1))
            return
          }
          if (e.key === 'Enter') {
            e.preventDefault()
            handleMentionSelect(filteredMentionAgents[mentionIndex].name)
            return
          }
          if (e.key === 'Tab') {
            e.preventDefault()
            handleMentionSelect(filteredMentionAgents[mentionIndex].name)
            return
          }
        }

        if (e.key === 'Escape' && mentionOpen) {
          e.preventDefault()
          setMentionOpen(false)
          return
        }

        // Default: Enter to send
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault()
          handleSend()
        }
      },
      [handleSend, mentionOpen, filteredMentionAgents, mentionIndex, handleMentionSelect],
    )

    const sendDisabled = disabled || !draft.trim()

    return (
      <div className="border-t border-white/8 px-4 py-3">
        <div className="relative flex items-end gap-2">
          {/* Mention autocomplete dropdown (positioned above textarea) */}
          {mentionOpen && filteredMentionAgents.length > 0 && (
            <MentionDropdownInline
              agents={filteredMentionAgents}
              selectedIndex={mentionIndex}
              onSelect={handleMentionSelect}
              onClose={() => setMentionOpen(false)}
            />
          )}
          <textarea
            ref={textareaRef}
            rows={1}
            value={draft}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            placeholder={placeholder ?? 'Message…'}
            disabled={disabled}
            data-testid="chat-composer-input"
            className="flex-1 resize-none overflow-hidden rounded-lg border border-white/10 bg-surface px-3 py-2 text-[13px] text-text outline-none transition placeholder:text-secondary/40 focus:border-white/20 focus:ring-1 focus:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-40"
            style={{ fontFamily: 'var(--font-body)', minHeight: '38px' }}
          />
          {showStop ? (
            // ── Stop button — "pull the plug" on the active run(s) ──────────
            // Same 38×38 footprint as Send so the composer doesn't reflow on
            // morph. Filled-square icon (`Square`) reads as Stop universally.
            // Color: solid project accent red. NOT gated by `disabled` — the
            // user pressed Stop precisely because the chat is in a state
            // where Send is unavailable.
            <button
              type="button"
              onClick={onStop}
              data-testid="chat-stop-button"
              aria-label="Stop"
              title="Stop"
              className="flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-lg bg-accent text-white transition hover:brightness-110"
            >
              <Square className="h-3.5 w-3.5" strokeWidth={2} fill="currentColor" />
            </button>
          ) : (
            <button
              type="button"
              onClick={handleSend}
              disabled={sendDisabled}
              data-testid="chat-send-button"
              aria-label="Send message"
              className="flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-lg bg-accent text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:bg-muted disabled:text-secondary"
            >
              <SendHorizontal className="h-4 w-4" strokeWidth={2} />
            </button>
          )}
        </div>
        <p className="mt-1.5 text-right font-mono text-[10px] text-secondary/30">
          Enter to send · Shift+Enter for newline · /reset for new session
        </p>
      </div>
    )
  }),
)

// ─── Inline MentionDropdown (avoids circular import) ─────────────────────────
// Lightweight inline version used by MessageComposer.
// The full MentionDropdown.tsx is reusable elsewhere if needed.

const MentionDropdownInline = memo(function MentionDropdownInline({
  agents,
  selectedIndex,
  onSelect,
  onClose,
}: {
  agents: MentionCandidate[]
  selectedIndex: number
  onSelect: (agentName: string) => void
  onClose: () => void
}) {
  const selectedRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  // Click-outside: close on mousedown outside the dropdown
  const listRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (listRef.current && !listRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [onClose])

  return (
    <div
      ref={listRef}
      data-testid="mention-dropdown"
      style={{
        position: 'absolute',
        bottom: '100%',
        left: 0,
        marginBottom: 4,
        zIndex: 50,
        background: '#111827',
        border: '1px solid rgba(255,255,255,0.1)',
        borderRadius: 8,
        padding: '4px 0',
        minWidth: 180,
        maxHeight: 200,
        overflowY: 'auto',
        boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
      }}
    >
      {agents.map((agent, i) => (
        <button
          key={agent.id}
          ref={i === selectedIndex ? selectedRef : undefined}
          type="button"
          onMouseDown={(e) => {
            e.preventDefault()
            onSelect(agent.name)
          }}
          className="flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors"
          style={{
            background: i === selectedIndex ? 'rgba(255,255,255,0.08)' : 'transparent',
            fontSize: 12,
            color: '#E8E8E8',
          }}
          onMouseEnter={(e) => {
            if (i !== selectedIndex)
              (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.04)'
          }}
          onMouseLeave={(e) => {
            if (i !== selectedIndex)
              (e.currentTarget as HTMLButtonElement).style.background = 'transparent'
          }}
        >
          {agent.icon ? (
            // Team candidate — render emoji on a colored disc matching the
            // chip styling in `TeamChips.tsx`. Keeps the dropdown visually
            // consistent with the chip the user clicked to discover the
            // feature.
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 20,
                height: 20,
                borderRadius: '50%',
                background: `${agent.color ?? '#E94560'}33`,
                fontSize: 12,
                flexShrink: 0,
              }}
              aria-hidden
            >
              {agent.icon}
            </span>
          ) : (
            <AgentBooAvatar agentId={agent.id} size={20} />
          )}
          <span className="truncate">{agent.name}</span>
        </button>
      ))}
    </div>
  )
})
