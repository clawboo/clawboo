// TeamSpaceSplit — the settled "team space": Ghost Graph on top, group chat on
// bottom, in a vertical resizable split. When `animateOpen` is true (the user
// just finished onboarding and clicked "Continue to Team Space"), the graph
// "opens" down from the top via a clip-path reveal while the chat sits below.
//
// Why a clip-path reveal and NOT an animated panel resize: the Ghost Graph's
// layout is ASPECT-SENSITIVE (`stretchToAspect` in `useGraphLayout` stretches
// the ELK result to match the container's width/height ratio). Animating the
// graph panel's HEIGHT changes that ratio every frame, so react-flow lays out
// against a wide-and-short mid-animation container and the Boos end up shrunk
// (the layout never re-runs at the final aspect — the debounced refit only
// re-frames the camera). A clip-path reveal keeps the panel at its final 45/55
// size the whole time, so react-flow lays out ONCE at the correct aspect (full-
// size Boos) and the reveal is purely visual — it never touches the measured
// container box. Returning users (already onboarded) get `animateOpen` false and
// land on the split instantly with no reveal.

import { motion } from 'framer-motion'
import { Group, Panel } from 'react-resizable-panels'
import { ResizeHandle } from '@/features/shared/ResizeHandle'
import { GhostGraphPanel } from '@/features/graph/GhostGraphPanel'
import { GroupChatPanel } from './GroupChatPanel'

interface TeamSpaceSplitProps {
  teamId: string
  /** When true, play the graph "open" reveal on mount. */
  animateOpen: boolean
}

export function TeamSpaceSplit({ teamId, animateOpen }: TeamSpaceSplitProps) {
  return (
    <Group orientation="vertical" id="group-chat-v" data-testid="group-chat-view">
      <Panel id="graph" defaultSize={45} minSize={20}>
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
            <GhostGraphPanel embedded />
          </motion.div>
        ) : (
          <GhostGraphPanel embedded />
        )}
      </Panel>
      <ResizeHandle direction="vertical" />
      <Panel id="chat" defaultSize={55} minSize={20}>
        <GroupChatPanel teamId={teamId} embedded />
      </Panel>
    </Group>
  )
}
