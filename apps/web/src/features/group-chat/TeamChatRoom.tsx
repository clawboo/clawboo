// TeamChatRoom — the read-only peer-chat room surfaced in the team view (the
// durable team room; the model-facing WRITE half is the TeamChat MCP). Every
// teammate posts as a NAMED peer, and ANY runtime can lead — this is the "one
// room, any runtime can lead" surface a user looks for inside the team. Read-only
// here: peers post via their MCP tool, not from this panel. Polls the cursor-based
// /api/team-chat read on an 8s cadence (matching the rest of the dashboard).

import { useCallback, useEffect, useRef, useState } from 'react'
import { MessagesSquare, X } from 'lucide-react'

import { AgentBooAvatar } from '@/components/AgentBooAvatar'
import { IconButton } from '@/features/shared/Button'
import { Modal } from '@/features/shared/Modal'
import { formatRelative } from '@/lib/formatRelative'
import { fetchTeamChat, type TeamChatPost } from '@/lib/teamChatClient'
import { useFleetStore } from '@/stores/fleet'

const muted = (o: number) => `rgb(var(--foreground-rgb) / ${o})`

function PeerPost({ post, authorName }: { post: TeamChatPost; authorName: string }) {
  if (post.kind === 'system') {
    return (
      <div
        style={{
          fontSize: 10.5,
          color: muted(0.45),
          textAlign: 'center',
          padding: '4px 0',
          fontFamily: 'var(--font-geist-mono, monospace)',
        }}
      >
        {post.body}
      </div>
    )
  }
  const isUser = post.kind === 'user'
  return (
    <div style={{ display: 'flex', gap: 9, alignItems: 'flex-start' }}>
      {isUser ? (
        <span
          style={{
            width: 26,
            height: 26,
            borderRadius: 13,
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 10,
            fontWeight: 700,
            color: 'var(--foreground)',
            background: muted(0.1),
          }}
        >
          You
        </span>
      ) : (
        <AgentBooAvatar agentId={post.authorAgentId} size={26} />
      )}
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 7 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--foreground)' }}>
            {isUser ? 'You' : authorName}
          </span>
          <span style={{ fontSize: 10, color: muted(0.4) }}>{formatRelative(post.createdAt)}</span>
        </div>
        <div
          style={{
            fontSize: 12,
            color: muted(0.7),
            lineHeight: 1.5,
            marginTop: 1,
            wordBreak: 'break-word',
          }}
        >
          {post.body}
        </div>
      </div>
    </div>
  )
}

export function TeamChatRoom({ teamId, onClose }: { teamId: string; onClose: () => void }) {
  const agents = useFleetStore((s) => s.agents)
  const [posts, setPosts] = useState<TeamChatPost[]>([])
  const [loaded, setLoaded] = useState(false)
  const scrollRef = useRef<HTMLDivElement | null>(null)

  const nameFor = useCallback(
    (agentId: string) => agents.find((a) => a.id === agentId)?.name ?? agentId,
    [agents],
  )

  const refresh = useCallback(async () => {
    const room = await fetchTeamChat(teamId)
    setPosts(room.posts)
    setLoaded(true)
  }, [teamId])

  useEffect(() => {
    void refresh()
    const id = setInterval(() => void refresh(), 8000)
    return () => clearInterval(id)
  }, [refresh])

  // Keep pinned to the newest post when the list grows.
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [posts.length])

  // ── A11y: announce peer posts that arrive while the room is open ──────────
  // The room polls every 8 s, so "new" means "seq beyond the last poll" — never
  // the backlog present on first load, which would read the whole room aloud.
  const [announcement, setAnnouncement] = useState<{ key: string; text: string } | null>(null)
  const seenSeqRef = useRef<number | null>(null)

  useEffect(() => {
    const newest = posts[posts.length - 1]
    if (!newest) return
    const seen = seenSeqRef.current
    seenSeqRef.current = newest.seq
    if (seen === null || newest.seq <= seen) return
    const fresh = posts.filter((p) => p.seq > seen)
    const author = newest.kind === 'user' ? 'You' : nameFor(newest.authorAgentId)
    setAnnouncement({
      key: String(newest.seq),
      text:
        fresh.length > 1
          ? `${fresh.length} new messages in the team room.`
          : newest.kind === 'system'
            ? newest.body
            : `${author}: ${newest.body}`,
    })
  }, [posts, nameFor])

  // Dialog semantics (it had role + label but no aria-modal and no focus trap),
  // Escape, and focus-return all come from Modal now.
  return (
    <Modal
      open
      variant="drawer"
      layer={60}
      label="Team room"
      onClose={onClose}
      data-testid="team-chat-room"
      panelClassName="flex flex-col"
      panelStyle={{
        width: 'min(420px, 92vw)',
        background: 'var(--surface)',
        borderLeft: '1px solid rgb(var(--foreground-rgb) / 0.08)',
      }}
    >
      <div
        style={{
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 9,
          padding: '12px 14px',
          borderBottom: '1px solid rgb(var(--foreground-rgb) / 0.08)',
        }}
      >
        <MessagesSquare size={16} style={{ color: 'var(--mint)' }} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--foreground)' }}>Team room</div>
          <div style={{ fontSize: 10.5, color: muted(0.5) }}>
            Every runtime posts as a named peer — any runtime can lead.
          </div>
        </div>
        <IconButton variant="ghost" size="sm" label="Close" onClick={onClose}>
          <X size={16} />
        </IconButton>
      </div>

      {/* Polite announcement of posts that land while the room is open. The
          inner key remounts the text node so two identical consecutive posts
          still register as a mutation. */}
      <span role="status" aria-live="polite" className="sr-only" data-testid="team-chat-announcer">
        {announcement && <span key={announcement.key}>{announcement.text}</span>}
      </span>

      <div
        ref={scrollRef}
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '14px 14px 24px',
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
        }}
      >
        {posts.length === 0 ? (
          <div style={{ fontSize: 11.5, color: muted(0.4), textAlign: 'center', marginTop: 24 }}>
            {loaded ? 'No peer messages yet. Teammates post here as they coordinate.' : 'Loading…'}
          </div>
        ) : (
          posts.map((p) => <PeerPost key={p.id} post={p} authorName={nameFor(p.authorAgentId)} />)
        )}
      </div>
    </Modal>
  )
}
