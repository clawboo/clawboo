import { useMemo } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { CheckCircle2, RotateCcw, ShieldAlert } from 'lucide-react'
import { delegationTargetOf } from '@clawboo/board-core'

import { AgentBooAvatar } from '@/components/AgentBooAvatar'
import { InlineApprovalCard } from '@/features/approvals/InlineApprovalCard'
import { ToolApprovalCard } from '@/features/approvals/ToolApprovalCard'
import { usePendingApprovals, type ToolApproval } from '@/features/approvals/usePendingApprovals'
import { Button } from '@/features/shared/Button'
import { StatusPill } from '@/features/shared/StatusPill'
import type { BoardTask } from '@/lib/boardClient'
import { ENTER_SPRING, listDelay } from '@/lib/motion'
import type { ApprovalRequest } from '@/stores/approvals'
import { useFleetStore } from '@/stores/fleet'
import { useTeamStore } from '@/stores/team'

import { AssignAgentSelect } from './AssignAgentSelect'
import { ATTENTION_META, attentionLabel, taskAttentionOf, type TaskAttention } from './boardStatus'
import { useTaskActions } from './useTaskActions'

// ─── NeedsYouColumn ────────────────────────────────────────────────────────
// The Board's first column: everything that is waiting on a PERSON to move.
//   • Approvals: an agent wants to run a command, call a risky tool, or make a
//     risky delegation (OpenClaw exec + MCP tool/delegation approvals).
//   • Tasks nothing will move by themselves: a run that failed or timed out, one
//     the user stopped, one verification could not pass, one an agent marked
//     blocked, and one no agent is bound to. Each carries a badge naming why,
//     and the action that gets it going again.
//
// Always expanded, like every other column: an empty "Needs you" is good news
// worth seeing, not something to fold away.

const SECTION_LABEL =
  'font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground'
const GROUP_LABEL =
  'flex items-center gap-1.5 px-1 font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-foreground/45'

type ApprovalItem =
  | { key: string; ts: number; kind: 'exec'; exec: ApprovalRequest }
  | { key: string; ts: number; kind: 'tool'; tool: ToolApproval }

/** Which agent a stuck task belongs to: the one working it, else the one it is
 *  bound to (a released task keeps its binding but loses its assignee). */
function agentOf(task: BoardTask): string | null {
  const assignee = typeof task.assigneeAgentId === 'string' ? task.assigneeAgentId : null
  const sdid = typeof task['sourceDelegationId'] === 'string' ? task['sourceDelegationId'] : null
  return assignee ?? delegationTargetOf(sdid)
}

function NeedsYouTaskCard({
  task,
  attention,
  showTeam,
  onOpen,
  onChanged,
}: {
  task: BoardTask
  attention: TaskAttention
  showTeam: boolean
  onOpen: () => void
  onChanged: () => void
}) {
  const { retry, dismiss } = useTaskActions()
  const agentId = agentOf(task)
  const agentName = useFleetStore((s) =>
    agentId ? (s.agents.find((a) => a.id === agentId)?.name ?? null) : null,
  )
  const teamName = useTeamStore((s) =>
    showTeam && task.teamId ? (s.teams.find((t) => t.id === task.teamId)?.name ?? null) : null,
  )
  const meta = ATTENTION_META[attention.reason]
  const teamId = typeof task.teamId === 'string' ? task.teamId : null
  const bound = delegationTargetOf(
    typeof task['sourceDelegationId'] === 'string' ? task['sourceDelegationId'] : null,
  )
  const unassigned = attention.reason === 'unassigned'
  // Retry needs somebody to hand the task back to; a task nobody is bound to
  // needs a person to pick who, so it offers the team's agents instead.
  const canRetry = !unassigned && !!teamId && !!bound
  const canAssign = !!teamId && !bound

  return (
    <div
      data-testid="needs-you-task"
      data-attention={attention.reason}
      className="rounded-2xl border border-border bg-surface p-3.5"
      style={{ boxShadow: 'var(--shadow-raised)' }}
    >
      <button
        type="button"
        onClick={onOpen}
        data-focus-restore-id={task.id}
        className="block w-full cursor-pointer text-left"
        aria-label={`Open “${task.title ?? 'task'}”`}
      >
        <div className="flex items-start justify-between gap-2">
          <span
            className="text-[13px] font-semibold text-foreground"
            style={{ lineHeight: 1.35, letterSpacing: '-0.01em' }}
          >
            {task.title ?? '(untitled)'}
          </span>
          <StatusPill
            tone={meta.tone}
            label={attentionLabel(attention)}
            className="shrink-0 whitespace-nowrap"
          />
        </div>
        <div className="mt-2 flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
          {agentId && <AgentBooAvatar agentId={agentId} size={16} />}
          <span className="truncate">
            {agentName ?? (unassigned ? 'No agent' : 'Unknown agent')}
            {teamName ? ` · ${teamName}` : ''}
          </span>
        </div>
        <p className="mt-2 line-clamp-3 text-[11.5px] leading-relaxed text-foreground/65">
          {attention.detail ?? meta.hint}
        </p>
      </button>
      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        {canRetry && (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => void retry(task.id).then((ok) => ok && onChanged())}
          >
            <RotateCcw size={13} strokeWidth={2.2} />
            Retry
          </Button>
        )}
        {canAssign && teamId && (
          <AssignAgentSelect taskId={task.id} teamId={teamId} onAssigned={onChanged} />
        )}
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void dismiss(task.id).then((ok) => ok && onChanged())}
        >
          Dismiss
        </Button>
      </div>
    </div>
  )
}

export function NeedsYouColumn({
  teamFilter,
  tasks,
  onOpenTask,
  onTasksChanged,
}: {
  teamFilter: string
  /** The board tasks that need a person (the board routes them here). */
  tasks: BoardTask[]
  onOpenTask: (taskId: string) => void
  /** An action on a card changed the board; the host should refresh. */
  onTasksChanged: () => void
}) {
  // `all` → no team filter (every pending approval); a team id → that team's agents
  // plus any approval not attributable to an agent (includeUnscoped).
  const { exec, tool, resolveTool } = usePendingApprovals({
    teamId: teamFilter === 'all' ? null : teamFilter,
    includeUnscoped: true,
  })

  const approvals = useMemo<ApprovalItem[]>(() => {
    const merged: ApprovalItem[] = [
      ...exec.map((a): ApprovalItem => ({
        key: `exec-${a.id}`,
        ts: a.createdAtMs,
        kind: 'exec',
        exec: a,
      })),
      ...tool.map((a): ApprovalItem => ({
        key: `tool-${a.id}`,
        ts: a.createdAt,
        kind: 'tool',
        tool: a,
      })),
    ]
    return merged.sort((a, b) => a.ts - b.ts)
  }, [exec, tool])

  const stuck = useMemo(
    () =>
      tasks
        .map((task) => ({ task, attention: taskAttentionOf(task) }))
        .filter((x): x is { task: BoardTask; attention: TaskAttention } => x.attention !== null),
    [tasks],
  )
  const total = approvals.length + stuck.length

  return (
    <div
      data-testid="board-column-needs-you"
      className={[
        'flex max-h-full w-[288px] shrink-0 flex-col gap-2.5 rounded-2xl border p-3 transition-colors',
        total > 0 ? 'border-amber/40 bg-amber/[0.04]' : 'border-border bg-foreground/[0.02]',
      ].join(' ')}
    >
      <div className="flex items-center justify-between px-1">
        <span className="flex items-center gap-1.5">
          <ShieldAlert
            size={14}
            strokeWidth={2}
            className={total > 0 ? 'text-amber' : 'text-foreground/35'}
          />
          <span className={SECTION_LABEL}>Needs you</span>
        </span>
        <span
          className={[
            'font-data rounded-full px-2 py-0.5 text-[10px] font-semibold',
            total > 0 ? 'bg-amber/20 text-amber' : 'bg-foreground/[0.06] text-foreground/50',
          ].join(' ')}
        >
          {total}
        </span>
      </div>

      <div className="flex min-h-0 flex-col gap-2.5 overflow-y-auto">
        {total === 0 && (
          <div
            data-testid="needs-you-empty"
            className="flex flex-col items-center gap-1.5 px-2 py-5 text-center"
          >
            <CheckCircle2 size={18} strokeWidth={2} className="text-mint" />
            <span className="text-[12px] font-medium text-foreground/70">
              Nothing needs you right now
            </span>
            <span className="text-[11px] leading-relaxed text-muted-foreground">
              Approvals, failed runs and stuck tasks show up here.
            </span>
          </div>
        )}

        {approvals.length > 0 && (
          <div className="flex flex-col gap-2.5" data-testid="needs-you-approvals">
            <span className={GROUP_LABEL}>
              Approval pending
              <span className="font-data text-foreground/35">{approvals.length}</span>
            </span>
            <AnimatePresence mode="popLayout">
              {approvals.map((it) =>
                it.kind === 'exec' ? (
                  <InlineApprovalCard key={it.key} approval={it.exec} showAgentName />
                ) : (
                  <ToolApprovalCard
                    key={it.key}
                    approval={it.tool}
                    onResolve={resolveTool}
                    compact
                  />
                ),
              )}
            </AnimatePresence>
          </div>
        )}

        {stuck.length > 0 && (
          <div className="flex flex-col gap-2.5" data-testid="needs-you-tasks">
            <span className={GROUP_LABEL}>
              Tasks
              <span className="font-data text-foreground/35">{stuck.length}</span>
            </span>
            {stuck.map(({ task, attention }, i) => (
              <motion.div
                key={task.id}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ ...ENTER_SPRING, delay: listDelay(i) }}
              >
                <NeedsYouTaskCard
                  task={task}
                  attention={attention}
                  showTeam={teamFilter === 'all'}
                  onOpen={() => onOpenTask(task.id)}
                  onChanged={onTasksChanged}
                />
              </motion.div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
