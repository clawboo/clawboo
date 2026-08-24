// Edge type map — module-level for referential stability across renders.
import type { EdgeTypes } from '@xyflow/react'
import { SkillEdge } from './SkillEdge'
import { DependencyEdge } from './DependencyEdge'
import { ResourceEdge } from './ResourceEdge'
import { GrantEdge } from './GrantEdge'

export const edgeTypes: EdgeTypes = {
  skill: SkillEdge,
  dependency: DependencyEdge,
  resource: ResourceEdge,
  grant: GrantEdge,
}
