// New goal, or edit one: title, description (markdown), an optional parent goal
// (one level only: a goal under another goal cannot have goals under it), an
// owner (you or an agent on the team), a target date, and how often an update is
// expected. Health is set on the goal's page, not here.

import { useId, useMemo, useState } from 'react'

import {
  createGoal,
  updateGoal,
  type GoalSummary,
  type HomeActor,
  type TeamGoal,
} from '@clawboo/control-client'

import { Button } from '@/features/shared/Button'
import { Modal } from '@/features/shared/Modal'
import { Select } from '@/features/shared/Select'
import { useBoardPerson } from '@/features/board/useBoardPerson'
import { useFleetStore } from '@/stores/fleet'

import { fromDateInput, toDateInput } from './homeFormat'
import {
  DIALOG_PANEL,
  FIELD_HINT,
  FIELD_LABEL,
  INPUT_CLASS,
  TEXTAREA_CLASS,
  FULL_WIDTH,
} from './homeForm'
import { homeWrite } from './homeWrite'

const NO_PARENT = ''
const NO_OWNER = ''
const ME = 'person'

/** The owner picker's value for an actor: `ME` for you, else the actor's kind and id. */
function ownerValue(owner: HomeActor | null | undefined, meId: string): string {
  if (!owner) return NO_OWNER
  if (owner.kind === 'person' && owner.id === meId) return ME
  return `${owner.kind}:${owner.id}`
}

/** What the goal page knows that `goals` may not: `goals` holds active goals only, and
 *  is empty until the team's Home has loaded (a goal opened from All teams). */
export interface GoalDialogContext {
  /** The edited goal's parent, or the parent a new goal goes under. */
  parent: { id: string; title: string } | null
  /** How many goals sit under the edited goal. */
  childCount: number
}

export function GoalDialog({
  open,
  onClose,
  teamId,
  goals,
  editing,
  defaultParentId = null,
  context = null,
  onSaved,
}: {
  open: boolean
  onClose: () => void
  teamId: string
  /** The team's active goals, for the parent picker. */
  goals: GoalSummary[]
  /** The goal being edited; null for a new one. */
  editing: TeamGoal | null
  /** A new goal under this one (from a goal page's "Add a goal under it"). */
  defaultParentId?: string | null
  context?: GoalDialogContext | null
  onSaved: (goal: TeamGoal) => void
}) {
  // Held here so Escape and outside presses cannot close the dialog mid-save: a save
  // that lands later would otherwise close whatever dialog opened next.
  const [busy, setBusy] = useState(false)
  return (
    <Modal
      open={open}
      onClose={onClose}
      dismissible={!busy}
      label={editing ? 'Edit goal' : 'New goal'}
      data-testid="goal-dialog"
      panelClassName={DIALOG_PANEL}
    >
      <GoalForm
        key={editing?.id ?? 'new'}
        onClose={onClose}
        teamId={teamId}
        goals={goals}
        editing={editing}
        defaultParentId={defaultParentId}
        context={context}
        onSaved={onSaved}
        busy={busy}
        setBusy={setBusy}
      />
    </Modal>
  )
}

function GoalForm({
  onClose,
  teamId,
  goals,
  editing,
  defaultParentId,
  context,
  onSaved,
  busy,
  setBusy,
}: {
  onClose: () => void
  teamId: string
  goals: GoalSummary[]
  editing: TeamGoal | null
  defaultParentId: string | null
  context: GoalDialogContext | null
  onSaved: (goal: TeamGoal) => void
  busy: boolean
  setBusy: (busy: boolean) => void
}) {
  const ids = {
    heading: useId(),
    title: useId(),
    description: useId(),
    target: useId(),
    cadence: useId(),
  }
  const me = useBoardPerson()
  const agents = useFleetStore((s) => s.agents)
  const teamAgents = useMemo(
    () => agents.filter((a) => a.teamId === teamId).sort((a, b) => a.name.localeCompare(b.name)),
    [agents, teamId],
  )

  const [title, setTitle] = useState(editing?.title ?? '')
  const [description, setDescription] = useState(editing?.description ?? '')
  const [parentId, setParentId] = useState(editing?.parentGoalId ?? defaultParentId ?? NO_PARENT)
  // Null until the person picks an owner: until then the goal keeps the owner it has
  // (another person stays that person), and an edit leaves the owner out entirely.
  const [pickedOwner, setPickedOwner] = useState<string | null>(null)
  const owner = pickedOwner ?? ownerValue(editing?.owner, me.id)
  const [targetDate, setTargetDate] = useState(toDateInput(editing?.targetDate ?? null))
  const [cadence, setCadence] = useState(String(editing?.updateCadenceDays ?? 7))

  // A goal with goals under it stays on top: one level only.
  const hasChildren = editing
    ? (context?.childCount ?? 0) > 0 || goals.some((g) => g.goal.parentGoalId === editing.id)
    : false
  // The parent the goal has (or a new goal goes under) is always offered, even when it
  // is done, dropped or not loaded: a parent nobody changed is never cleared.
  const startParent = editing ? editing.parentGoalId : defaultParentId
  const parentOptions = [
    ...goals
      .filter((g) => g.goal.parentGoalId === null && g.goal.id !== editing?.id)
      .map((g) => ({ value: g.goal.id, label: g.goal.title })),
  ]
  if (startParent && !parentOptions.some((o) => o.value === startParent)) {
    const known = context?.parent?.id === startParent ? context.parent.title : null
    parentOptions.push({ value: startParent, label: known ?? 'A goal that is not active' })
  }

  const cadenceDays = Number(cadence)
  const cadenceOk = Number.isInteger(cadenceDays) && cadenceDays >= 1 && cadenceDays <= 90
  const canSave = title.trim().length > 0 && cadenceOk && !busy

  // The owner the goal has is always offered, even when it is another person or an
  // agent no longer on the team, so the picker never shows an owner it cannot name.
  const startOwner = editing?.owner ?? null
  const ownerOptions = [
    { value: NO_OWNER, label: 'Nobody' },
    { value: ME, label: me.name && me.name !== 'You' ? `${me.name} (you)` : 'You' },
    ...teamAgents.map((a) => ({ value: `agent:${a.id}`, label: a.name })),
  ]
  const startValue = ownerValue(startOwner, me.id)
  if (startOwner && !ownerOptions.some((o) => o.value === startValue)) {
    ownerOptions.splice(2, 0, {
      value: startValue,
      label: startOwner.name ?? (startOwner.kind === 'person' ? 'Another person' : 'An agent'),
    })
  }

  const ownerActor = (): HomeActor | null => {
    if (owner === ME) return { kind: 'person', id: me.id, name: me.name }
    if (startOwner && owner === startValue) return startOwner
    if (owner.startsWith('agent:')) {
      const id = owner.slice('agent:'.length)
      return { kind: 'agent', id, name: teamAgents.find((a) => a.id === id)?.name ?? null }
    }
    return null
  }

  async function save() {
    if (!canSave) return
    setBusy(true)
    const parentGoalId = parentId || null
    const input = {
      title: title.trim(),
      description,
      // Sent only when the person changed it: an edit never moves a goal by accident.
      ...(hasChildren || (editing && parentGoalId === editing.parentGoalId)
        ? {}
        : { parentGoalId }),
      // Sent only when the person picked one: an edit never changes the owner by accident.
      ...(editing && pickedOwner === null ? {} : { owner: ownerActor() }),
      targetDate: fromDateInput(targetDate),
      updateCadenceDays: cadenceDays,
    }
    const saved = await homeWrite(editing ? 'save the goal' : 'add the goal', () =>
      editing ? updateGoal(teamId, editing.id, input) : createGoal(teamId, input),
    )
    setBusy(false)
    if (saved) {
      onSaved(saved)
      onClose()
    }
  }

  return (
    <>
      <div className="px-5 pb-2 pt-5">
        <h2 id={ids.heading} className="text-base font-semibold text-foreground">
          {editing ? 'Edit goal' : 'New goal'}
        </h2>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          Link board tasks to a goal and its progress counts them. Agents can draft updates on it;
          only a person publishes them or sets its health.
        </p>
      </div>
      <form
        className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-3"
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        <div>
          <label htmlFor={ids.title} className={FIELD_LABEL}>
            Title
          </label>
          <input
            id={ids.title}
            data-testid="goal-title"
            className={INPUT_CLASS}
            maxLength={140}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            disabled={busy}
            placeholder="Launch the beta"
            autoComplete="off"
          />
        </div>
        <div>
          <label htmlFor={ids.description} className={FIELD_LABEL}>
            Description
          </label>
          <textarea
            id={ids.description}
            data-testid="goal-description"
            className={TEXTAREA_CLASS}
            rows={4}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            disabled={busy}
            placeholder="What done looks like. Markdown works."
          />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <span className={FIELD_LABEL}>Under goal</span>
            <Select
              style={FULL_WIDTH}
              aria-label="Under goal"
              value={hasChildren ? NO_PARENT : parentId}
              onChange={setParentId}
              disabled={busy || hasChildren}
              options={[{ value: NO_PARENT, label: 'None (a top goal)' }, ...parentOptions]}
            />
            {hasChildren ? (
              <p className={FIELD_HINT}>It has goals under it, so it stays a top goal.</p>
            ) : null}
          </div>
          <div>
            <span className={FIELD_LABEL}>Owner</span>
            <Select
              style={FULL_WIDTH}
              aria-label="Owner"
              value={owner}
              onChange={setPickedOwner}
              disabled={busy}
              options={ownerOptions}
            />
          </div>
          <div>
            <label htmlFor={ids.target} className={FIELD_LABEL}>
              Target date
            </label>
            <input
              id={ids.target}
              type="date"
              data-testid="goal-target-date"
              className={INPUT_CLASS}
              value={targetDate}
              onChange={(e) => setTargetDate(e.target.value)}
              disabled={busy}
            />
          </div>
          <div>
            <label htmlFor={ids.cadence} className={FIELD_LABEL}>
              Update every (days)
            </label>
            <input
              id={ids.cadence}
              type="number"
              min={1}
              max={90}
              inputMode="numeric"
              data-testid="goal-cadence"
              className={INPUT_CLASS}
              value={cadence}
              onChange={(e) => setCadence(e.target.value)}
              disabled={busy}
              aria-invalid={!cadenceOk}
            />
          </div>
        </div>
        <p className={FIELD_HINT}>
          With no update published in that many days, the goal shows Update missing.
        </p>
        <button type="submit" hidden aria-hidden tabIndex={-1} />
      </form>
      <div className="flex items-center gap-2 border-t border-border px-5 py-3">
        <span className="flex-1" />
        <Button variant="secondary" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button
          variant="primary"
          onClick={() => void save()}
          disabled={!canSave}
          loading={busy}
          data-testid="goal-save"
        >
          {editing ? 'Save' : 'Add goal'}
        </Button>
      </div>
    </>
  )
}
