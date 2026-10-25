// The agent view's "Tasks & Routines" card: the tasks assigned to this agent,
// in the same sections and task detail a room's Tasks card has, and below them
// the routines that send this agent work on a schedule.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { ChevronDown, Plus, Repeat } from 'lucide-react'

import { AgentTasks } from '@/features/group-chat/TeamTasksCard'
import { RoutineDialog, type RoutineDialogTarget } from '@/features/routines/RoutineDialog'
import { EMPTY_DIRECTORY, loadRoutineDirectory } from '@/features/routines/routineDirectory'
import { isClawbooRoutine, routineKindOf } from '@/features/routines/routineHelpers'
import { RoutineRow } from '@/features/routines/RoutinesPanel'
import { fetchSchedules, type ScheduleRecord } from '@/lib/schedulesClient'
import { useVisiblePolling } from '@/lib/useVisiblePolling'
import { useFleetStore } from '@/stores/fleet'

export function AgentTasksRoutines({ agentId }: { agentId: string }) {
  const [openTaskId, setOpenTaskId] = useState<string | null>(null)
  useEffect(() => setOpenTaskId(null), [agentId])

  return (
    <AgentTasks
      agentId={agentId}
      title="All tasks"
      openTaskId={openTaskId}
      onOpenTask={setOpenTaskId}
      after={<AgentRoutines agentId={agentId} onOpenTask={setOpenTaskId} />}
    />
  )
}

function AgentRoutines({
  agentId,
  onOpenTask,
}: {
  agentId: string
  onOpenTask: (taskId: string) => void
}) {
  const teamId = useFleetStore((s) => s.agents.find((a) => a.id === agentId)?.teamId ?? null)
  const [schedules, setSchedules] = useState<ScheduleRecord[] | null>(null)
  const [directory, setDirectory] = useState(EMPTY_DIRECTORY)
  const [dialog, setDialog] = useState<RoutineDialogTarget | null>(null)
  const [open, setOpen] = useState(true)

  const refresh = useCallback(async () => {
    const view = await fetchSchedules()
    if (view.ok) setSchedules(view.schedules)
  }, [])
  useEffect(() => {
    void refresh()
    void loadRoutineDirectory().then((next) => {
      if (next) setDirectory(next)
    })
  }, [refresh])
  useVisiblePolling(() => void refresh(), 15_000)

  const rows = useMemo(
    () =>
      (schedules ?? [])
        .filter((s) => isClawbooRoutine(s) && routineKindOf(s) === 'agent' && s.agentId === agentId)
        .sort((a, b) => (a.label ?? '').localeCompare(b.label ?? '')),
    [schedules, agentId],
  )
  const record =
    dialog?.mode === 'view' ? (schedules?.find((s) => s.id === dialog.id) ?? null) : null

  return (
    <section className="mt-1" data-testid="agent-routines">
      <div className="flex items-center gap-1">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-foreground/[0.04]"
        >
          <ChevronDown
            size={13}
            aria-hidden
            className="shrink-0 text-muted-foreground transition-transform duration-150"
            style={{ rotate: open ? '0deg' : '-90deg' }}
          />
          <span className="text-[12.5px] font-semibold text-foreground">Routines</span>
          <span className="font-data text-[11.5px] tabular-nums text-muted-foreground">
            {rows.length}
          </span>
        </button>
        <button
          type="button"
          onClick={() => setDialog({ mode: 'create' })}
          disabled={directory.agents.length === 0}
          className="flex shrink-0 cursor-pointer items-center gap-1 rounded-md px-2 py-1 text-[12px] font-medium text-muted-foreground transition-colors hover:bg-foreground/[0.05] hover:text-foreground disabled:cursor-default disabled:opacity-50"
          data-testid="agent-routine-new"
        >
          <Plus size={13} aria-hidden />
          New routine
        </button>
      </div>
      {open && (
        <div className="flex flex-col gap-2 px-1 pt-1.5">
          {schedules !== null && rows.length === 0 && (
            <p className="flex items-center gap-2 px-1.5 py-1 text-[12px] text-muted-foreground">
              <Repeat size={13} aria-hidden className="shrink-0" />
              No routines send this agent work yet.
            </p>
          )}
          {rows.map((rec) => (
            <RoutineRow
              key={rec.id}
              rec={rec}
              onOpen={() => setDialog({ mode: 'view', id: rec.id })}
              onChanged={() => void refresh()}
            />
          ))}
        </div>
      )}
      {dialog && (
        <RoutineDialog
          target={dialog}
          record={record}
          directory={directory}
          preferredTeamId={teamId}
          presetAgent={{ id: agentId, teamId }}
          onClose={() => setDialog(null)}
          onChanged={() => void refresh()}
          onOpenTask={(taskId) => {
            setDialog(null)
            onOpenTask(taskId)
          }}
        />
      )}
    </section>
  )
}
