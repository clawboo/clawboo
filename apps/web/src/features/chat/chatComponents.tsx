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
import { ChevronRight, Clock, SendHorizontal, Wrench } from 'lucide-react'
import type { TranscriptEntry } from '@clawboo/protocol'
import { AgentBooAvatar } from '@/components/AgentBooAvatar'
import { useFleetStore } from '@/stores/fleet'
import { useChatStore } from '@/stores/chat'
import { calculateCostUsd, formatCost } from '@/features/cost/costUtils'

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

// ─── AssistantTurnCard ────────────────────────────────────────────────────────

export const AssistantTurnCard = memo(function AssistantTurnCard({
  block,
  agentId,
  agentName,
  streaming,
}: {
  block: AssistantBlock
  agentId: string
  agentName: string
  streaming?: boolean
}) {
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
    <div className="flex flex-col gap-2">
      {/* Header */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <AgentBooAvatar agentId={agentId} size={22} />
          <span className="font-mono text-[10px] font-semibold uppercase tracking-widest text-secondary/70">
            {agentName}
          </span>
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

      {/* Assistant text */}
      {hasText && (
        <div className="text-[13px] leading-relaxed text-text">
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>
            {block.assistant!.text}
          </ReactMarkdown>
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
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <AgentBooAvatar agentId={agentId} size={22} />
        <span className="font-mono text-[10px] font-semibold uppercase tracking-widest text-secondary/70">
          {agentName}
        </span>
      </div>
      {hasText ? (
        <div className="text-[13px] leading-relaxed text-text opacity-80">{text}</div>
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

export const MessageComposer = memo(
  forwardRef<
    MessageComposerHandle,
    {
      onSend: (message: string) => void
      disabled: boolean
      placeholder?: string
      /** Team agents for @mention autocomplete. Only provided in group chat. */
      mentionAgents?: { id: string; name: string }[]
    }
  >(function MessageComposer({ onSend, disabled, placeholder, mentionAgents }, ref) {
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
  agents: { id: string; name: string }[]
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
          <AgentBooAvatar agentId={agent.id} size={20} />
          <span className="truncate">{agent.name}</span>
        </button>
      ))}
    </div>
  )
})
