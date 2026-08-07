// Manual "New task" composer — the human-driven counterpart to agent delegation.
// A modal (mirrors ConfirmDialog's scrim + surface-overlay-tier card + spring)
// that collects a title, optional description, team, and initial status, then
// writes through boardClient.createTask. The board stays agent-first; this is the
// escape hatch for a user who wants to drop work on it directly.
//
// The body lives in an inner component that mounts only while open, so
// useFocusTrap can trap Tab within the dialog and restore focus to the trigger on
// close — and so the form resets to a clean state on every open by construction.

import { useId, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Plus } from 'lucide-react'

import { boardClient, type BoardTask } from '@/lib/boardClient'
import { useTeamStore } from '@/stores/team'
import { useToastStore } from '@/stores/toast'
import { Button } from '@/features/shared/Button'
import { Select } from '@/features/shared/Select'
import { useFocusTrap } from '@/features/shared/useFocusTrap'

import { STATUS_LABEL, type TaskStatus } from './boardStatus'
import { useDismissableLayer } from '@/features/shared/useDismissableLayer'

// A manual task starts life in triage or ready-to-claim; the later lifecycle
// states (in_progress … done) belong to an assignee doing the work, so we don't
// offer them at creation time.
const INITIAL_STATUSES = ['todo', 'backlog'] as const

const FIELD_LABEL = 'mb-1.5 block text-[12px] font-medium text-foreground/60'
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
  const addToast = useToastStore((s) => s.addToast)

  const titleId = useId()
  const descId = useId()
  const teamId = useId()
  const statusId = useId()
  const headingId = useId()

  // The dialog element: useFocusTrap moves focus to its first focusable (the title
  // input), traps Tab within it, and restores focus to the trigger on unmount.
  const dialogRef = useRef<HTMLFormElement | null>(null)
  useFocusTrap(dialogRef, 0)

  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [team, setTeam] = useState(defaultTeamId ?? '')
  const [status, setStatus] = useState<TaskStatus>('todo')
  const [submitting, setSubmitting] = useState(false)

  // Escape closes — unless a request is in flight (don't abandon a pending write).
  // The layer stack arbitrates: an open Team/Status `<Select>` is a popover and
  // outranks this dialog, so dismissing the dropdown leaves the form intact.
  // This used to be a window-BUBBLE listener chosen specifically to lose that
  // race to Select's document-capture handler; the stack makes the ordering
  // explicit instead of a function of which phase each side guessed (issue #95).
  //
  // Escape is consumed even mid-submit — a no-op here is deliberate, so the key
  // cannot fall through to the app shell and navigate out from under the write.
  useDismissableLayer({
    active: true,
    level: 'dialog',
    onEscape: () => {
      if (!submitting) onClose()
    },
  })

  const trimmedTitle = title.trim()
  const canSubmit = trimmedTitle.length > 0 && !submitting

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!canSubmit) return
    setSubmitting(true)
    const task = await boardClient.createTask({
      title: trimmedTitle,
      description: description.trim() || undefined,
      teamId: team || undefined,
      status,
    })
    if (task) {
      addToast({ type: 'success', message: 'Task created' })
      onCreated(task)
      onClose()
    } else {
      addToast({ type: 'error', message: 'Couldn’t create the task. Please try again.' })
      setSubmitting(false)
    }
  }

  const activeTeams = teams.filter((t) => !t.isArchived)

  return (
    <motion.div
      className="fixed inset-0 z-[80] flex items-center justify-center p-4"
      style={{ background: 'var(--overlay-scrim)' }}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !submitting) onClose()
      }}
    >
      <motion.form
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        data-testid="new-task-dialog"
        className="surface-overlay-tier w-full max-w-[440px] rounded-2xl p-5"
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
          Add work to the board manually. Agents can then claim and run it, just like a delegated
          task.
        </p>

        <div className="mt-4 flex flex-col gap-3.5">
          <div>
            <label htmlFor={titleId} className={FIELD_LABEL}>
              Title
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
              Description <span className="text-foreground/35">(optional)</span>
            </label>
            <textarea
              id={descId}
              className={`${INPUT_CLASS} resize-none py-2 leading-relaxed`}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Add any context an agent would need to pick this up."
              rows={3}
              maxLength={20_000}
              disabled={submitting}
            />
          </div>

          <div className="flex gap-3">
            <div className="min-w-0 flex-1">
              <label htmlFor={teamId} className={FIELD_LABEL}>
                Team
              </label>
              <Select
                id={teamId}
                aria-label="Team"
                value={team}
                onChange={setTeam}
                disabled={submitting}
                style={{ width: '100%' }}
              >
                <option value="">No team</option>
                {activeTeams.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.icon} {t.name}
                  </option>
                ))}
              </Select>
            </div>
            <div className="min-w-0 flex-1">
              <label htmlFor={statusId} className={FIELD_LABEL}>
                Status
              </label>
              <Select
                id={statusId}
                aria-label="Initial status"
                value={status}
                onChange={(v) => setStatus(v as TaskStatus)}
                disabled={submitting}
                style={{ width: '100%' }}
              >
                {INITIAL_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {STATUS_LABEL[s]}
                  </option>
                ))}
              </Select>
            </div>
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
            Create task
          </Button>
        </div>
      </motion.form>
    </motion.div>
  )
}
