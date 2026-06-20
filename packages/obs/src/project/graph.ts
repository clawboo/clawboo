// Graph-over-event-log: the live team graph is a PROJECTION of the append-only
// event stream (the Rowboat "rebuild state by replaying the log" pattern), so the
// surface can't drift from reality — replaying the same log always reproduces the
// same graph. Two views fold from one ordered event list:
//   • projectGraph    → the task-delegation graph (task nodes + delegation/dep
//                        edges + per-task status/cost) AND the derived agent graph
//                        (agent nodes + agent→agent delegation edges + per-agent cost)
//   • projectFleetHealth → the Gastown triage taxonomy (working/idle/stalled/zombie),
//                        time-sensitive (takes `now`), for the fleet-health view.
// Pure + deterministic given seq-ordered input (the DB returns events `seq ASC`).

import type {
  CostData,
  DepLinkedData,
  ExecutionCompletedData,
  ExecutionStartedData,
  OrchestrationEvent,
  StatusChangedData,
  TaskClaimedData,
  TaskCreatedData,
} from '../events/schema'

export interface ProjectedTaskNode {
  id: string
  title: string | null
  status: string
  assigneeAgentId: string | null
  parentTaskId: string | null
  runtime: string | null
  teamId: string | null
  costUsd: number
}

export interface ProjectedAgentNode {
  id: string
  costUsd: number
  taskIds: string[]
}

export interface ProjectedEdge {
  id: string
  source: string
  target: string
  kind: 'delegation' | 'dependency'
}

export interface ProjectedGraph {
  tasks: ProjectedTaskNode[]
  taskEdges: ProjectedEdge[]
  agents: ProjectedAgentNode[]
  /** Agent→agent delegation, derived from parent-task assignees. */
  agentEdges: ProjectedEdge[]
}

function dataOf<T>(ev: OrchestrationEvent): T {
  return (ev.data ?? {}) as T
}

/** Fold an ordered event list into the task + agent delegation graph. */
export function projectGraph(events: readonly OrchestrationEvent[]): ProjectedGraph {
  const tasks = new Map<string, ProjectedTaskNode>()
  const taskEdgeKeys = new Set<string>()
  const taskEdges: ProjectedEdge[] = []
  const agentCost = new Map<string, number>()
  const agentTasks = new Map<string, Set<string>>()

  const ensureTask = (id: string): ProjectedTaskNode => {
    let t = tasks.get(id)
    if (!t) {
      t = {
        id,
        title: null,
        status: 'unknown',
        assigneeAgentId: null,
        parentTaskId: null,
        runtime: null,
        teamId: null,
        costUsd: 0,
      }
      tasks.set(id, t)
    }
    return t
  }
  const addTaskEdge = (source: string, target: string, kind: ProjectedEdge['kind']): void => {
    const key = `${kind}:${source}->${target}`
    if (taskEdgeKeys.has(key)) return
    taskEdgeKeys.add(key)
    taskEdges.push({ id: key, source, target, kind })
  }
  const noteAgentTask = (agentId: string, taskId: string): void => {
    let s = agentTasks.get(agentId)
    if (!s) {
      s = new Set()
      agentTasks.set(agentId, s)
    }
    s.add(taskId)
  }

  for (const ev of events) {
    const taskId = ev.taskId ?? undefined
    switch (ev.kind) {
      case 'task_created': {
        if (!taskId) break
        const d = dataOf<TaskCreatedData>(ev)
        const t = ensureTask(taskId)
        t.title = d.title ?? t.title
        t.status = d.status ?? (t.status === 'unknown' ? 'todo' : t.status)
        t.teamId = ev.teamId ?? t.teamId
        if (d.parentTaskId) {
          t.parentTaskId = d.parentTaskId
          addTaskEdge(d.parentTaskId, taskId, 'delegation')
        }
        break
      }
      case 'task_claimed': {
        if (!taskId) break
        const d = dataOf<TaskClaimedData>(ev)
        const t = ensureTask(taskId)
        t.assigneeAgentId = d.assigneeAgentId ?? ev.agentId ?? t.assigneeAgentId
        t.runtime = d.assigneeRuntime ?? ev.runtime ?? t.runtime
        if (t.status === 'todo' || t.status === 'unknown' || t.status === 'backlog')
          t.status = 'in_progress'
        if (t.assigneeAgentId) noteAgentTask(t.assigneeAgentId, taskId)
        break
      }
      case 'status_changed': {
        if (!taskId) break
        const d = dataOf<StatusChangedData>(ev)
        if (d.to) ensureTask(taskId).status = d.to
        break
      }
      case 'dep_linked': {
        if (!taskId) break
        const d = dataOf<DepLinkedData>(ev)
        if (d.dependsOnTaskId) {
          ensureTask(taskId)
          ensureTask(d.dependsOnTaskId)
          addTaskEdge(d.dependsOnTaskId, taskId, 'dependency')
        }
        break
      }
      case 'execution_started': {
        if (!taskId) break
        const d = dataOf<ExecutionStartedData>(ev)
        const t = ensureTask(taskId)
        if (d.executorType) t.runtime = d.executorType
        if (ev.agentId) noteAgentTask(ev.agentId, taskId)
        break
      }
      case 'cost': {
        const d = dataOf<CostData>(ev)
        const c = d.costUsd ?? 0
        if (taskId) ensureTask(taskId).costUsd += c
        if (ev.agentId) agentCost.set(ev.agentId, (agentCost.get(ev.agentId) ?? 0) + c)
        break
      }
      case 'execution_completed': {
        if (!taskId) break
        const d = dataOf<ExecutionCompletedData>(ev)
        const t = ensureTask(taskId)
        if (typeof d.costUsd === 'number') {
          // execution cost is authoritative for the run; only add if cost events
          // didn't already account for it (avoid double counting by preferring the
          // larger of the two — cost events are incremental, the exec total is final).
          if (d.costUsd > t.costUsd) {
            const delta = d.costUsd - t.costUsd
            t.costUsd = d.costUsd
            if (ev.agentId) agentCost.set(ev.agentId, (agentCost.get(ev.agentId) ?? 0) + delta)
          }
        }
        break
      }
      default:
        break
    }
  }

  // Derive agent→agent delegation edges from parent-task assignees.
  const agentEdgeKeys = new Set<string>()
  const agentEdges: ProjectedEdge[] = []
  for (const t of tasks.values()) {
    if (!t.parentTaskId || !t.assigneeAgentId) continue
    const parent = tasks.get(t.parentTaskId)
    const from = parent?.assigneeAgentId
    if (!from || from === t.assigneeAgentId) continue
    const key = `delegation:${from}->${t.assigneeAgentId}`
    if (agentEdgeKeys.has(key)) continue
    agentEdgeKeys.add(key)
    agentEdges.push({ id: key, source: from, target: t.assigneeAgentId, kind: 'delegation' })
  }

  const agentIds = new Set<string>([...agentTasks.keys(), ...agentCost.keys()])
  const agents: ProjectedAgentNode[] = [...agentIds].map((id) => ({
    id,
    costUsd: agentCost.get(id) ?? 0,
    taskIds: [...(agentTasks.get(id) ?? [])],
  }))

  return { tasks: [...tasks.values()], taskEdges, agents, agentEdges }
}

// ── Fleet health (Gastown triage taxonomy) ──────────────────────────────────

export type AgentHealthStatus = 'working' | 'idle' | 'stalled' | 'zombie'

export interface AgentHealth {
  status: AgentHealthStatus
  lastEventTs: number
  activeTaskId: string | null
  openExecutions: number
  costUsd: number
}

export interface FleetHealthOptions {
  /** No event for this long while an execution is open ⇒ stalled. Default 5 min. */
  stallMs?: number
  /** No event for this long while an execution is open ⇒ zombie (process likely dead). Default 30 min. */
  zombieMs?: number
}

const DEFAULT_STALL_MS = 5 * 60_000
const DEFAULT_ZOMBIE_MS = 30 * 60_000

/**
 * Per-agent triage state. An agent with an OPEN execution (started, not completed)
 * is `working` if a recent event landed, `stalled` if quiet past `stallMs`, and
 * `zombie` if quiet past `zombieMs` (the process is almost certainly dead — what
 * orphan reconciliation will reap). An agent with no open execution is `idle`.
 */
export function projectFleetHealth(
  events: readonly OrchestrationEvent[],
  now: number,
  opts: FleetHealthOptions = {},
): Map<string, AgentHealth> {
  const stallMs = opts.stallMs ?? DEFAULT_STALL_MS
  const zombieMs = opts.zombieMs ?? DEFAULT_ZOMBIE_MS

  interface Acc {
    lastEventTs: number
    open: number
    activeTaskId: string | null
    costUsd: number
  }
  const acc = new Map<string, Acc>()
  const ensure = (id: string): Acc => {
    let a = acc.get(id)
    if (!a) {
      a = { lastEventTs: 0, open: 0, activeTaskId: null, costUsd: 0 }
      acc.set(id, a)
    }
    return a
  }

  for (const ev of events) {
    const agentId = ev.agentId
    if (!agentId) continue
    const a = ensure(agentId)
    if (ev.ts > a.lastEventTs) a.lastEventTs = ev.ts
    if (ev.kind === 'execution_started') {
      a.open += 1
      a.activeTaskId = ev.taskId ?? a.activeTaskId
    } else if (ev.kind === 'execution_completed') {
      a.open = Math.max(0, a.open - 1)
      if (a.open === 0) a.activeTaskId = null
    } else if (ev.kind === 'cost') {
      const d = dataOf<CostData>(ev)
      a.costUsd += d.costUsd ?? 0
    }
  }

  const out = new Map<string, AgentHealth>()
  for (const [id, a] of acc) {
    let status: AgentHealthStatus
    if (a.open <= 0) {
      status = 'idle'
    } else {
      const quiet = now - a.lastEventTs
      status = quiet >= zombieMs ? 'zombie' : quiet >= stallMs ? 'stalled' : 'working'
    }
    out.set(id, {
      status,
      lastEventTs: a.lastEventTs,
      activeTaskId: a.activeTaskId,
      openExecutions: a.open,
      costUsd: a.costUsd,
    })
  }
  return out
}
