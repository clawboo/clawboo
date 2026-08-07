// MentionDropdown — the @mention autocomplete list under the message composer.
//
// One component for both composer surfaces: group chat (`@agent` targets a team
// member) and Boo Zero chat (`@team` targets a whole team). `MessageComposer`
// owns the query, the filtered candidates and the keyboard cursor; this renders
// them and reports selection.
//
// It sits beside `MessageComposer`, its only consumer, rather than in a feature
// folder — the earlier copy lived under `features/group-chat/` and was never
// imported, while the composer carried a private duplicate to avoid importing
// across features. The two had already drifted (only the copy grew team
// candidates). One component, one import direction.

import { memo, useEffect, useRef } from 'react'

import { AgentBooAvatar } from '@/components/AgentBooAvatar'
import { useDismissableLayer } from '@/features/shared/useDismissableLayer'

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

export interface MentionDropdownProps {
  /** Already filtered to the current query, in display order. */
  agents: MentionCandidate[]
  /** Index of the keyboard-highlighted row. */
  selectedIndex: number
  onSelect: (agentName: string) => void
  onClose: () => void
}

export const MentionDropdown = memo(function MentionDropdown({
  agents,
  selectedIndex,
  onSelect,
  onClose,
}: MentionDropdownProps) {
  const selectedRef = useRef<HTMLButtonElement>(null)

  // Keep the keyboard-highlighted row visible in the scroll container.
  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  // Press-outside closes the list through the shared dismissable-layer stack, so
  // a press landing on a surrounding overlay's scrim dismisses THIS list and
  // nothing else. No `onEscape`: the composer's textarea handler owns Escape and
  // vetoes the stack with preventDefault().
  const listRef = useRef<HTMLDivElement>(null)
  useDismissableLayer({
    active: true,
    level: 'popover',
    contains: (t) => !!listRef.current?.contains(t),
    onPressOutside: onClose,
  })

  return (
    <div
      ref={listRef}
      data-testid="mention-dropdown"
      role="listbox"
      aria-label="Mention suggestions"
      className="absolute bottom-full left-0 z-50 mb-1.5 max-h-[200px] min-w-[190px] overflow-y-auto rounded-xl border border-border bg-popover py-1.5"
      style={{ boxShadow: 'var(--shadow-floating)' }}
    >
      {agents.map((agent, i) => (
        <button
          key={agent.id}
          ref={i === selectedIndex ? selectedRef : undefined}
          type="button"
          role="option"
          aria-selected={i === selectedIndex}
          // preventDefault on mousedown keeps the textarea focused so the caret
          // stays put; selection itself hangs off `click`, which is what keyboard
          // and assistive-technology activation dispatches (mousedown alone would
          // leave a focused option inert).
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onSelect(agent.name)}
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
