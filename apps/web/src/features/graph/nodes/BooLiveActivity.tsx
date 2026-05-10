import { memo, useMemo } from 'react'
import { motion } from 'framer-motion'
import { useFleetStore } from '@/stores/fleet'
import { useChatStore } from '@/stores/chat'
import { pickLatestActivity } from './pickLatestActivity'

// ─── BooLiveActivity ────────────────────────────────────────────────────────
//
// Renders the most recent agent activity in a Boo card's middle band when
// the agent is running. Uses single-value Zustand selectors so updates to
// other agents' streams don't re-render this Boo (repo precedent:
// `chatComponents.tsx:472`'s `lastTokenUsage.get(runId)` pattern).

export const BooLiveActivity = memo(function BooLiveActivity({ agentId }: { agentId: string }) {
  const sessionKey = useFleetStore(
    (s) => s.agents.find((a) => a.id === agentId)?.sessionKey ?? null,
  )
  const streamingText = useChatStore((s) =>
    sessionKey ? (s.streamingText.get(sessionKey) ?? null) : null,
  )
  const entries = useChatStore((s) => (sessionKey ? (s.transcripts.get(sessionKey) ?? null) : null))

  const activity = useMemo(
    () => pickLatestActivity(streamingText, entries),
    [streamingText, entries],
  )

  if (!sessionKey) return null
  if (!activity) return <InlineTyping />

  const isStreaming = activity.kind === 'streaming'
  return (
    <div
      style={{
        fontFamily: 'var(--font-mono, "Geist Mono", ui-monospace, monospace)',
        fontSize: 11,
        lineHeight: 1.35,
        color: 'rgba(232,232,232,0.6)',
        display: '-webkit-box',
        WebkitLineClamp: 2,
        WebkitBoxOrient: 'vertical',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'normal',
        wordBreak: 'break-word',
        textAlign: 'left',
        width: '100%',
      }}
    >
      {isStreaming && (
        <motion.span
          aria-hidden
          animate={{ opacity: [0.3, 1, 0.3] }}
          transition={{ duration: 1.2, repeat: Infinity, ease: 'easeInOut' }}
          style={{
            display: 'inline-block',
            width: 4,
            height: 4,
            borderRadius: '50%',
            background: '#34D399',
            marginRight: 6,
            verticalAlign: 'middle',
          }}
        />
      )}
      {activity.text}
    </div>
  )
})

function InlineTyping() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, opacity: 0.55 }}>
      {[0, 1, 2].map((i) => (
        <motion.span
          key={i}
          style={{
            width: 4,
            height: 4,
            borderRadius: '50%',
            background: '#34D399',
            display: 'inline-block',
          }}
          animate={{ opacity: [0.3, 1, 0.3] }}
          transition={{
            duration: 1.2,
            repeat: Infinity,
            delay: i * 0.15,
            ease: 'easeInOut',
          }}
        />
      ))}
    </div>
  )
}
