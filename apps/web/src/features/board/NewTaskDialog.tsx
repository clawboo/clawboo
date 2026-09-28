// Manual "New task" composer: a person handing a task straight to one agent.
// A modal (mirrors ConfirmDialog's scrim + surface-overlay-tier card + spring)
// that asks, in order, for the team, then the agent on that team, then the task.
// The server binds the task to that agent and starts it right away; the card shows
// on the board and in the team's chat, and its result is reported there. The team
// lead is not involved: only the chosen agent works on it.
//
// The body lives in an inner component that mounts only while open, so
// useFocusTrap can trap Tab within the dialog and restore focus to the trigger on
// close — and so the form resets to a clean state on every open by construction.

import { useId, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Plus } from 'lucide-react'

import { createTaskForAgent, type BoardTask } from '@/lib/boardClient'
import { useFleetStore } from '@/stores/fleet'
import { useTeamStore } from '@/stores/team'
import { useToastStore } from '@/stores/toast'
import { Button } from '@/features/shared/Button'
import { Select } from '@/features/shared/Select'
import { useFocusTrap } from '@/features/shared/useFocusTrap'

import { useDismissableLayer } from '@/features/shared/useDismissableLayer'

const FIELD_LABEL = 'mb-1.5 block text-[12px] font-medium text-foreground/60'
const FIELD_HINT = 'mt-1.5 text-[11.5px] leading-relaxed text-foreground/45'
const INPUT_CLASS =
  'w-full rounded-lg border border-border bg-surface px-3 text-[13.5px] text-foreground ' +
  'outline-none transition placeholder:text-foreground/35 ' +
  'focus:border-primary focus:ring-4 focus:ring-primary/15 disabled:opacity-50'

export interface NewTaskDialogProps {
  open: boolean
  onClose: () => void
  /** Preselect this team (the board's active team filter), when one is active. */
  defaultTeamId?: string
  /** Called with the created task so the board can reflect it immediately. */
  onCreated: (task: BoardTask) => void
}

export function NewTaskDialog({ open, onClose, defaultTeamId, onCreated }: NewTaskDialogProps) {
  // Mount the body only while open so its state resets each time and useFocusTrap
  // (inside) activates/restores with the dialog's lifecycle.
  return (
    <AnimatePresence>
      {open && (
        <NewTaskDialogBody
          key="new-task"
          onClose={onClose}
          defaultTeamId={defaultTeamId}
          onCreated={onCreated}
        />
      )}
    </AnimatePresence>
  )
}

type NewTaskDialogBodyProps = Omit<NewTaskDialogProps, 'open'>

function NewTaskDialogBody({ onClose, defaultTeamId, onCreated }: NewTaskDialogBodyProps) {
  const teams = useTeamStore((s) => s.teams)
  const selectedTeamId = useTeamStore((s) => s.selectedTeamId)
  const agents = useFleetStore((s) => s.agents)
  const addToast = useToastStore((s) => s.addToast)

  const teamFieldId = useId()
  const agentFieldId = useId()
  const titleId = useId()
  const descId = useId()
  const headingId = useId()

  // The dialog element: useFocusTrap moves focus to its first focusable (the team
  // picker), traps Tab within it, and restores focus to the trigger on unmount.
  const dialogRef = useRef<HTMLFormElement | null>(null)
  useFocusTrap(dialogRef, 0)

  const activeTeams = useMemo(() => teams.filter((t) => !t.isArchived), [teams])
  const initialTeam =
    [defaultTeamId, selectedTeamId].find((id) => id && activeTeams.some((t) => t.id === id)) ??
    (activeTeams.length === 1 ? activeTeams[0]!.id : '')

  const [team, setTeam] = useState<string>(initialTeam)
  const members = useMemo(
    () => (team ? agents.filter((a) => a.teamId === team) : []),
    [agents, team],
  )
  // A one-agent team has nothing to choose; otherwise the choice is explicit.
  const [agent, setAgent] = useState<string>(() =>
    initialTeam ? onlyMember(agents.filter((a) => a.teamId === initialTeam)) : '',
  )
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [submitting, setSubmitting] = useState(false)

  // Escape closes — unless a request is in flight (don't abandon a pending write).
  // The layer stack arbitrates: an open Team/Agent `<Select>` is a popover and
  // outranks this dialog, so dismissing the dropdown leaves the form intact
  // (issue #95). Escape is consumed even mid-submit: the no-op is deliberate, so
  // the key cannot fall through to the app shell and navigate out from under the
  // write. Outside-press runs through the same stack rather than the scrim's
  // own handler, so it cannot fire ON TOP of an open dropdown's dismissal.
  useDismissableLayer({
    active: true,
    level: 'dialog',
    onEscape: () => {
      if (!submitting) onClose()
    },
    contains: (t) => !!dialogRef.current?.contains(t),
    onPressOutside: () => {
      if (!submitting) onClose()
    },
  })

  const trimmedTitle = title.trim()
  const agentValid = members.some((a) => a.id === agent)
  const canSubmit = !!team && agentValid && trimmedTitle.length > 0 && !submitting
  const agentName = members.find((a) => a.id === agent)?.name ?? null

  function handleTeamChange(next: string) {
    setTeam(next)
    setAgent(onlyMember(agents.filter((a) => a.teamId === next)))
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!canSubmit) return
    setSubmitting(true)
    const task = await createTaskForAgent({
      title: trimmedTitle,
      description: description.trim() || undefined,
      teamId: team,
      assigneeAgentId: agent,
    })
    if (task) {
      addToast({
        type: 'success',
        message: agentName ? `Task sent to ${agentName}` : 'Task created',
      })
      onCreated(task)
      onClose()
    } else {
      addToast({ type: 'error', message: 'Couldn’t create the task. Please try again.' })
      setSubmitting(false)
    }
  }

  return (
    <motion.div
      className="fixed inset-0 z-[80] flex items-center justify-center p-4"
      style={{ background: 'var(--overlay-scrim)' }}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
      role="presentation"
    >
      <motion.form
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        data-testid="new-task-dialog"
        className="surface-overlay-tier w-full max-w-[460px] rounded-2xl p-5"
        initial={{ opacity: 0, scale: 0.96, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.97, y: 6 }}
        transition={{ type: 'spring', stiffness: 320, damping: 26 }}
        onSubmit={handleSubmit}
      >
        <h2
          id={headingId}
          className="text-[15px] font-semibold text-foreground"
          style={{ letterSpacing: '-0.01em' }}
        >
          New task
        </h2>
        <p className="mt-1 text-[12.5px] leading-relaxed text-foreground/55">
          Give one agent a task. It starts right away, and only that agent works on it.
        </p>

        <div className="mt-4 flex flex-col gap-3.5">
          <div className="flex gap-3">
            <div className="min-w-0 flex-1">
              <label htmlFor={teamFieldId} className={FIELD_LABEL}>
                Team
              </label>
              <Select
                id={teamFieldId}
                aria-label="Team"
                value={team}
                onChange={handleTeamChange}
                disabled={submitting || activeTeams.length === 0}
                style={{ width: '100%' }}
              >
                <option value="" disabled>
                  {activeTeams.length === 0 ? 'No teams yet' : 'Choose a team'}
                </option>
                {activeTeams.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.icon} {t.name}
                  </option>
                ))}
              </Select>
            </div>
            <div className="min-w-0 flex-1">
              <label htmlFor={agentFieldId} className={FIELD_LABEL}>
                Agent
              </label>
              <Select
                id={agentFieldId}
                aria-label="Agent"
                value={agent}
                onChange={setAgent}
                disabled={submitting || members.length === 0}
                style={{ width: '100%' }}
              >
                <option value="" disabled>
                  {!team
                    ? 'Pick a team first'
                    : members.length === 0
                      ? 'No agents'
                      : 'Choose an agent'}
                </option>
                {members.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </Select>
            </div>
          </div>

          <div>
            <label htmlFor={titleId} className={FIELD_LABEL}>
              Task
            </label>
            <input
              id={titleId}
              className={`${INPUT_CLASS} h-9`}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Draft the launch announcement"
              maxLength={500}
              disabled={submitting}
              required
            />
          </div>

          <div>
            <label htmlFor={descId} className={FIELD_LABEL}>
              Details <span className="text-foreground/35">(optional)</span>
            </label>
            <textarea
              id={descId}
              className={`${INPUT_CLASS} resize-none py-2 leading-relaxed`}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Anything the agent needs to know: context, constraints, what done looks like."
              rows={4}
              maxLength={20_000}
              disabled={submitting}
            />
            <p className={FIELD_HINT}>
              {agentName
                ? `${agentName} gets the task and the details. The result shows on the task card, on the board and in the team chat.`
                : 'The result shows on the task card, on the board and in the team chat.'}
            </p>
          </div>
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="primary"
            size="sm"
            loading={submitting}
            disabled={!canSubmit}
          >
            {!submitting && <Plus size={14} strokeWidth={2.2} />}
            {agentName ? `Send to ${agentName}` : 'Create task'}
          </Button>
        </div>
      </motion.form>
    </motion.div>
  )
}

/** The id of a team's only member, or '' when there is a choice to make. */
function onlyMember(members: Array<{ id: string }>): string {
  return members.length === 1 ? members[0]!.id : ''
}
