import { getSmoothStepPath, getBezierPath } from '@xyflow/react'
import type { ConnectionLineComponentProps } from '@xyflow/react'

// Color the in-progress connection line based on source node type:
//   boo   → accent red (var(--primary)) — boo-to-boo routing
//   skill → mint (var(--mint)) — skill install
const NODE_TYPE_COLOR: Record<string, string> = {
  boo: 'var(--primary)',
  skill: 'var(--mint)',
}

export function ConnectionLine({
  fromX,
  fromY,
  toX,
  toY,
  fromPosition,
  toPosition,
  fromNode,
}: ConnectionLineComponentProps) {
  // Boo→Boo connections use smooth-step (stepped routing) to match DependencyEdge.
  // Skill→Boo connections use bezier (organic curves) to match SkillEdge.
  const useSmoothStep = fromNode?.type === 'boo'

  const [path] = useSmoothStep
    ? getSmoothStepPath({
        sourceX: fromX,
        sourceY: fromY,
        targetX: toX,
        targetY: toY,
        sourcePosition: fromPosition,
        targetPosition: toPosition,
        borderRadius: 10,
      })
    : getBezierPath({
        sourceX: fromX,
        sourceY: fromY,
        targetX: toX,
        targetY: toY,
        sourcePosition: fromPosition,
        targetPosition: toPosition,
      })

  const color = NODE_TYPE_COLOR[fromNode?.type ?? ''] ?? 'rgb(var(--foreground-rgb) / 0.5)'

  return (
    <g>
      <path d={path} fill="none" stroke={color} strokeWidth={2} strokeDasharray="6 4" />
    </g>
  )
}
