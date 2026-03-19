// GroupChatView — 2-panel resizable layout: GroupChatPanel + GhostGraphPanel.

import { Group, Panel } from 'react-resizable-panels'
import { ResizeHandle } from '@/features/shared/ResizeHandle'
import { GroupChatPanel } from './GroupChatPanel'
import { GhostGraphPanel } from '@/features/graph/GhostGraphPanel'

export function GroupChatView({ teamId }: { teamId: string }) {
  return (
    <Group orientation="horizontal" id="group-chat-h" data-testid="group-chat-view">
      <Panel defaultSize={50} minSize={25}>
        <GroupChatPanel teamId={teamId} />
      </Panel>
      <ResizeHandle direction="horizontal" />
      <Panel defaultSize={50} minSize={25}>
        <GhostGraphPanel />
      </Panel>
    </Group>
  )
}
