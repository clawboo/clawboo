// Edge type map — module-level for referential stability across renders.
import type { EdgeTypes } from '@xyflow/react'
import { MemoryEdge } from './MemoryEdge'

export const memoryEdgeTypes: EdgeTypes = {
  memory: MemoryEdge,
}
