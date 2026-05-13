// GroupChatViewHeader — single unified header above the graph + chat split.
// Owns the team identity (icon + name + Boo/skill counts). Boo/skill counts
// were folded into this subtitle to eliminate the redundant "Ghost Graph
// [N Boos · M skills]" subheader row that used to sit between this header
// and the canvas. The user already knows they're looking at a chat-with-
// graph view; the "Ghost Graph" label was noise. Re-layout migrated to the
// canvas's floating toolbar (alongside Team halos + Connect).
//
// The previous `agentCount` prop was dropped — Boo count is more informative
// (includes Boo Zero, matching what the user actually sees on the graph) and
// is sourced from the graph store directly so it stays in sync with the
// canvas without GroupChatView having to plumb it through.

import { useGraphStore } from '@/features/graph/store'
import type { Team } from '@/stores/team'

interface GroupChatViewHeaderProps {
  team: Team | null
}

export function GroupChatViewHeader({ team }: GroupChatViewHeaderProps) {
  // Two separate primitive selectors so we don't need shallow equality —
  // each returns a number and React's default reference check works.
  const booCount = useGraphStore((s) => s.nodes.filter((n) => n.type === 'boo').length)
  const skillCount = useGraphStore((s) => s.nodes.filter((n) => n.type === 'skill').length)

  // Don't flash "0 Boos · 0 skills" before the graph hydrates — render an
  // ellipsis placeholder until the structural rebuild lands its first node.
  const hasGraph = booCount > 0
  return (
    <div className="flex shrink-0 items-center gap-3 border-b border-white/8 px-4 py-3">
      {team && (
        <span
          className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-lg text-[16px]"
          style={{ background: `${team.color}22` }}
        >
          {team.icon}
        </span>
      )}
      <div className="min-w-0 flex-1">
        <h2
          className="truncate text-[14px] font-semibold text-text"
          style={{ fontFamily: 'var(--font-body)' }}
        >
          {team?.name ?? 'Group Chat'}
        </h2>
        {/* Accent-red pill badge — same style as the old Ghost Graph
            toolbar badge, so the boo/skill count keeps the same visual
            prominence after being folded into the team header. While the
            graph hydrates we render a dimmer placeholder pill instead of
            "0 Boos · 0 skills" flashing in. */}
        <div className="mt-1.5 flex">
          {hasGraph ? (
            <span
              style={{
                fontSize: 11,
                fontWeight: 500,
                color: '#E94560',
                background: 'rgba(233,69,96,0.12)',
                borderRadius: 20,
                padding: '2px 10px',
                lineHeight: '16px',
              }}
            >
              {booCount} Boo{booCount !== 1 ? 's' : ''}
              {skillCount > 0 && ` · ${skillCount} skill${skillCount !== 1 ? 's' : ''}`}
            </span>
          ) : (
            <span
              style={{
                fontSize: 11,
                fontWeight: 500,
                color: 'rgba(232,232,232,0.35)',
                background: 'rgba(255,255,255,0.04)',
                borderRadius: 20,
                padding: '2px 10px',
                lineHeight: '16px',
              }}
            >
              …
            </span>
          )}
        </div>
      </div>
    </div>
  )
}
