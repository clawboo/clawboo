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
import {
  ChevronRight,
  Clock,
  Network,
  SendHorizontal,
  Square,
  Workflow,
  Wrench,
} from 'lucide-react'
import { BooAvatar, resolveBooTint } from '@clawboo/ui'
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
import {
  buildDelegationLinkages,
  type DelegationLinkage,
} from '@/features/group-chat/buildDelegationLinkages'
import { shouldDropAssistantTurn } from '@/lib/teamProtocol'
import { parseToolEntry } from './parseToolEntry'
import { splitAssistantText } from './splitAssistantText'
import { stripPlanBlocks } from '@/features/group-chat/planDetector'
import { pickLatestActivity } from '@/features/graph/nodes/pickLatestActivity'

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

// `parseToolEntry` lives in its own module so `buildDelegationLinkages` can
// import it without a circular reference through chatComponents (which itself
// imports `buildDelegationLinkages`). Re-exported here so existing consumers
// keep working.
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

export const MD_COMPONENTS: React.ComponentProps<typeof ReactMarkdown>['components'] = {
  code({ className, children, ...rest }) {
    const isBlock = /language-/.test(className ?? '')
    if (isBlock) {
      return (
        <pre className="my-2 overflow-x-auto rounded-md bg-foreground/[0.05] p-3 text-[12px] dark:bg-black/30">
          <code className={`font-mono ${className ?? ''}`} {...rest}>
            {children}
          </code>
        </pre>
      )
    }
    return (
      <code
        className="rounded bg-foreground/[0.08] px-1 py-0.5 font-mono text-[0.875em] text-mint"
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
      className="flex items-center gap-2 rounded-md bg-surface px-3 py-2 text-secondary"
    >
      <span className="font-mono text-[11px] tracking-wide">Thinking</span>
      <span className="flex gap-1">
        {[0, 1, 2].map((i) => (
          <motion.span
            key={i}
            className="inline-block h-1.5 w-1.5 rounded-full bg-secondary"
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

  const label = `${parsed.kind === 'call' ? '⬆' : '⬇'} ${parsed.name.toUpperCase()}`
  const hasBody = Boolean(parsed.body)

  return (
    <div
      className="rounded-md border border-border text-[11px]"
      style={{ background: 'var(--code-block-bg)' }}
    >
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
            <pre className="overflow-x-auto border-t border-border px-3 py-2 font-mono text-[11px] text-secondary">
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
        <div className="flex items-center justify-between gap-4 border-b border-border px-3 py-1.5">
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

// ─── firstSentencePreview ─────────────────────────────────────────────────────
//
// Round 12B: derive a single-line preview from an agent's reply body. Used
// by `DelegationCard` when the card is collapsed so the user gets a gist
// of "what the agent said" without expanding. Pure prose extraction — no
// markdown parsing, no API call. The first sentence (or first newline /
// truncated tail) of the reply, trimmed of leading markdown punctuation.
//
// Examples:
//   "**Fall** — the crisp air, rich colors..." →  "Fall — the crisp air, rich colors..."
//   "Hi! Quick answer: react.\n\nLonger..."     →  "Hi!"
//   one long unbroken sentence > 90 chars       →  truncated with "…"

function firstSentencePreview(text: string, maxChars = 90): string {
  // Strip leading markdown noise (bold/italic/heading/quote/code markers)
  // so the preview starts with the first real word.
  const cleaned = text
    .trim()
    .replace(/^[\s>#`*_~-]+/, '')
    .trim()
  if (!cleaned) return ''
  // First sentence end or first newline — whichever comes first.
  const sentenceMatch = cleaned.match(/^[\s\S]+?[.!?](\s|$)/)
  const firstLine = cleaned.split('\n')[0] ?? cleaned
  let raw = (sentenceMatch?.[0] ?? firstLine).trim()
  // Strip trailing punctuation-only artifacts then truncate.
  if (raw.length > maxChars) raw = `${raw.slice(0, maxChars - 1).trimEnd()}…`
  return raw
}

// ─── LiveActivityFeed ─────────────────────────────────────────────────────────
//
// What the target agent is doing RIGHT NOW — replaces the previous generic
// "Thinking..." spinner inside a pending DelegationCard. Surfaces tool
// calls / streamed prose the way modern chat UIs do: subscribe to the
// target's session, ask `pickLatestActivity` what the most-recent activity
// is, and render it with kind-specific affordances (mint pulse for
// streaming, 🔧 for tool calls, prose markdown for final responses).
//
// When `isRunning` is true but no signal has landed yet, falls back to the
// `TypingIndicator` (animated dots). When the agent is idle and we have
// nothing to show, renders a muted "Awaiting response" line — better than
// a lingering "Thinking..." that the user reads as "the system is stuck".

const LiveActivityFeed = memo(function LiveActivityFeed({
  targetAgentId,
  targetSessionKey,
  tint,
}: {
  targetAgentId: string | null
  targetSessionKey?: string
  tint: string
}) {
  // Subscribe by primitive lookups so unrelated agents' updates don't
  // re-render this card.
  const agentStatus = useFleetStore((s) =>
    targetAgentId ? (s.agents.find((a) => a.id === targetAgentId)?.status ?? null) : null,
  )
  const isRunning = agentStatus === 'running'

  const streamingText = useChatStore((s) =>
    targetSessionKey ? (s.streamingText.get(targetSessionKey) ?? null) : null,
  )
  // Pull a small tail of the target's transcript — last 6 entries is enough
  // to find the most recent assistant turn / tool call. Using a wider
  // window would only matter for very chatty agents, which isn't typical.
  const recentEntries = useChatStore((s) =>
    targetSessionKey ? (s.transcripts.get(targetSessionKey) ?? null) : null,
  )
  const tail = useMemo(
    () => (recentEntries && recentEntries.length > 0 ? recentEntries.slice(-6) : null),
    [recentEntries],
  )
  const picked = pickLatestActivity(streamingText, tail)

  if (!picked) {
    if (isRunning) return <TypingIndicator />
    return (
      <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-wider text-text/35">
        <motion.span
          aria-hidden
          className="h-1.5 w-1.5 rounded-full"
          style={{ background: tint }}
          initial={{ opacity: 0.25 }}
          animate={{ opacity: [0.25, 0.55, 0.25] }}
          transition={{ duration: 2.4, repeat: Infinity, ease: 'easeInOut' }}
        />
        <span>Awaiting response</span>
      </div>
    )
  }

  if (picked.kind === 'streaming') {
    // Streaming text with a blinking cursor at the tail — the typewriter
    // feel of streaming chat lets the user SEE the agent thinking
    // word-by-word in real time.
    return (
      <div className="flex flex-col gap-1.5">
        <div className="text-[13px] leading-relaxed text-text/95">
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>
            {picked.text}
          </ReactMarkdown>
          {/* Blinking cursor — sits inline at the tail of the streamed
              text so the eye anchors on the live edge. */}
          <motion.span
            aria-hidden
            className="ml-0.5 inline-block h-[1em] w-[2px] translate-y-[2px] rounded-sm align-middle"
            style={{ background: tint }}
            animate={{ opacity: [1, 0, 1] }}
            transition={{ duration: 0.9, repeat: Infinity, ease: 'easeInOut' }}
          />
        </div>
      </div>
    )
  }

  if (picked.kind === 'tool') {
    // Format `[[tool: <label>]]` → extract label, render as a styled chip
    // (a tool-call pill in the chat). The label may contain a primary name
    // + dimmed argument (e.g. `read package.json`); we split on the first
    // space to render that distinction.
    const label = picked.text.match(/\[\[tool:\s*(.+?)\]\]/)?.[1]?.trim() ?? 'tool'
    const spaceIdx = label.indexOf(' ')
    const toolName = spaceIdx >= 0 ? label.slice(0, spaceIdx) : label
    const toolArg = spaceIdx >= 0 ? label.slice(spaceIdx + 1) : null
    return (
      <motion.div
        className="inline-flex items-center gap-2 self-start rounded-md border px-2 py-1"
        style={{
          borderColor: `${tint}33`,
          background: `${tint}10`,
        }}
        initial={{ opacity: 0, scale: 0.95 }}
        animate={isRunning ? { opacity: 1, scale: [1, 1.02, 1] } : { opacity: 1, scale: 1 }}
        transition={
          isRunning
            ? { scale: { duration: 1.4, repeat: Infinity, ease: 'easeInOut' } }
            : { duration: 0.2 }
        }
      >
        <Wrench size={11} style={{ color: tint }} />
        <span
          className="font-mono text-[10px] font-semibold uppercase tracking-wider"
          style={{ color: tint }}
        >
          {isRunning ? 'Calling' : 'Last called'}
        </span>
        <span className="font-mono text-[11px] text-text">{toolName}</span>
        {toolArg && <span className="truncate font-mono text-[11px] text-text/60">{toolArg}</span>}
        {isRunning && (
          <span
            aria-hidden
            className="h-1.5 w-1.5 animate-pulse rounded-full"
            style={{ background: tint }}
          />
        )}
      </motion.div>
    )
  }

  // picked.kind === 'assistant' — committed response, render in full.
  return (
    <div className="text-[13px] leading-relaxed text-text/95">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>
        {picked.text}
      </ReactMarkdown>
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
  animationIndex = 0,
}: {
  targetName: string
  task: string
  linkage?: DelegationLinkage
  teamId?: string
  defaultExpanded?: boolean
  depth?: number
  latestSourceEntryId?: string | null
  /**
   * Round 11: per-card index inside a WorkstreamCard / PlanCard grid. Used
   * to stagger entry animations (delay = idx * 40 ms) so a batch of cards
   * fades in as a wave, not all at once. Defaults to 0 for standalone
   * inline cards (no stagger needed).
   */
  animationIndex?: number
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

  // Target tint — the same hex the avatar paints with. Prefer the target's
  // generated team-palette color (so the card matches the recolored avatar),
  // falling back to the hashed boo-avatar tint, then emerald.
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
  const tint = teamTint ?? (targetAgentId ? resolveBooTint(targetAgentId, isBooZero) : '#10b981')

  // Round 11: target agent live status (running / idle) drives the
  // pulse-glow on the card border and the small status dot in the header.
  const targetAgentStatus = useFleetStore((s) =>
    targetAgentId ? (s.agents.find((a) => a.id === targetAgentId)?.status ?? null) : null,
  )
  const targetIsRunning = targetAgentStatus === 'running'

  // Streaming text for the target — only the FIRST pending delegation per
  // target session owns the live stream. Subsequent pending delegations
  // wait their turn (queued by the Gateway anyway).
  const ownsStreaming = Boolean(linkage?.isPending && linkage?.targetSessionKey && teamId)
  const streamingText = useChatStore((s) =>
    ownsStreaming && linkage?.targetSessionKey
      ? (s.streamingText.get(linkage.targetSessionKey) ?? null)
      : null,
  )

  const hasLinkedEntries = Boolean(linkage && linkage.linkedEntries.length > 0)
  const hasStreaming = streamingText !== null && streamingText.length > 0
  // The card has SOMETHING to show in its body when ANY of these hold:
  // claimed reply entries, live streaming, or pending state (which falls
  // through to the LiveActivityFeed for the target).
  const hasBody = Boolean(linkage) && depth < MAX_NEST_DEPTH

  // Round 12: subscribe to the full transcripts map ONCE — same pattern as
  // Round 11A's WorkstreamCard counter heuristic. Used for two derivations:
  //   (a) `sourceTimestampMs` — when did this card's source entry commit?
  //       Filters the fallback peek to replies AFTER the source so stale
  //       responses from prior batches don't count.
  //   (b) `hasFallbackReply` / `previewText` — both look at the target's
  //       last ~6 entries for a fresh non-control-token assistant reply.
  const transcripts = useChatStore((s) => s.transcripts)

  // Anchor: when did the source commit? We resolve the source entry by id
  // across every session's bucket. O(N total entries) but bounded by the
  // chat's last-500-entry cap per session, called once per card mount/dep
  // change. Fall back to 0 (matches any timestamp) when not found.
  const sourceTimestampMs = useMemo(() => {
    if (!linkage?.sourceEntryId) return 0
    for (const bucket of transcripts.values()) {
      for (let i = bucket.length - 1; i >= 0; i--) {
        const e = bucket[i]
        if (e?.entryId === linkage.sourceEntryId) return e.timestampMs ?? 0
      }
    }
    return 0
  }, [transcripts, linkage?.sourceEntryId])

  // Round 12A: "has the agent's reply landed anywhere?" — same fallback
  // heuristic Round 11A uses for the WorkstreamCard counter. When true,
  // the card stops glowing regardless of whether the linkage claim path
  // succeeded.
  const hasFallbackReply = useMemo(() => {
    if (!linkage?.targetSessionKey) return false
    const bucket = transcripts.get(linkage.targetSessionKey)
    if (!bucket || bucket.length === 0) return false
    const tail = bucket.slice(-6)
    for (let i = tail.length - 1; i >= 0; i--) {
      const e = tail[i]
      if (!e || !e.text) continue
      if (e.kind !== 'assistant') continue
      if (shouldDropAssistantTurn(e.text)) continue
      if ((e.timestampMs ?? 0) <= sourceTimestampMs) continue
      return true
    }
    return false
  }, [linkage?.targetSessionKey, transcripts, sourceTimestampMs])

  // Round 12B: preview text for the collapsed card. First sentence (or
  // ~90 chars) of the agent's reply, extracted from the same sources
  // LiveActivityFeed peeks at — claimed linkedEntries first, then bucket.
  const previewText = useMemo(() => {
    if (linkage) {
      for (const e of linkage.linkedEntries) {
        if (e.kind === 'assistant' && e.text && !shouldDropAssistantTurn(e.text)) {
          return firstSentencePreview(e.text)
        }
      }
    }
    if (!linkage?.targetSessionKey) return null
    const bucket = transcripts.get(linkage.targetSessionKey)
    if (!bucket || bucket.length === 0) return null
    const tail = bucket.slice(-6)
    for (let i = tail.length - 1; i >= 0; i--) {
      const e = tail[i]
      if (!e || !e.text) continue
      if (e.kind !== 'assistant') continue
      if (shouldDropAssistantTurn(e.text)) continue
      if ((e.timestampMs ?? 0) <= sourceTimestampMs) continue
      return firstSentencePreview(e.text)
    }
    return null
  }, [linkage, transcripts, sourceTimestampMs])

  // The unified "this card has visible content" signal — feeds the glow
  // gate (12A), the DONE pill (12C), and the just-completed flash (12D).
  const hasContent = hasLinkedEntries || hasStreaming || hasFallbackReply

  // Accordion topology — when this card's source isn't the latest
  // delegation in the leader's turn, default-collapse the response body so
  // the visible chat stays focused on the newest work. A user manual
  // toggle wins until `latestSourceEntryId` changes again (a new
  // delegation lands → old user override resets → newest auto-opens, old
  // auto-collapses).
  const isLatest = Boolean(
    linkage && latestSourceEntryId !== null && linkage.sourceEntryId === latestSourceEntryId,
  )
  // No linkage (1:1 chat path) → fall back to caller's `defaultExpanded`.
  const wantExpanded = linkage
    ? linkage.sourceEntryId === latestSourceEntryId ||
      (latestSourceEntryId === null && defaultExpanded)
    : defaultExpanded
  const [expandedOverride, setExpandedOverride] = useState<boolean | null>(null)
  const expanded = expandedOverride !== null ? expandedOverride : wantExpanded
  // Reset the manual override whenever the latest-source pointer moves —
  // a new delegation just landed, so this card's accordion state should
  // re-align with the "is this the newest one?" signal.
  useEffect(() => {
    setExpandedOverride(null)
  }, [latestSourceEntryId])

  // Task body — moved into the body top per Round 11B. Hidden by default
  // because the user wants the AGENT'S RESPONSE to be the primary visible
  // content; the instruction body is a debug detail.
  const [taskExpanded, setTaskExpanded] = useState(false)

  // Round 12A: glow gated by the visible-content signal (NOT the linkage's
  // raw `isPending`). When `LiveActivityFeed`'s fallback peek surfaces the
  // agent's reply, the body LOOKS done — the glow needs to match.
  const showPulseGlow = targetIsRunning && !hasContent

  // Round 12D: one-shot completion flash. When `hasContent` transitions
  // from false to true (the agent's reply just landed), fire a bright
  // mint glow that pulses up + fades for 1.5s, then settles to no glow.
  // After this, the card stays calm (no infinite pulse).
  const [justCompleted, setJustCompleted] = useState(false)
  const prevHadContent = useRef(hasContent)
  useEffect(() => {
    if (!prevHadContent.current && hasContent) {
      setJustCompleted(true)
      prevHadContent.current = hasContent
      const t = setTimeout(() => setJustCompleted(false), 1500)
      return () => clearTimeout(t)
    }
    prevHadContent.current = hasContent
  }, [hasContent])

  return (
    <motion.div
      className="flex flex-col gap-2 rounded-xl px-4 py-3"
      style={{
        border: `1px solid ${tint}33`,
        background: `linear-gradient(180deg, ${tint}10 0%, ${tint}06 55%, ${tint}03 100%)`,
        // Inset highlight keeps a subtle "lit edge" along the top so the
        // gradient reads as depth, not a flat panel.
        boxShadow: `inset 0 1px 0 ${tint}20`,
      }}
      initial={{ opacity: 0, y: 6 }}
      animate={
        showPulseGlow
          ? {
              // Working — infinite breathing glow in the agent's tint.
              opacity: 1,
              y: 0,
              boxShadow: [
                `inset 0 1px 0 ${tint}20, 0 0 0 0 ${tint}00`,
                `inset 0 1px 0 ${tint}20, 0 0 26px -8px ${tint}66`,
                `inset 0 1px 0 ${tint}20, 0 0 0 0 ${tint}00`,
              ],
            }
          : justCompleted
            ? {
                // Just landed — one-shot bright mint flash that fades to
                // nothing. Signals "reply delivered" without lingering.
                opacity: 1,
                y: 0,
                boxShadow: [
                  `inset 0 1px 0 ${tint}20, 0 0 0 0 rgb(var(--mint-rgb) / 0)`,
                  `inset 0 1px 0 ${tint}20, 0 0 32px -6px rgb(var(--mint-rgb) / 0.8)`,
                  `inset 0 1px 0 ${tint}20, 0 0 16px -8px rgb(var(--mint-rgb) / 0.4)`,
                  `inset 0 1px 0 ${tint}20, 0 0 0 0 rgb(var(--mint-rgb) / 0)`,
                ],
              }
            : { opacity: 1, y: 0 }
      }
      transition={
        showPulseGlow
          ? {
              opacity: {
                duration: 0.28,
                delay: animationIndex * 0.04,
                ease: [0.22, 0.61, 0.36, 1],
              },
              y: { duration: 0.28, delay: animationIndex * 0.04, ease: [0.22, 0.61, 0.36, 1] },
              boxShadow: { duration: 2.4, repeat: Infinity, ease: 'easeInOut' },
            }
          : justCompleted
            ? {
                opacity: { duration: 0.2 },
                y: { duration: 0.2 },
                boxShadow: { duration: 1.4, repeat: 0, ease: [0.22, 0.61, 0.36, 1] },
              }
            : { duration: 0.28, delay: animationIndex * 0.04, ease: [0.22, 0.61, 0.36, 1] }
      }
      data-testid="delegation-card"
      data-delegation-id={linkage?.delegationId}
      data-is-latest={isLatest ? 'true' : 'false'}
    >
      <div className="flex items-center gap-2.5">
        <BooAvatar seed={avatarSeed} size={28} tint={teamTint} isBooZero={isBooZero} />
        <div className="flex min-w-0 flex-col gap-0.5">
          <div className="flex items-center gap-1.5">
            {(() => {
              // Round 7: verb + badge differ by routing source so the user can
              // tell apart "the LLM explicitly delegated" vs. "Clawboo
              // routed this on the LLM's behalf".
              const src = linkage?.source ?? 'delegate-tag'
              const verb = src === 'clawboo-relay' ? 'Routed to' : 'Delegated to'
              return (
                <span
                  className="font-mono text-[10px] font-semibold uppercase tracking-widest"
                  style={{ color: tint }}
                >
                  {verb}
                </span>
              )
            })()}
            {(() => {
              // Origin badge for non-canonical paths.
              const src = linkage?.source ?? 'delegate-tag'
              if (src === 'clawboo-dispatch') {
                return (
                  <span
                    className="rounded-full px-1.5 py-0.5 font-mono text-[8px] font-semibold uppercase tracking-wider"
                    style={{ color: tint, background: `${tint}1a` }}
                    title="Clawboo dispatched this to the target on the LLM's behalf (fallback regex match)"
                  >
                    via clawboo
                  </span>
                )
              }
              if (src === 'clawboo-relay') {
                return (
                  <span
                    className="rounded-full px-1.5 py-0.5 font-mono text-[8px] font-semibold uppercase tracking-wider"
                    style={{
                      color: 'var(--muted-foreground)',
                      background: 'rgb(var(--mint-rgb) / 0.06)',
                    }}
                    title="Clawboo forwarded the source's response to this teammate as a [Team Update]"
                  >
                    routed
                  </span>
                )
              }
              return null
            })()}
          </div>
          <span className="truncate font-mono text-[11.5px] font-semibold text-text">
            @{targetName}
          </span>
          {/* Round 12B/E: preview line — single muted sentence of the
              agent's reply, shown ONLY when the card is collapsed. When
              expanded, the full reply renders below and the preview would
              be redundant. */}
          {!expanded && previewText && (
            <span
              className="truncate text-[11px] leading-snug text-text/55 italic"
              data-testid="delegation-card-preview"
              title={previewText}
            >
              {previewText}
            </span>
          )}
        </div>
        <div className="ml-auto flex items-center gap-2">
          {/* Round 12C: status indicator — three states.
              - Working (running + no content yet): animated mint pulse-ring
              - Done (content visible — linked OR fallback): mint DONE pill
              - Idle / waiting: dim gray dot */}
          {showPulseGlow ? (
            <span className="relative flex h-2 w-2" title="Working…">
              <span
                aria-hidden
                className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-60"
                style={{ background: tint }}
              />
              <span
                aria-hidden
                className="relative inline-flex h-2 w-2 rounded-full"
                style={{ background: tint }}
              />
            </span>
          ) : hasContent ? (
            <span
              className="rounded-full bg-mint/20 px-1.5 py-0.5 font-mono text-[8px] font-semibold uppercase tracking-wider text-mint"
              title="Reply delivered"
            >
              Done
            </span>
          ) : (
            <span
              aria-hidden
              className="h-2 w-2 rounded-full bg-foreground/15"
              title="Awaiting response"
            />
          )}
          {hasBody && (
            <button
              type="button"
              onClick={() => setExpandedOverride(expanded ? false : true)}
              className="flex h-6 w-6 items-center justify-center rounded-md hover:bg-foreground/5"
              aria-label={expanded ? 'Collapse response' : 'Expand response'}
              data-testid="delegation-toggle"
            >
              <ChevronRight
                size={14}
                style={{ color: tint }}
                className={`shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`}
              />
            </button>
          )}
        </div>
      </div>

      {/* Response body — primary visible content. The TASK toggle moved
          here per Round 11B (was in the header, was cluttered). */}
      <AnimatePresence initial={false}>
        {expanded && hasBody && linkage && (
          <motion.div
            key="body"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: [0.22, 0.61, 0.36, 1] }}
            className="overflow-hidden"
            data-testid="delegation-card-body"
          >
            <div
              className="mt-1 flex flex-col gap-2 border-t border-dashed pt-2.5 text-[13px] leading-relaxed text-text/95"
              style={{ borderColor: `${tint}20` }}
            >
              {/* Round 11B: task toggle lives at the top of the body. */}
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-[9px] font-semibold uppercase tracking-wider text-text/45">
                  Response
                </span>
                <button
                  type="button"
                  onClick={() => setTaskExpanded((v) => !v)}
                  className={`flex items-center gap-1 rounded font-mono text-[9px] uppercase tracking-wider transition-opacity hover:text-text/80 ${
                    taskExpanded ? 'text-text/70' : 'text-text/40'
                  }`}
                  aria-label={taskExpanded ? 'Hide task' : 'Show task'}
                  data-testid="delegation-task-toggle"
                  title="Show the task body Clawboo sent to the agent"
                >
                  <span className="underline decoration-dotted underline-offset-4">
                    {taskExpanded ? 'Hide task' : 'Show task'}
                  </span>
                  <ChevronRight
                    size={9}
                    className={`shrink-0 transition-transform ${taskExpanded ? 'rotate-90' : ''}`}
                  />
                </button>
              </div>

              <AnimatePresence>
                {taskExpanded && (
                  <motion.div
                    key="task"
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.18, ease: [0.22, 0.61, 0.36, 1] }}
                    className="overflow-hidden"
                    data-testid="delegation-card-task"
                  >
                    <div
                      className="rounded-md border border-dashed px-3 py-2 text-[12px] leading-relaxed whitespace-pre-wrap text-text/75"
                      style={{ borderColor: `${tint}33`, background: `${tint}08` }}
                    >
                      <div className="mb-1 font-mono text-[8px] font-semibold uppercase tracking-widest text-text/45">
                        Task from Clawboo
                      </div>
                      {task}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              {hasLinkedEntries || hasStreaming ? (
                <NestedDelegationBody
                  entries={linkage.linkedEntries}
                  streamingText={streamingText}
                  teamId={teamId}
                  depth={depth + 1}
                  latestSourceEntryId={latestSourceEntryId}
                />
              ) : (
                <LiveActivityFeed
                  targetAgentId={targetAgentId}
                  targetSessionKey={linkage.targetSessionKey}
                  tint={tint}
                />
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
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
        <div
          className="max-w-prose text-[13px] leading-relaxed text-text/90"
          data-testid="delegation-streaming"
        >
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>
            {streamingText}
          </ReactMarkdown>
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

// ─── PlanCard (Round 9) ──────────────────────────────────────────────────────
//
// Visual container for a `<plan>` block's step-DelegationCards. Renders a
// header with the step count + progress, then each step card under a
// numbered "Step N" label. The individual step cards are still
// `DelegationCard`s — PlanCard is purely the visual grouping wrapper.
//
// Progress signal comes from `pendingPlans` in the chat store: the plan's
// `currentStepIndex` tells the renderer how many steps have completed.
// `currentStepIndex >= steps.length` ⇒ "Complete" badge replaces the
// in-progress indicator.

export const PlanCard = memo(function PlanCard({
  planId,
  linkages,
  teamId,
  defaultExpanded = true,
  latestSourceEntryId,
}: {
  planId: string
  /** Plan-step linkages, in stepIndex order. Pre-sorted by the caller. */
  linkages: DelegationLinkage[]
  teamId?: string
  defaultExpanded?: boolean
  latestSourceEntryId?: string | null
}) {
  // Subscribe to the plan's progress state. The pendingPlan may not exist
  // (e.g., after a page reload — the store doesn't persist plans). In that
  // case we derive progress from the linkages themselves: a step is
  // "complete" if its linkage has linkedEntries.
  const pendingPlan = useChatStore((s) => s.pendingPlans.get(planId) ?? null)
  const totalSteps = pendingPlan?.steps.length ?? linkages.length
  const completedFromStore = pendingPlan?.currentStepIndex ?? 0
  const completedFromLinkages = linkages.filter((l) => !l.isPending).length
  // Use whichever is more up-to-date — store advances reactively during the
  // active session, linkages capture historical state after reload.
  const completedSteps = Math.max(completedFromStore, completedFromLinkages)
  const isComplete = completedSteps >= totalSteps && totalSteps > 0

  return (
    <div
      className="@container flex flex-col gap-3 rounded-xl border border-border bg-gradient-to-b from-foreground/[0.025] to-foreground/[0.008] p-4"
      data-testid="plan-card"
      data-plan-id={planId}
    >
      <div className="flex items-center gap-2 border-b border-border/60 pb-2.5">
        <Workflow size={14} strokeWidth={1.75} aria-hidden className="text-secondary" />
        <span className="font-mono text-[10px] font-semibold uppercase tracking-widest text-secondary">
          Plan
        </span>
        <span className="font-mono text-[10px] text-text/70">
          {totalSteps} {totalSteps === 1 ? 'step' : 'steps'}
        </span>
        <span className="ml-auto flex items-center gap-1.5">
          {isComplete ? (
            <span
              className="rounded-full bg-emerald-500/15 px-2 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-wider text-emerald-400"
              title="All plan steps complete — the leader has received a [Plan Complete] envelope and should now synthesize."
            >
              Complete
            </span>
          ) : (
            <>
              <span
                aria-hidden
                className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400/80"
              />
              <span className="font-mono text-[10px] text-text/70">
                {completedSteps} / {totalSteps} done
              </span>
            </>
          )}
        </span>
      </div>
      {/* Plans are SEQUENTIAL (Round 8) but the grid still gives them
          breathing room at wide widths — cards stack 1-col on narrow
          screens and pair to 2-col at >=640px container width. */}
      <div className="grid grid-cols-1 gap-3 @[640px]:grid-cols-2">
        {linkages.map((linkage, idx) => {
          // Step index — prefer the stored planStepIndex; fall back to
          // render order so layout is stable even when the field is missing.
          const stepNum = (linkage.planStepIndex ?? idx) + 1
          return (
            <div
              key={linkage.delegationId}
              className="flex flex-col gap-1"
              data-plan-step-index={linkage.planStepIndex ?? idx}
            >
              <span className="font-mono text-[9px] font-semibold uppercase tracking-wider text-secondary/70">
                Step {stepNum}
              </span>
              <DelegationCard
                // DelegationCard renders `@{targetName}` itself; pass bare
                // name (no leading `@`) to avoid `@@` double-prefix.
                targetName={linkage.targetAgentName}
                task={linkage.task}
                linkage={linkage}
                teamId={teamId}
                defaultExpanded={defaultExpanded}
                latestSourceEntryId={latestSourceEntryId}
                animationIndex={idx}
              />
            </div>
          )
        })}
      </div>
    </div>
  )
})

// ─── WorkstreamCard (Round 10) ────────────────────────────────────────────────
//
// Visual container for a parallel-workstream batch (≥2 sibling `<delegate>`
// tags emitted in one leader turn, no `<plan>` wrapper). Mirrors PlanCard's
// structure but with parallel semantics — no step ordering, just an
// in-flight set with X / N done progress.
//
// Progress signal comes from two sources:
//   1. `pendingWorkstreams` in the chat store — reactive during the active
//      session, drives the in-flight indicator.
//   2. The linkages themselves — `linkages.filter(l => !l.isPending).length`.
//      Survives page reload (the in-memory `pendingWorkstreams` map resets,
//      but linkages re-derive from committed transcript on every render).
// `Math.max(storeCount, linkageCount)` keeps the card accurate in both
// active and post-reload contexts.

export const WorkstreamCard = memo(function WorkstreamCard({
  workstreamId,
  linkages,
  teamId,
  defaultExpanded = true,
  latestSourceEntryId,
}: {
  workstreamId: string
  /** Workstream-step linkages, in target-index order. Pre-sorted by the caller. */
  linkages: DelegationLinkage[]
  teamId?: string
  defaultExpanded?: boolean
  latestSourceEntryId?: string | null
}) {
  const pendingWs = useChatStore((s) => s.pendingWorkstreams.get(workstreamId) ?? null)
  const totalTargets = pendingWs?.targets.length ?? linkages.length
  const completedFromStore =
    pendingWs?.targets.filter((t) => t.resolvedEntryId !== null).length ?? 0

  // Round 11A: count cards as "done" if either the linkage was claimed OR
  // the LiveActivityFeed would render a substantive assistant reply (the
  // user sees content → it's "done" from their perspective). Mirrors
  // `pickLatestActivity`'s heuristic but skips streaming-state (that's
  // in-progress, not done) and skips control tokens via
  // `shouldDropAssistantTurn`.
  const transcripts = useChatStore((s) => s.transcripts)
  const wsTimestamp = pendingWs?.timestampMs ?? 0
  const completedFromContent = useMemo(() => {
    let count = 0
    for (const l of linkages) {
      if (!l.isPending) {
        count++
        continue
      }
      // Pending linkage — peek at the target's bucket for a fresh
      // substantive reply (mirror of `LiveActivityFeed`'s fallback).
      const bucket = transcripts.get(l.targetSessionKey)
      if (!bucket || bucket.length === 0) continue
      const tail = bucket.slice(-6)
      let found = false
      for (let i = tail.length - 1; i >= 0; i--) {
        const e = tail[i]
        if (!e || !e.text) continue
        if (e.kind !== 'assistant') continue
        if (shouldDropAssistantTurn(e.text)) continue
        if ((e.timestampMs ?? 0) <= wsTimestamp) continue
        found = true
        break
      }
      if (found) count++
    }
    return count
  }, [linkages, transcripts, wsTimestamp])

  const completedTargets = Math.max(completedFromStore, completedFromContent)
  const isComplete = completedTargets >= totalTargets && totalTargets > 0

  return (
    <div
      className="@container flex flex-col gap-3 rounded-xl border border-border bg-gradient-to-b from-foreground/[0.025] to-foreground/[0.008] p-4"
      data-testid="workstream-card"
      data-workstream-id={workstreamId}
    >
      <div className="flex items-center gap-2 border-b border-border/60 pb-2.5">
        <Network size={14} strokeWidth={1.75} aria-hidden className="text-secondary" />
        <span className="font-mono text-[10px] font-semibold uppercase tracking-widest text-secondary">
          Workstreams
        </span>
        <span className="font-mono text-[10px] text-text/70">
          {totalTargets} {totalTargets === 1 ? 'workstream' : 'workstreams'}
        </span>
        <span className="ml-auto flex items-center gap-1.5">
          {isComplete ? (
            <span
              className="rounded-full bg-emerald-500/15 px-2 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-wider text-emerald-400"
              title="All parallel workstreams complete — the leader has received a [Workstreams Complete] envelope and should now synthesize across them."
            >
              Complete
            </span>
          ) : (
            <>
              <span
                aria-hidden
                className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400/80"
              />
              <span className="font-mono text-[10px] text-text/70">
                {completedTargets} / {totalTargets} done
              </span>
            </>
          )}
        </span>
      </div>
      {/* Round 11D: responsive 2-col grid. Tailwind 4 container queries —
          the grid adapts to the WorkstreamCard's OWN width (not the
          viewport's), so a narrow chat panel collapses to 1-col cleanly
          and a wide panel uses the previously-unused horizontal space. */}
      <div className="grid grid-cols-1 gap-3 @[640px]:grid-cols-2">
        {linkages.map((linkage, idx) => {
          // Workstream index — prefer the stored workstreamTargetIndex; fall
          // back to render order so layout is stable even when the field is
          // missing.
          const wsNum = (linkage.workstreamTargetIndex ?? idx) + 1
          return (
            <div
              key={linkage.delegationId}
              className="flex flex-col gap-1"
              data-workstream-target-index={linkage.workstreamTargetIndex ?? idx}
            >
              <span className="font-mono text-[9px] font-semibold uppercase tracking-wider text-secondary/70">
                Workstream {wsNum}
              </span>
              <DelegationCard
                // DelegationCard renders `@{targetName}` itself; pass bare
                // name (no leading `@`) to avoid `@@` double-prefix.
                targetName={linkage.targetAgentName}
                task={linkage.task}
                linkage={linkage}
                teamId={teamId}
                defaultExpanded={defaultExpanded}
                latestSourceEntryId={latestSourceEntryId}
                animationIndex={idx}
              />
            </div>
          )
        })}
      </div>
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
  claimedEntries,
  teamId,
  latestSourceEntryId,
  isFollowup = false,
}: {
  block: AssistantBlock
  agentId: string
  agentName: string
  streaming?: boolean
  /** Group-chat-only: pass-through so DelegationCard segments can nest target replies. */
  linkagesBySourceEntry?: Map<string, DelegationLinkage[]>
  /**
   * Group-chat-only: ids of tool entries claimed by Round 6's
   * `sessions_send` linkage scan. Those entries already render as
   * DelegationCards inside the prose region — the raw `[[tool]]`
   * `ToolCallCard` is suppressed so the same routing event doesn't appear
   * twice. Defaults to an empty set when omitted (1:1 chat path).
   */
  claimedEntries?: Set<string>
  /** Group-chat-only: needed by nested DelegationCards to resolve target session keys. */
  teamId?: string
  /** Group-chat-only: source entryId whose delegations default-expand (newest exposed). */
  latestSourceEntryId?: string | null
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
  // Round 6: filter tool entries claimed by `sessions_send` linkages — those
  // render as DelegationCards inside the prose region below; rendering the
  // raw `[[tool]] sessions_send` ToolCallCard would duplicate the routing
  // event visually.
  const visibleTools = claimedEntries
    ? block.tools.filter((entry) => !claimedEntries.has(entry.entryId))
    : block.tools
  const hasTools = visibleTools.length > 0
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
      {/* Header — avatar bumped to 28px and name lifted to 11.5px / full
          secondary opacity so the agent identity is legible at a glance
          (the previous 22px avatar + 10px name @ 70% opacity made the
          header feel like a footnote under the body).
          Suppressed when `isFollowup` — the parent renderer sets that flag
          for consecutive same-author messages so the repeated chrome
          doesn't double-render. The body still aligns under where the
          header would be, so the burst reads as one continuous section. */}
      {!isFollowup && (
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <AgentBooAvatar agentId={agentId} size={28} />
            <span
              className="font-mono font-semibold uppercase tracking-widest text-secondary"
              style={{ fontSize: 11.5 }}
            >
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
      )}

      {/* Thinking trace */}
      {(hasThinking || (streaming && !hasText)) && (
        <ThinkingSection
          entries={block.thinking}
          thinkingDurationMs={block.thinkingDurationMs}
          streaming={streaming && !hasText}
        />
      )}

      {/* Tool calls (after filtering out Round 6's `sessions_send` entries
          that already render as DelegationCards in the prose region below). */}
      {hasTools && (
        <div className="flex flex-col gap-1">
          {visibleTools.map((entry) => (
            <ToolCallCard key={entry.entryId} entry={entry} />
          ))}
        </div>
      )}

      {/* Assistant text — strip relay prefix, split structured `<delegate>`
          blocks into their own cards. Round 6 also injects DelegationCards
          for `sessions_send` tool calls between the leader's intro prose
          and any post-`\n---\n` summary prose, restoring the natural
          "intro → cards → summary" flow within the leader's card.
          Round 9 adds the PlanCard rendering: linkages with the same
          `planId` get grouped under one `<PlanCard>` (rendered alongside
          sessions_send cards between intro + outro prose). Raw `<plan>`
          markdown is stripped so it doesn't show as text.
          `max-w-prose` (~65ch) caps line length to the optimal reading
          measure regardless of window width. */}
      {hasText &&
        (() => {
          let rawText = isRelay ? stripRelayPrefix(block.assistant!.text) : block.assistant!.text
          // Pull linkages for this source and split them by source kind.
          const allLinkagesForSource =
            block.assistant && linkagesBySourceEntry
              ? (linkagesBySourceEntry.get(block.assistant.entryId) ?? [])
              : []
          const sessionsSendLinkages = allLinkagesForSource.filter(
            (l) => l.source === 'sessions-send',
          )
          // Round 9: group plan-step linkages by `planId`. Each plan
          // becomes one `<PlanCard>` containing its step DelegationCards.
          const planGroups = new Map<string, DelegationLinkage[]>()
          for (const linkage of allLinkagesForSource) {
            if (!linkage.planId) continue
            const group = planGroups.get(linkage.planId)
            if (group) group.push(linkage)
            else planGroups.set(linkage.planId, [linkage])
          }
          // Sort each group's linkages by step index for stable display.
          for (const group of planGroups.values()) {
            group.sort((a, b) => (a.planStepIndex ?? 0) - (b.planStepIndex ?? 0))
          }
          // Round 9: strip raw `<plan>…</plan>` markdown when we'll render
          // PlanCards in its place. Without this the leader's prose would
          // show the unrendered tags as text alongside the visual cards.
          if (planGroups.size > 0) {
            rawText = stripPlanBlocks(rawText)
          }

          // Round 10: group parallel-workstream linkages by `workstreamId`.
          // Each group becomes one `<WorkstreamCard>` containing its
          // sibling DelegationCards under a "📡 WORKSTREAMS" header with
          // progress indicator. Workstream linkages always have
          // `source: 'delegate-tag'` (they're Path 1 linkages with the
          // `workstreamId` field attributed by `buildDelegationLinkages`
          // when N≥2 valid `<delegate>` blocks exist on a non-plan source).
          const workstreamGroups = new Map<string, DelegationLinkage[]>()
          for (const linkage of allLinkagesForSource) {
            if (!linkage.workstreamId) continue
            const group = workstreamGroups.get(linkage.workstreamId)
            if (group) group.push(linkage)
            else workstreamGroups.set(linkage.workstreamId, [linkage])
          }
          for (const group of workstreamGroups.values()) {
            group.sort((a, b) => (a.workstreamTargetIndex ?? 0) - (b.workstreamTargetIndex ?? 0))
          }
          // Round 10: build a set of `blockStart` offsets that belong to a
          // workstream so the inline-delegation renderer can skip them (they
          // render inside the WorkstreamCard instead, and rendering them
          // twice would clutter the leader's card).
          const workstreamBlockStarts = new Set<number>()
          for (const group of workstreamGroups.values()) {
            for (const l of group) workstreamBlockStarts.add(l.blockStart)
          }

          // Split the prose at the first `\n---\n` markdown horizontal rule
          // when we have `sessions_send`, PlanCards, OR WorkstreamCards to
          // inject. Without any, the whole prose renders as one segment (no
          // behavioral regression for turns that don't use any path).
          const splitMatch =
            sessionsSendLinkages.length > 0 || planGroups.size > 0 || workstreamGroups.size > 0
              ? rawText.match(/\n---\n/)
              : null
          const splitIdx = splitMatch?.index ?? -1
          const introText = splitIdx >= 0 ? rawText.slice(0, splitIdx) : rawText
          const summaryText =
            splitIdx >= 0 && splitMatch ? rawText.slice(splitIdx + splitMatch[0].length) : ''

          const expandedDefault = block.assistant
            ? block.assistant.entryId === latestSourceEntryId
            : true

          const renderProseSegments = (proseText: string, keyBase: string) =>
            splitAssistantText(proseText).map((segment, idx) => {
              if (segment.kind === 'delegation') {
                // Round 10: when this delegation is part of a workstream
                // batch, skip the inline render — it'll appear inside the
                // WorkstreamCard below. Rendering it both inline AND in the
                // card would duplicate the routing event visually.
                if (workstreamBlockStarts.has(segment.blockStart)) return null
                const matchedLinkage =
                  block.assistant && linkagesBySourceEntry
                    ? linkagesBySourceEntry
                        .get(block.assistant.entryId)
                        ?.find(
                          (l) => l.source === 'delegate-tag' && l.blockStart === segment.blockStart,
                        )
                    : undefined
                return (
                  <DelegationCard
                    key={`${keyBase}-delegation-${idx}`}
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
                  key={`${keyBase}-prose-${idx}`}
                  remarkPlugins={[remarkGfm]}
                  components={MD_COMPONENTS}
                >
                  {segment.text}
                </ReactMarkdown>
              )
            })

          // Round 11D — break PlanCards / WorkstreamCards OUT of the
          // `max-w-prose` cap so they can use the full chat-panel width
          // (the previously-empty horizontal space the user pointed at).
          // Intro / outro PROSE segments stay capped at the ~65ch reading
          // measure; `sessions_send` cards sit inside the prose flow
          // because they're typically one-off (not a parallel batch).
          const hasFullWidthCards = planGroups.size > 0 || workstreamGroups.size > 0
          return (
            <div className="flex flex-col gap-2 text-[13px] leading-relaxed text-text">
              <div className="max-w-prose">{renderProseSegments(introText, 'intro')}</div>
              {hasFullWidthCards && (
                <div className="flex w-full flex-col gap-3">
                  {/* Round 9: PlanCards (one per `planId`). Each contains
                      its step DelegationCards under a "📋 Plan" header
                      with progress indicator. */}
                  {Array.from(planGroups.entries()).map(([planId, group]) => (
                    <PlanCard
                      key={`plan-${planId}`}
                      planId={planId}
                      linkages={group}
                      teamId={teamId}
                      defaultExpanded={expandedDefault}
                      latestSourceEntryId={latestSourceEntryId}
                    />
                  ))}
                  {/* Round 10: WorkstreamCards (one per `workstreamId`). */}
                  {Array.from(workstreamGroups.entries()).map(([wsId, group]) => (
                    <WorkstreamCard
                      key={`workstream-${wsId}`}
                      workstreamId={wsId}
                      linkages={group}
                      teamId={teamId}
                      defaultExpanded={expandedDefault}
                      latestSourceEntryId={latestSourceEntryId}
                    />
                  ))}
                </div>
              )}
              <div className="flex max-w-prose flex-col gap-2">
                {sessionsSendLinkages.map((linkage) => (
                  <DelegationCard
                    key={linkage.delegationId}
                    // DelegationCard renders `@{targetName}` itself; pass
                    // bare name to avoid `@@` double-prefix.
                    targetName={linkage.targetAgentName}
                    task={linkage.task}
                    linkage={linkage}
                    teamId={teamId}
                    defaultExpanded={expandedDefault}
                    latestSourceEntryId={latestSourceEntryId}
                  />
                ))}
                {summaryText && renderProseSegments(summaryText, 'summary')}
              </div>
            </div>
          )
        })()}

      {/* Streaming text */}
      {streaming && !hasText && !hasThinking && <TypingIndicator />}

      {/* Token usage (real from Gateway) or estimated from char count */}
      {!streaming && hasText && (
        <p className="font-mono text-[10px] tabular-nums text-secondary/40">
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
          className="font-mono font-semibold uppercase tracking-widest text-secondary"
          style={{ fontSize: 11.5 }}
        >
          {agentName}
        </span>
      </div>
      {hasText ? (
        <div className="flex max-w-prose flex-col gap-2 text-[13px] leading-relaxed text-text opacity-80">
          {segments.map((segment, idx) =>
            segment.kind === 'delegation' ? (
              <DelegationCard
                key={`stream-delegation-${idx}`}
                targetName={segment.targetName}
                task={segment.task}
              />
            ) : (
              // Round 6 (Layer 6B): render streaming prose with the same
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
      <div className="border-t border-border px-4 py-3">
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
            className="flex-1 resize-none overflow-hidden rounded-lg border border-border bg-input px-3 py-2 text-[13px] text-text outline-none transition placeholder:text-secondary/40 focus:border-foreground/20 focus:ring-1 focus:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-40"
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
              className="flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-lg bg-accent text-primary-foreground transition hover:brightness-110"
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
              className="flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-lg bg-accent text-primary-foreground transition hover:brightness-110 disabled:cursor-not-allowed disabled:bg-muted disabled:text-secondary"
            >
              <SendHorizontal className="h-4 w-4" strokeWidth={2} />
            </button>
          )}
        </div>
        <p className="mt-1.5 text-right font-mono text-[10px] text-secondary/30">
          Enter to send · Shift+Enter for newline · /reset for new session · /rule &lt;text&gt; to
          save a team rule
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
      className="absolute bottom-full left-0 z-50 mb-1 max-h-[200px] min-w-[180px] overflow-y-auto rounded-lg border border-border bg-popover py-1 shadow-lg"
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
            'flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-popover-foreground transition-colors',
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
                background: `${agent.color ?? '#e94560'}33`,
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
