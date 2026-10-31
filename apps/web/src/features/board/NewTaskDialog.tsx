// Manual "New task" composer: a person handing a task straight to one agent.
// A modal (mirrors ConfirmDialog's scrim + surface-overlay-tier card + spring)
// that leads with one field, "What should get done?", and suggests who should do
// it (suggestAgent: the sentence's words against each member's name and role,
// else the agent last given a task here, else the team lead). The person can take
// the suggestion or pick another agent; picking one also picks its team. Enter
// sends it. "More options" opens the full form: Team, Agent and Details.
// The server binds the task to that agent and starts it right away; the card shows
// on the board and in the team's chat, and its result is reported there. The team
// lead is not involved: only the chosen agent works on it.
//
// The body lives in an inner component that mounts only while open, so
// useFocusTrap can trap Tab within the dialog and restore focus to the trigger on
// close — and so the form resets to a clean state on every open by construction.

import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Plus } from 'lucide-react'

import { createTaskForAgent, fetchMemberRoles, type BoardTask } from '@/lib/boardClient'
import { useFleetStore } from '@/stores/fleet'
import { useTeamStore } from '@/stores/team'
import { useToastStore } from '@/stores/toast'
import { Button } from '@/features/shared/Button'
import { Select } from '@/features/shared/Select'
import { useFocusTrap } from '@/features/shared/useFocusTrap'

import { useDismissableLayer } from '@/features/shared/useDismissableLayer'

import { recentAssignees, rememberAssignee } from './newTaskMemory'
import { suggestAgent, type AgentCandidate, type SuggestionReason } from './suggestAgent'

const FIELD_LABEL = 'mb-1.5 block text-xs font-medium text-muted-foreground'
const FIELD_HINT = 'mt-1.5 text-xs leading-relaxed text-muted-foreground'
// No type size here: each field sets its own, so two sizes never compete.
const INPUT_CLASS =
  'w-full rounded-lg border border-border bg-surface px-3 text-foreground ' +
  'outline-none transition placeholder:text-muted-foreground ' +
  'focus:border-primary focus:ring-4 focus:ring-primary/15 disabled:opacity-50'

/** Why the agent was suggested, beside the agent picker. */
const REASON_LABEL: Record<SuggestionReason, string | null> = {
  match: 'Fits the task',
  'last-used': 'Last used',
  lead: 'Team lead',
  first: null,
}

export interface NewTaskDialogProps {
  open: boolean
  onClose: () => void
  /** The board's active team filter, when one is active: only its agents are
   *  suggested. Otherwise every active team's agents are. */
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
  const agents = useFleetStore((s) => s.agents)
  const addToast = useToastStore((s) => s.addToast)

  const teamFieldId = useId()
  const agentFieldId = useId()
  const titleId = useId()
  const descId = useId()
  const headingId = useId()

  // The dialog element: useFocusTrap moves focus to its first focusable (the one
  // field), traps Tab within it, and restores focus to the trigger on unmount.
  const dialogRef = useRef<HTMLFormElement | null>(null)
  useFocusTrap(dialogRef, 0)

  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  /** The agent the person picked; until then the suggestion stands. */
  const [pickedAgent, setPickedAgent] = useState<string | null>(null)
  /** The team the person picked under More options. */
  const [pickedTeam, setPickedTeam] = useState<string | null>(null)
  const [roles, setRoles] = useState<Record<string, string>>({})

  useEffect(() => {
    let live = true
    void fetchMemberRoles().then((next) => {
      if (live) setRoles(next)
    })
    return () => {
      live = false
    }
  }, [])

  const activeTeams = useMemo(() => teams.filter((t) => !t.isArchived), [teams])
  const filterTeam = activeTeams.find((t) => t.id === defaultTeamId)?.id ?? null
  const scopeTeam = pickedTeam ?? filterTeam
  const scopeTeams = useMemo(
    () => activeTeams.filter((t) => scopeTeam === null || t.id === scopeTeam),
    [activeTeams, scopeTeam],
  )
  // Roster order: team by team, each team's agents in fleet order.
  const candidates = useMemo<AgentCandidate[]>(
    () =>
      scopeTeams.flatMap((t) =>
        agents
          .filter((a) => a.teamId === t.id)
          .map((a) => ({ id: a.id, name: a.name, teamId: t.id, role: roles[a.id] ?? null })),
      ),
    [scopeTeams, agents, roles],
  )
  const recent = useMemo(() => recentAssignees(scopeTeam), [scopeTeam])
  const suggestion = suggestAgent({
    text: title,
    candidates,
    recentAgentIds: recent,
    leadAgentIds: scopeTeams.flatMap((t) => (t.leaderAgentId ? [t.leaderAgentId] : [])),
  })

  const picked = pickedAgent ? candidates.find((c) => c.id === pickedAgent) : undefined
  const agent = picked ?? candidates.find((c) => c.id === suggestion?.agentId)
  const team = agent?.teamId ?? scopeTeam ?? ''
  const reason = !picked && suggestion ? REASON_LABEL[suggestion.reason] : null
  const teamMembers = candidates.filter((c) => c.teamId === team)
  const manyTeams = new Set(candidates.map((c) => c.teamId)).size > 1
  const teamName = (id: string) => activeTeams.find((t) => t.id === id)?.name ?? ''

  // More options replaces its own button, so focus moves on to its first field.
  useEffect(() => {
    if (moreOpen) document.getElementById(teamFieldId)?.focus()
  }, [moreOpen, teamFieldId])

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
  const canSubmit = !!agent && trimmedTitle.length > 0 && !submitting

  function handleTeamChange(next: string) {
    setPickedTeam(next)
    setPickedAgent(null)
  }

  // Enter in the one field submits the form, so this is also the Enter path.
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!canSubmit || !agent) return
    setSubmitting(true)
    const task = await createTaskForAgent({
      title: trimmedTitle,
      description: description.trim() || undefined,
      teamId: agent.teamId,
      assigneeAgentId: agent.id,
    })
    if (task) {
      rememberAssignee(agent.teamId, agent.id)
      addToast({ type: 'success', message: `Task sent to ${agent.name}` })
      onCreated(task)
      onClose()
    } else {
      addToast({ type: 'error', message: 'Couldn’t create the task. Please try again.' })
      setSubmitting(false)
    }
  }

  const agentOptions = moreOpen ? teamMembers : candidates
  const agentSelect = (
    <Select
      id={agentFieldId}
      aria-label="Agent"
      size={moreOpen ? 'md' : 'sm'}
      value={agent?.id ?? ''}
      onChange={setPickedAgent}
      disabled={submitting || agentOptions.length === 0}
      menuWidth={moreOpen ? undefined : 240}
      style={moreOpen ? { width: '100%' } : undefined}
    >
      {agentOptions.length === 0 ? (
        <option value="" disabled>
          {moreOpen && !team ? 'Pick a team first' : 'No agents yet'}
        </option>
      ) : null}
      {agentOptions.map((c) => (
        <option key={c.id} value={c.id}>
          {c.name}
          {manyTeams && !moreOpen ? (
            <span className="text-muted-foreground">, {teamName(c.teamId)}</span>
          ) : null}
        </option>
      ))}
    </Select>
  )

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
          className="text-base font-semibold text-foreground"
          style={{ letterSpacing: '-0.01em' }}
        >
          New task
        </h2>

        <div className="mt-4 flex flex-col gap-3.5">
          <div>
            <label htmlFor={titleId} className={FIELD_LABEL}>
              What should get done?
            </label>
            <input
              id={titleId}
              className={`${INPUT_CLASS} h-10 text-base`}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Draft the launch announcement"
              maxLength={500}
              disabled={submitting}
              autoComplete="off"
              required
            />
          </div>

          {moreOpen ? (
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
                {agentSelect}
              </div>
            </div>
          ) : (
            <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
              <span>For</span>
              {agentSelect}
              {reason ? <span data-testid="new-task-suggestion">{reason}</span> : null}
            </div>
          )}

          {moreOpen ? (
            <div>
              <label htmlFor={descId} className={FIELD_LABEL}>
                Details <span className="font-normal">(optional)</span>
              </label>
              <textarea
                id={descId}
                className={`${INPUT_CLASS} resize-none py-2 text-sm leading-relaxed`}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Anything the agent needs to know: context, constraints, what done looks like."
                rows={4}
                maxLength={20_000}
                disabled={submitting}
              />
            </div>
          ) : null}
        </div>

        <p className={FIELD_HINT}>
          {agent
            ? `${agent.name} starts right away and is the only agent on it. The result shows on the task card, on the board and in the team chat.`
            : 'The result shows on the task card, on the board and in the team chat.'}
        </p>

        <div className="mt-5 flex items-center gap-2">
          {!moreOpen ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setMoreOpen(true)}
              disabled={submitting}
            >
              More options
            </Button>
          ) : null}
          <div className="ml-auto flex gap-2">
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
              {!submitting && <Plus size={14} strokeWidth={2} />}
              {agent ? `Send to ${agent.name}` : 'Create task'}
            </Button>
          </div>
        </div>
      </motion.form>
    </motion.div>
  )
}
