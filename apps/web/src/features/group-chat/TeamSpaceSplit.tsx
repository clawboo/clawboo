// TeamSpaceSplit: the settled "team space", with the group chat on the left (with
// the team header, whose right edge holds the card toggles) and floating cards
// stacked on the right: the Ghost Graph, the team's Tasks and its Activity. Every split
// is resizable. With both cards closed the chat takes the whole area. When `animateOpen` is true (the
// user just finished onboarding and clicked "Continue to Team Space"), the
// graph "opens" down from the top of its card via a clip-path reveal.
//
// Why a clip-path reveal and NOT an animated panel resize: the Ghost Graph's
// layout is ASPECT-SENSITIVE (`stretchToAspect` in `useGraphLayout` stretches
// the ELK result to match the container's width/height ratio). Animating the
// graph panel's HEIGHT changes that ratio every frame, so react-flow lays out
// against a wide-and-short mid-animation container and the Boos end up shrunk
// (the layout never re-runs at the final aspect — the debounced refit only
// re-frames the camera). A clip-path reveal keeps the panel at its final
// size the whole time, so react-flow lays out ONCE at the correct aspect (full-
// size Boos) and the reveal is purely visual — it never touches the measured
// container box. Returning users (already onboarded) get `animateOpen` false and
// land on the split instantly with no reveal.

import { Fragment, useMemo, useState, type ReactNode } from 'react'
import { motion } from 'framer-motion'
import { Group, Panel, useDefaultLayout } from 'react-resizable-panels'
import { Globe, ListChecks, Network, Terminal } from 'lucide-react'
import { ResizeHandle } from '@/features/shared/ResizeHandle'
import {
  CARD_PANEL_STYLE,
  CardWindowButtons,
  FloatingCard,
  PaneToggle,
} from '@/features/shared/FloatingCard'
import { GhostGraphPanel } from '@/features/graph/GhostGraphPanel'
import { ActivityTerminal } from '@/features/obs/ActivityTerminal'
import {
  safeLayoutStorage,
  usePaneOpen,
  usePanelLayoutStore,
  type PaneKey,
} from '@/stores/panelLayout'
import type { Team } from '@/stores/team'
import { useRoom } from '@/stores/rooms'
import { GroupChatPanel } from './GroupChatPanel'
import { GroupChatViewHeader, TeamGraphCountPill } from './GroupChatViewHeader'
import { TeamBrowser } from './TeamBrowser'
import { TeamTasksCard } from './TeamTasksCard'

// Pixels (react-resizable-panels v4 reads numbers as px): wide enough that the
// team header (name, Brief & Rules, graph toggle, Star) never clips.
const CHAT_MIN_PX = 400

interface TeamSpaceSplitProps {
  teamId: string
  /** One of the team's chat rooms; null = the team's own group chat. */
  roomId: string | null
  team: Team | null
  /** When true, play the graph "open" reveal on mount. */
  animateOpen: boolean
}

type TeamCard = 'browser' | 'graph' | 'tasks' | 'activity'

/** Top to bottom, the order the cards stack in. The browser sits above the
 *  graph: a landscape screen wants the card's full width. */
const CARD_ORDER: readonly TeamCard[] = ['browser', 'graph', 'tasks', 'activity']

const PANE_OF: Record<TeamCard, PaneKey> = {
  browser: 'team:browser',
  graph: 'team:graph',
  tasks: 'team:tasks',
  activity: 'team:activity',
}

export function TeamSpaceSplit({ teamId, roomId, team, animateOpen }: TeamSpaceSplitProps) {
  const room = useRoom(teamId, roomId)
  // A room's graph card draws only the room's members (and Boo Zero).
  const roomMemberKey = room ? room.memberIds.join(',') : ''
  const graphRoom = useMemo(
    () =>
      roomId ? { id: roomId, memberIds: roomMemberKey ? roomMemberKey.split(',') : [] } : null,
    [roomId, roomMemberKey],
  )
  const graphOpen = usePaneOpen('team:graph')
  const tasksOpen = usePaneOpen('team:tasks')
  const activityOpen = usePaneOpen('team:activity')
  const browserOpen = usePaneOpen('team:browser')
  const isOpen: Record<TeamCard, boolean> = {
    browser: browserOpen,
    graph: graphOpen,
    tasks: tasksOpen,
    activity: activityOpen,
  }
  const openCards = CARD_ORDER.filter((c) => isOpen[c])
  const anyCard = openCards.length > 0
  const [maximized, setMaximized] = useState<TeamCard | null>(null)
  // A maximized card that gets closed must not leave the view stuck maximized.
  const shownMaximized = maximized && isOpen[maximized] ? maximized : null
  const hPanelIds = useMemo(() => (anyCard ? ['chat', 'cards'] : ['chat']), [anyCard])
  const openKey = openCards.join(',')
  const vPanelIds = useMemo(() => (openKey ? openKey.split(',') : []), [openKey])
  const hLayout = useDefaultLayout({
    id: 'team-space-h',
    panelIds: hPanelIds,
    storage: safeLayoutStorage,
  })
  const vLayout = useDefaultLayout({
    id: 'team-space-v',
    panelIds: vPanelIds,
    storage: safeLayoutStorage,
  })
  const toggleMax = (card: TeamCard) => setMaximized((m) => (m === card ? null : card))
  const closeCard = (card: TeamCard) => {
    setMaximized(null)
    usePanelLayoutStore.getState().setPaneOpen(PANE_OF[card], false)
  }

  const graphCard = (
    <FloatingCard
      title={roomId ? 'Room graph' : 'Team graph'}
      icon={Network}
      testId="team-card-graph"
      actions={<TeamGraphCountPill teamId={teamId} />}
      maximized={shownMaximized === 'graph'}
      onToggleMaximize={() => toggleMax('graph')}
      onClose={() => closeCard('graph')}
    >
      {animateOpen ? (
        // Reveal top→down via clip-path inset (the bottom inset shrinks from
        // 100% to 0). Pure visual wipe — the element keeps its full size, so
        // react-flow's fitView/aspect math is unaffected and the Boos render
        // at their correct size from the first frame.
        <motion.div
          className="h-full"
          initial={{ clipPath: 'inset(0 0 100% 0)', opacity: 0.5 }}
          animate={{ clipPath: 'inset(0 0 0% 0)', opacity: 1 }}
          transition={{ duration: 0.55, ease: [0.22, 0.61, 0.36, 1] }}
        >
          <GhostGraphPanel embedded room={graphRoom} />
        </motion.div>
      ) : (
        <GhostGraphPanel embedded room={graphRoom} />
      )}
    </FloatingCard>
  )
  const tasksCard = (
    <TeamTasksCard
      teamId={teamId}
      roomId={roomId}
      maximized={shownMaximized === 'tasks'}
      onToggleMaximize={() => toggleMax('tasks')}
      onClose={() => closeCard('tasks')}
    />
  )

  // Everything this team's agents are doing, live: their tool calls, results
  // and errors. Team-wide, like the board.
  const activityCard = (
    <FloatingCard
      title="Activity"
      icon={Terminal}
      testId="team-card-activity"
      maximized={shownMaximized === 'activity'}
      onToggleMaximize={() => toggleMax('activity')}
      onClose={() => closeCard('activity')}
    >
      <ActivityTerminal scope={{ teamId }} fill hideHeader />
    </FloatingCard>
  )
  // The page each of this chat's agents has open in its browser: a window of
  // its own (TeamBrowser draws it), sized to the browser's shape.
  const browserCard = (
    <div className="h-full" data-testid="team-card-browser">
      <TeamBrowser
        teamId={teamId}
        memberIds={graphRoom ? graphRoom.memberIds : null}
        windowActions={
          <CardWindowButtons
            title="Browser"
            maximized={shownMaximized === 'browser'}
            onToggleMaximize={() => toggleMax('browser')}
            onClose={() => closeCard('browser')}
          />
        }
      />
    </div>
  )
  const cardOf: Record<TeamCard, ReactNode> = {
    browser: browserCard,
    graph: graphCard,
    tasks: tasksCard,
    activity: activityCard,
  }
  const sizeOf: Record<TeamCard, string> = {
    browser: '50',
    graph: '55',
    tasks: '45',
    activity: '40',
  }

  if (shownMaximized) {
    return <div className="h-full bg-background p-2">{cardOf[shownMaximized]}</div>
  }

  return (
    <Group
      orientation="horizontal"
      id="team-space-h"
      data-testid="group-chat-view"
      className="bg-background"
      defaultLayout={hLayout.defaultLayout}
      onLayoutChanged={hLayout.onLayoutChanged}
    >
      <Panel id="chat" minSize={CHAT_MIN_PX}>
        <div className="flex h-full flex-col">
          {/* The team header belongs to the chat, so with the cards closed it
              spans the full width and the toggles ride along to the right edge. */}
          <GroupChatViewHeader
            team={team}
            room={room}
            showCounts={false}
            trailing={
              <span className="flex items-center gap-1">
                <PaneToggle
                  icon={Network}
                  label={roomId ? 'room graph' : 'team graph'}
                  open={graphOpen}
                  onClick={() => usePanelLayoutStore.getState().togglePane('team:graph')}
                  testId="pane-toggle-team-graph"
                />
                <PaneToggle
                  icon={ListChecks}
                  label="tasks"
                  open={tasksOpen}
                  onClick={() => usePanelLayoutStore.getState().togglePane('team:tasks')}
                  testId="pane-toggle-team-tasks"
                />
                <PaneToggle
                  icon={Globe}
                  label="browser"
                  open={browserOpen}
                  onClick={() => usePanelLayoutStore.getState().togglePane('team:browser')}
                  testId="pane-toggle-team-browser"
                />
                <PaneToggle
                  icon={Terminal}
                  label="activity"
                  open={activityOpen}
                  onClick={() => usePanelLayoutStore.getState().togglePane('team:activity')}
                  testId="pane-toggle-team-activity"
                />
              </span>
            }
          />
          <div className="min-h-0 flex-1">
            <GroupChatPanel teamId={teamId} roomId={roomId} embedded />
          </div>
        </div>
      </Panel>
      {anyCard && (
        <>
          <ResizeHandle direction="horizontal" variant="gap" />
          <Panel id="cards" defaultSize="48" minSize="22" style={CARD_PANEL_STYLE}>
            <div className="h-full py-2 pr-2">
              <Group
                orientation="vertical"
                id="team-space-v"
                style={CARD_PANEL_STYLE}
                defaultLayout={vLayout.defaultLayout}
                onLayoutChanged={vLayout.onLayoutChanged}
              >
                {openCards.map((card, i) => (
                  <Fragment key={card}>
                    {i > 0 && <ResizeHandle direction="vertical" variant="gap" />}
                    <Panel
                      id={card}
                      defaultSize={sizeOf[card]}
                      minSize="20"
                      style={CARD_PANEL_STYLE}
                    >
                      {cardOf[card]}
                    </Panel>
                  </Fragment>
                ))}
              </Group>
            </div>
          </Panel>
        </>
      )}
    </Group>
  )
}
