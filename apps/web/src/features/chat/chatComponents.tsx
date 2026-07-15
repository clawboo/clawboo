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
import { ArrowDown, ArrowUp, ChevronRight, Clock, SendHorizontal, Square, Wrench } from 'lucide-react'
import { BooAvatar, resolveBooTint } from '@clawboo/ui'
import { Button } from '@/features/shared/Button'
import type { TranscriptEntry } from '@clawboo/protocol'
import { AgentBooAvatar } from '@/components/AgentBooAvatar'
import { useFleetStore } from '@/stores/fleet'
import { useChatStore } from '@/stores/chat'
import { useBooZeroStore } from '@/stores/booZero'
import { useTeamStore } from '@/stores/team'
import { useTheme } from '@/features/theme/useTheme'
import { DEFAULT_COLLECTION_ID } from '@/lib/teamPalettes'
import { pickBooColor } from '@/lib/resolveTeamBooColor'
import { calculateCostUsd, formatCost } from '@/features/cost/costUtils'
import { shouldDropAssistantTurn } from '@/lib/teamProtocol'
import { parseToolEntry } from './parseToolEntry'
import { splitAssistantText } from './splitAssistantText'
import { stripPlanBlocks, stripDelegationBlocks } from '@/features/group-chat/delegationTags'

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

// `parseToolEntry` lives in its own module to avoid a circular import through
// chatComponents. Re-exported here so existing consumers keep working.
export { parseToolEntry } from './parseToolEntry'

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
    // Drop broken-shape assistant turns: OpenClaw protocol control tokens
    // (ANNOUNCE_SKIP / NO_REPLY / NO), Clawboo control tokens (__resumed__,
    // __skipped__), and short refusal-shape leaks. See `shouldDropAssistantTurn`
    // in `lib/teamProtocol.ts` for the canonical filter (extracted as a
    // shared utility so the delegation source scanner uses the same gate).
    // Meta and user entries pass through — the filter only catches assistant
    // turns whose entire body is a broken-shape signal.
    if (entry.role === 'assistant' && shouldDropAssistantTurn(entry.text)) continue

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
//
// Tailwind preflight zeroes out headings / list bullets / table borders, so
// every element an agent is likely to emit needs an explicit component here or
// it renders as flat prose. Sizes are em-based so the same map works at any
// container font size (13px chat turns, 12.5px board task cards).

export const MD_COMPONENTS: React.ComponentProps<typeof ReactMarkdown>['components'] = {
  h1({ children }) {
    return (
      <h1 className="mb-1 mt-3 text-[1.25em] font-bold leading-snug tracking-[-0.01em] text-foreground first:mt-0">
        {children}
      </h1>
    )
  },
  h2({ children }) {
    return (
      <h2 className="mb-1 mt-3 text-[1.15em] font-bold leading-snug tracking-[-0.01em] text-foreground first:mt-0">
        {children}
      </h2>
    )
  },
  h3({ children }) {
    return (
      <h3 className="mb-1 mt-2.5 text-[1.05em] font-semibold leading-snug text-foreground first:mt-0">
        {children}
      </h3>
    )
  },
  h4({ children }) {
    return (
      <h4 className="mb-0.5 mt-2 text-[1em] font-semibold leading-snug text-foreground first:mt-0">
        {children}
      </h4>
    )
  },
  ul({ children }) {
    return <ul className="my-1.5 list-disc space-y-1 pl-5 marker:text-foreground/35">{children}</ul>
  },
  ol({ children }) {
    return (
      <ol className="my-1.5 list-decimal space-y-1 pl-5 marker:text-foreground/45">{children}</ol>
    )
  },
  li({ children }) {
    return <li className="leading-relaxed">{children}</li>
  },
  blockquote({ children }) {
    return (
      <blockquote className="my-2 border-l-2 border-foreground/20 pl-3 text-foreground/70">
        {children}
      </blockquote>
    )
  },
  hr() {
    return <hr className="my-3 border-border" />
  },
  table({ children }) {
    return (
      <div className="my-2 overflow-x-auto">
        <table className="w-full border-collapse text-[0.95em]">{children}</table>
      </div>
    )
  },
  th({ children }) {
    return (
      <th className="border-b border-border px-2 py-1 text-left font-semibold text-foreground">
        {children}
      </th>
    )
  },
  td({ children }) {
    // Full --border (already only 8% alpha); a /50 modifier would compound to
    // ~4% and the body-row separators read as an unruled/broken table.
    return <td className="border-b border-border px-2 py-1 align-top">{children}</td>
  },
  code({ className, children, ...rest }) {
    const isBlock = /language-/.test(className ?? '')
    if (isBlock) {
      return (
        <pre
          className="my-2 overflow-x-auto rounded-xl border border-border p-3 text-[12px]"
          style={{ background: 'var(--code-block-bg)' }}
        >
          <code className={`font-mono ${className ?? ''}`} {...rest}>
            {children}
          </code>
        </pre>
      )
    }
    return (
      <code
        className="rounded-md bg-foreground/[0.08] px-1.5 py-0.5 font-mono text-[0.875em] text-mint"
        {...rest}
      >
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
      className="flex w-fit items-center gap-2 rounded-full border border-border bg-surface px-3 py-1.5 text-foreground/60"
    >
      <span className="font-mono text-[11px] uppercase tracking-[0.14em]">Thinking</span>
      <span className="flex gap-1">
        {[0, 1, 2].map((i) => (
          <motion.span
            key={i}
            className="inline-block h-1.5 w-1.5 rounded-full bg-foreground/50"
            animate={{ opacity: [0.3, 1, 0.3], scale: [0.85, 1, 0.85] }}
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

  const label = parsed.name.toUpperCase()
  const DirectionIcon = parsed.kind === 'call' ? ArrowUp : ArrowDown
  const hasBody = Boolean(parsed.body)

  return (
    <div
      className="rounded-xl border border-border text-[11px]"
      style={{ background: 'var(--code-block-bg)' }}
    >
      <button
        type="button"
        className={`flex w-full items-center gap-2 px-3 py-2 text-left ${hasBody ? 'cursor-pointer' : ''}`}
        onClick={() => hasBody && setOpen((v) => !v)}
        disabled={!hasBody}
      >
        <Wrench className="h-3 w-3 shrink-0 text-amber" strokeWidth={2} />
        <span className="flex items-center gap-1 font-mono font-semibold tracking-wider text-amber">
          <DirectionIcon className="h-3 w-3 shrink-0" strokeWidth={2.5} />
          {label}
        </span>
        {hasBody && (
          <ChevronRight
            className={`ml-auto h-3 w-3 shrink-0 text-foreground/40 transition-transform ${open ? 'rotate-90' : ''}`}
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
            <pre className="overflow-x-auto border-t border-border px-3 py-2 font-mono text-[11px] text-foreground/60">
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
    <div className="rounded-xl border border-border bg-surface text-[11px] text-foreground/60">
      <button
        type="button"
        className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left opacity-70 transition hover:opacity-100"
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
                className="inline-block h-1 w-1 rounded-full bg-foreground/50"
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
            <div className="px-4 pb-3 pt-1 text-[12px] leading-relaxed text-foreground/70">
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
      {/* A fixed card radius, NOT rounded-full: a short meta reads as a pill, but a
          long one (e.g. a multi-line [Task Update] reflection) wraps tall — rounded-full
          would round the corners into a giant oval. max-w-prose keeps long metas from
          sprawling full-width; whitespace-pre-wrap preserves any newlines. */}
      <p className="max-w-prose whitespace-pre-wrap rounded-2xl border border-border bg-surface px-4 py-2 font-mono text-[11px] leading-relaxed text-foreground/55">
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
      <div
        className="max-w-[70ch] overflow-hidden rounded-2xl rounded-br-md border border-border"
        style={{
          background: 'rgb(var(--primary-rgb) / 0.07)',
          boxShadow: 'var(--shadow-raised)',
        }}
      >
        <div className="flex items-center justify-between gap-4 border-b border-border px-3.5 py-1.5">
          <span className="font-mono text-[10px] font-semibold uppercase tracking-widest text-foreground/70">
            {targetAgentName ? `You → ${targetAgentName}` : 'You'}
          </span>
          {entry.timestampMs && (
            <time className="font-data text-[10px] text-foreground/45">
              {formatTimestamp(entry.timestampMs)}
            </time>
          )}
        </div>
        <div className="px-3.5 py-2.5 text-[13px] leading-relaxed text-foreground">
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
// Renders a `<delegate to="@Name">task</delegate>` directive as a styled
// segment card (target avatar + "Delegated to @Name" + the task body). Used by
// `StreamingCard` to surface in-flight delegations as the leader streams; once
// the turn commits, the durable BoardTaskCard is the record of record.

export const DelegationCard = memo(function DelegationCard({
  targetName,
  task,
  teamId,
  animationIndex = 0,
}: {
  targetName: string
  task: string
  teamId?: string
  /**
   * Per-card index inside a batch. Used to stagger entry animations
   * (delay = idx * 40 ms). Defaults to 0 for standalone inline cards.
   */
  animationIndex?: number
}) {
  const targetAgentId = useFleetStore(
    (s) => s.agents.find((a) => a.name === targetName)?.id ?? null,
  )
  const booZeroAgentId = useBooZeroStore((s) => s.booZeroAgentId)
  const isBooZero = targetAgentId !== null && targetAgentId === booZeroAgentId
  const avatarSeed = targetAgentId ?? targetName

  // Target tint — the same color the avatar paints with. Prefer the target's
  // generated team-palette color (so the card matches the recolored avatar),
  // falling back to the hashed boo-avatar tint, then the emerald CSS var when
  // the target isn't in the fleet store (a mistyped @mention / not-yet-synced
  // agent). Because that last fallback is a `var(--mint)`, alpha MUST be applied
  // with color-mix (accepts a var operand) — never hex-suffix concatenation,
  // which would produce invalid CSS (`var(--mint)33`) and drop the declaration.
  // Same idiom as BoardTaskCard + TeamHaloLayer.
  const { resolvedTheme } = useTheme()
  const collectionId = useTeamStore((s) =>
    teamId
      ? (s.teams.find((t) => t.id === teamId)?.colorCollectionId ?? DEFAULT_COLLECTION_ID)
      : null,
  )
  const teamMembersSig = useFleetStore((s) =>
    teamId
      ? s.agents
          .filter((a) => a.teamId === teamId && a.id !== booZeroAgentId)
          .map((a) => a.id)
          .sort()
          .join('|')
      : '',
  )
  const teamTint =
    targetAgentId && !isBooZero && teamId && collectionId
      ? pickBooColor(
          collectionId,
          teamMembersSig ? teamMembersSig.split('|') : [],
          targetAgentId,
          resolvedTheme,
        )
      : undefined
  const tint =
    teamTint ?? (targetAgentId ? resolveBooTint(targetAgentId, isBooZero) : 'var(--mint)')

  return (
    <motion.div
      className="flex flex-col gap-2 rounded-xl px-4 py-3"
      style={{
        border: `1px solid color-mix(in srgb, ${tint} 20%, transparent)`,
        background: `linear-gradient(180deg, color-mix(in srgb, ${tint} 6%, transparent) 0%, color-mix(in srgb, ${tint} 2.4%, transparent) 55%, color-mix(in srgb, ${tint} 1.2%, transparent) 100%)`,
        boxShadow: `inset 0 1px 0 color-mix(in srgb, ${tint} 12.5%, transparent)`,
      }}
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.28, delay: animationIndex * 0.04, ease: [0.22, 0.61, 0.36, 1] }}
      data-testid="delegation-card"
    >
      <div className="flex items-center gap-2.5">
        <BooAvatar seed={avatarSeed} size={28} tint={teamTint} isBooZero={isBooZero} />
        <div className="flex min-w-0 flex-col gap-0.5">
          <span
            className="font-mono text-[10px] font-semibold uppercase tracking-widest"
            style={{ color: tint }}
          >
            Delegated to
          </span>
          <span className="truncate font-mono text-[11.5px] font-semibold text-foreground">
            @{targetName}
          </span>
        </div>
      </div>
      {task && (
        <div
          className="border-t border-dashed pt-2 text-[12px] leading-relaxed whitespace-pre-wrap text-foreground/75"
          style={{ borderColor: `color-mix(in srgb, ${tint} 12.5%, transparent)` }}
        >
          {task}
        </div>
      )}
    </motion.div>
  )
})

// ─── AssistantTurnCard ────────────────────────────────────────────────────────

export const AssistantTurnCard = memo(function AssistantTurnCard({
  block,
  agentId,
  agentName,
  streaming,
  teamId: _teamId,
  isFollowup = false,
}: {
  block: AssistantBlock
  agentId: string
  agentName: string
  streaming?: boolean
  /** Group-chat context id. Reserved for future per-team rendering hooks. */
  teamId?: string
  /**
   * When true, hide the avatar/name/timestamp header. Set by the parent
   * renderer when this block is a continuation of the same author's
   * previous block within a short window — drops the repeated chrome so
   * a burst of messages from one agent reads as a single section.
   */
  isFollowup?: boolean
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
      className={`flex flex-col gap-2${isRelay ? ' border-l-2 border-mint/40 pl-3 opacity-80' : ''}`}
    >
      {/* Header — suppressed when `isFollowup` so consecutive same-author
          messages read as one continuous section. */}
      {!isFollowup && (
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <AgentBooAvatar agentId={agentId} size={28} />
            <span
              className="font-mono font-semibold uppercase tracking-widest text-foreground/55"
              style={{ fontSize: 11.5 }}
            >
              {agentName}
            </span>
            {isRelay && (
              <span className="rounded-full bg-mint/15 px-2 py-0.5 font-mono text-[9px] font-medium text-mint">
                Team Update
              </span>
            )}
          </div>
          {block.timestampMs && (
            <time className="font-data text-[10px] text-foreground/45">
              {formatTimestamp(block.timestampMs)}
            </time>
          )}
        </div>
      )}

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

      {/* Assistant text — strip relay prefix, then strip the structured
          `<delegate>` / `<plan>` directives to plain prose. Delegations surface
          as durable BoardTaskCards (group chat) — never inline here — so the
          leader's committed turn renders as clean prose. `max-w-prose` (~65ch)
          caps line length to the optimal reading measure. */}
      {hasText && (
        <div className="flex max-w-prose flex-col gap-2 text-[13px] leading-relaxed text-foreground">
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>
            {stripPlanBlocks(
              stripDelegationBlocks(
                isRelay ? stripRelayPrefix(block.assistant!.text) : block.assistant!.text,
              ),
            )}
          </ReactMarkdown>
        </div>
      )}

      {/* Streaming text */}
      {streaming && !hasText && !hasThinking && <TypingIndicator />}

      {/* Token usage (real from Gateway) or estimated from char count */}
      {!streaming && hasText && (
        <p className="font-data text-[10px] text-foreground/40">
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
      <div className="flex items-center gap-2.5">
        <AgentBooAvatar agentId={agentId} size={28} />
        <span
          className="font-mono font-semibold uppercase tracking-widest text-foreground/55"
          style={{ fontSize: 11.5 }}
        >
          {agentName}
        </span>
      </div>
      {hasText ? (
        <div className="flex max-w-prose flex-col gap-2 text-[13px] leading-relaxed text-foreground opacity-80">
          {segments.map((segment, idx) =>
            segment.kind === 'delegation' ? (
              <DelegationCard
                key={`stream-delegation-${idx}`}
                targetName={segment.targetName}
                task={segment.task}
              />
            ) : (
              // Render streaming prose with the same
              // ReactMarkdown pipeline used by `AssistantTurnCard` so bold /
              // lists / code blocks / links format progressively as text
              // streams in — instead of staying as raw text until commit.
              // ReactMarkdown's parser is tolerant of partial markdown
              // (unfinished `**bold`, partial `[link](`, unclosed fences):
              // it renders what's parseable and leaves the rest as text.
              // `splitAssistantText` (above) already excludes partial
              // `<delegate>` tags from the prose, so the markdown parser
              // never sees them.
              <div key={`stream-prose-${idx}`}>
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>
                  {segment.text}
                </ReactMarkdown>
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

// ─── Author-grouping + spacing helpers ───────────────────────────────────────
//
// Slack / Discord / iMessage pattern: when consecutive assistant turns come
// from the SAME agent inside a short window, drop the repeated avatar+name
// chrome on the follow-ups so the burst reads as one continuous section.
//
// `FOLLOWUP_WINDOW_MS` — anything beyond this is treated as a new "section"
// and gets a full header. 5 minutes is the sweet spot: long pauses (lunch,
// next morning) read as a fresh thread; back-to-back streaming bursts read
// as one author speaking continuously.

const FOLLOWUP_WINDOW_MS = 5 * 60 * 1000

/**
 * True when `current` is a continuation of `prev`: both are assistant-turn
 * blocks owned by the same agent, with timestamps within 5 min. User and
 * meta blocks always break the streak (returning false).
 */
export function isFollowupBlock(
  prev: RenderBlock | null,
  current: RenderBlock,
  prevOwnerAgentId: string | null,
  currentOwnerAgentId: string | null,
): boolean {
  if (!prev || prev.kind !== 'assistant-turn' || current.kind !== 'assistant-turn') return false
  if (!currentOwnerAgentId || prevOwnerAgentId !== currentOwnerAgentId) return false
  const prevTs = prev.timestampMs
  const currTs = current.timestampMs
  if (prevTs === null || currTs === null) return false
  return currTs - prevTs <= FOLLOWUP_WINDOW_MS
}

/**
 * Tailwind margin class for a block based on whether it's the first block,
 * a same-author continuation (tight), or a new author group (generous).
 * Replaces uniform `gap-5` on the parent so spacing reads as grouping.
 */
export function blockMarginClass(index: number, isFollowup: boolean): string {
  if (index === 0) return ''
  return isFollowup ? 'mt-2' : 'mt-7'
}

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
        <div className="flex h-full flex-col items-center justify-center gap-4 px-6 text-center">
          <div className="opacity-80">
            <AgentBooAvatar agentId={agentId} size={56} />
          </div>
          <div className="flex flex-col gap-1.5">
            <p
              className="text-[15px] font-semibold text-foreground/80"
              style={{ fontFamily: 'var(--font-display)' }}
            >
              Say hi to {agentName}
            </p>
            <p className="max-w-[280px] text-[12px] leading-relaxed text-foreground/45">
              Send a message below to start the conversation.
            </p>
          </div>
        </div>
      ) : (
        <div className="flex flex-col pb-2">
          {blocks.map((block, i) => {
            const prev = i > 0 ? (blocks[i - 1] ?? null) : null
            // 1:1 chat: every assistant turn is from the same agent (the
            // `agentId` prop), so the owner check collapses to "is the
            // previous block also an assistant-turn?" — handled by
            // `isFollowupBlock` against equal owner ids.
            const isFollowup = isFollowupBlock(prev, block, agentId, agentId)
            const margin = blockMarginClass(i, isFollowup)

            if (block.kind === 'meta') {
              return (
                <div key={block.entry.entryId} className={margin}>
                  <MetaMessageCard entry={block.entry} />
                </div>
              )
            }
            if (block.kind === 'user') {
              return (
                <div key={block.entry.entryId} className={margin}>
                  <UserMessageCard entry={block.entry} />
                </div>
              )
            }
            return (
              <div key={`turn-${i}`} className={margin}>
                <AssistantTurnCard
                  block={block}
                  agentId={agentId}
                  agentName={agentName}
                  streaming={isRunning && i === blocks.length - 1 && !showLive}
                  isFollowup={isFollowup}
                />
              </div>
            )
          })}

          {/* Live uncommitted stream — applies the same follow-up rule
              against the last committed block so a streaming continuation
              of the agent's own burst stays tight. */}
          {showLive &&
            (() => {
              const last = blocks.length > 0 ? (blocks[blocks.length - 1] ?? null) : null
              const streamIsFollowup =
                last !== null &&
                last.kind === 'assistant-turn' &&
                last.timestampMs !== null &&
                Date.now() - last.timestampMs <= FOLLOWUP_WINDOW_MS
              const margin = blocks.length === 0 ? '' : streamIsFollowup ? 'mt-2' : 'mt-7'
              return (
                <div className={margin}>
                  <StreamingCard
                    text={streamingText ?? ''}
                    agentId={agentId}
                    agentName={agentName}
                  />
                </div>
              )
            })()}

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
  /** Replace the draft with `text` and focus (cursor at end). Used by the guided
   *  first-task hint to pre-fill a suggested prompt for the user to send/edit. */
  prefill: (text: string) => void
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
        prefill: (text: string) => {
          setDraft(text)
          requestAnimationFrame(() => {
            const el = textareaRef.current
            if (!el) return
            el.setSelectionRange(text.length, text.length)
            el.focus()
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
      <div className="border-t border-border px-5 py-4">
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
            className="flex-1 resize-none overflow-hidden rounded-xl border border-border bg-surface px-4 py-2.5 text-[14px] text-foreground outline-none transition placeholder:text-foreground/30 focus:border-primary focus:ring-4 focus:ring-primary/15 disabled:cursor-not-allowed disabled:opacity-40"
            style={{ fontFamily: 'var(--font-body)', minHeight: '42px' }}
          />
          {showStop ? (
            // ── Stop button — "pull the plug" on the active run(s) ──────────
            // Same 42×42 footprint as Send so the composer doesn't reflow on
            // morph. Filled-square icon (`Square`) reads as Stop universally.
            // Color: solid destructive red. NOT gated by `disabled` — the
            // user pressed Stop precisely because the chat is in a state
            // where Send is unavailable.
            <Button
              variant="danger"
              onClick={onStop}
              data-testid="chat-stop-button"
              aria-label="Stop"
              title="Stop"
              className="h-[42px] w-[42px] shrink-0 rounded-xl px-0"
            >
              <Square className="h-3.5 w-3.5" strokeWidth={2} fill="currentColor" />
            </Button>
          ) : (
            <Button
              variant="primary"
              onClick={handleSend}
              disabled={sendDisabled}
              data-testid="chat-send-button"
              aria-label="Send message"
              className="h-[42px] w-[42px] rounded-xl px-0"
            >
              <SendHorizontal className="h-4 w-4" strokeWidth={2} />
            </Button>
          )}
        </div>
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
      className="absolute bottom-full left-0 z-50 mb-1.5 max-h-[200px] min-w-[190px] overflow-y-auto rounded-xl border border-border bg-popover py-1.5"
      style={{ boxShadow: 'var(--shadow-floating)' }}
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
          className={[
            'flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-[12.5px] text-popover-foreground transition-colors',
            i === selectedIndex ? 'bg-foreground/[0.08]' : 'hover:bg-foreground/[0.04]',
          ].join(' ')}
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
                background: agent.color
                  ? `${agent.color}33`
                  : 'color-mix(in srgb, var(--primary) 20%, transparent)',
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
