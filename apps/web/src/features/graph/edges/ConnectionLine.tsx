import { getSmoothStepPath, getBezierPath } from '@xyflow/react'
import type { ConnectionLineComponentProps } from '@xyflow/react'

// Color the in-progress connection line based on source node type:
//   boo   → accent red (var(--primary)) — boo-to-boo routing
//   skill → mint (var(--mint)) — skill install
const NODE_TYPE_COLOR: Record<string, string> = {
  boo: 'var(--primary)',
  skill: 'var(--mint)',
  // Grant-share drags start on a connector tile; the thread matches its violet.
  resource: 'var(--violet)',
}

/**
 * The colour the FINISHED edge will take, so the preview is a promise rather than
 * a guess.
 *
 * A skill or connector tile carries its own accent (slate for the built-ins rollup,
 * amber for leadership, a provider hue for the model), and the landed edge takes
 * that accent. Colouring the preview by node TYPE meant dragging from a slate tile
 * previewed mint and then settled grey, so the line changed colour the instant you
 * let go.
 */
function previewColor(fromNode: ConnectionLineComponentProps['fromNode']): string {
  const accent = (fromNode?.data as { accent?: unknown } | undefined)?.accent
  if (typeof accent === 'string' && accent) return accent
  return NODE_TYPE_COLOR[fromNode?.type ?? ''] ?? 'rgb(var(--foreground-rgb) / 0.5)'
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

  const color = previewColor(fromNode)

  return (
    <g>
      <path d={path} fill="none" stroke={color} strokeWidth={2} strokeDasharray="6 4" />
    </g>
  )
}
