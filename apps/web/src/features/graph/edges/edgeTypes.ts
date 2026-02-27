// Edge type map — module-level for referential stability across renders.
import type { EdgeTypes } from '@xyflow/react'
import { SkillEdge } from './SkillEdge'
import { DependencyEdge } from './DependencyEdge'
import { ResourceEdge } from './ResourceEdge'

export const edgeTypes: EdgeTypes = {
  skill: SkillEdge,
  dependency: DependencyEdge,
  resource: ResourceEdge,
}
