// Node type map — module-level so the reference is stable across renders
// (React Flow remounts nodes if nodeTypes is a new object on every render).
import type { NodeTypes } from '@xyflow/react'
import { MemoryFactNode } from './MemoryFactNode'
import { MemoryProcedureNode } from './MemoryProcedureNode'

export const memoryNodeTypes: NodeTypes = {
  memFact: MemoryFactNode,
  memProc: MemoryProcedureNode,
}
