// Node type map — defined at module level so the reference is stable across renders
// (React Flow remounts nodes if nodeTypes is a new object on every render).
import type { NodeTypes } from '@xyflow/react'
import { BooNode } from './BooNode'
import { SkillNode } from './SkillNode'
import { ResourceNode } from './ResourceNode'
import { TeamRootNode } from './TeamRootNode'

export const nodeTypes: NodeTypes = {
  boo: BooNode,
  skill: SkillNode,
  resource: ResourceNode,
  'team-root': TeamRootNode,
}
