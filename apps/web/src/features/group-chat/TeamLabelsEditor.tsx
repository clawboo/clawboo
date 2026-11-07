// A team's labels: add, rename, remove. Removing one takes it off every task. Used by
// `TeamSettingsSheet`; a task's own labels are set in its drawer.

import { useEffect, useState, type FormEvent } from 'react'
import { Plus, Trash2 } from 'lucide-react'

import { Button } from '@/features/shared/Button'
import { Spinner } from '@/features/shared/Spinner'
import {
  createTeamLabel,
  deleteTeamLabel,
  fetchTeamLabels,
  renameTeamLabel,
  type LabelRefusal,
  type TaskLabel,
} from '@/lib/teamLabels'

const REFUSAL_WORDS: Record<LabelRefusal, string> = {
  invalid: 'A label is 1 to 40 characters.',
  taken: 'This team already has a label with that name.',
  too_many: 'This team has the most labels it can have.',
  not_found: 'That label is gone.',
  person_only: 'Not saved. Clawboo could not tell that this came from you in the dashboard.',
  failed: 'Could not save. Please try again.',
}

const byName = (a: TaskLabel, b: TaskLabel): number =>
  a.name.toLowerCase().localeCompare(b.name.toLowerCase())

function LabelRow({
  teamId,
  label,
  onRenamed,
  onRemoved,
  onRefused,
}: {
  teamId: string
  label: TaskLabel
  onRenamed: (label: TaskLabel) => void
  onRemoved: (id: string) => void
  onRefused: (reason: LabelRefusal) => void
}) {
  const [name, setName] = useState(label.name)
  const commit = async () => {
    const next = name.trim()
    if (next === label.name) return
    const result = await renameTeamLabel(teamId, label.id, next)
    if (result.ok) onRenamed(result.label)
    else {
      setName(label.name)
      onRefused(result.reason)
    }
  }
  return (
    <li className="flex items-center gap-2">
      <input
        aria-label={`Rename label ${label.name}`}
        value={name}
        maxLength={40}
        onChange={(e) => setName(e.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            e.currentTarget.blur()
          }
        }}
        className="h-8 min-w-0 flex-1 rounded-lg border border-transparent bg-transparent px-2 text-sm text-foreground outline-none hover:border-border focus:border-border-strong"
      />
      <button
        type="button"
        aria-label={`Remove label ${label.name}`}
        title="Remove it from the team and every task"
        onClick={() =>
          void deleteTeamLabel(teamId, label.id).then((ok) =>
            ok ? onRemoved(label.id) : onRefused('failed'),
          )
        }
        className="flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-foreground/[0.04] hover:text-foreground"
      >
        <Trash2 size={14} strokeWidth={2} aria-hidden />
      </button>
    </li>
  )
}

export function TeamLabelsEditor({ teamId }: { teamId: string }) {
  const [labels, setLabels] = useState<TaskLabel[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [draft, setDraft] = useState('')
  const [refusal, setRefusal] = useState<LabelRefusal | null>(null)

  useEffect(() => {
    let active = true
    setLoading(true)
    void fetchTeamLabels(teamId).then((value) => {
      if (!active) return
      setLabels(value)
      setLoading(false)
    })
    return () => {
      active = false
    }
  }, [teamId])

  if (loading) return <Spinner size={14} />
  if (!labels)
    return <p className="m-0 text-xs text-muted-foreground">Could not read the labels.</p>

  async function handleAdd(e: FormEvent) {
    e.preventDefault()
    const result = await createTeamLabel(teamId, draft)
    if (!result.ok) {
      setRefusal(result.reason)
      return
    }
    setRefusal(null)
    setDraft('')
    setLabels((list) => [...(list ?? []), result.label].sort(byName))
  }

  return (
    <div className="flex flex-col gap-2" data-testid="team-labels">
      {labels.length > 0 ? (
        <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
          {labels.map((label) => (
            <LabelRow
              key={label.id}
              teamId={teamId}
              label={label}
              onRenamed={(next) =>
                setLabels((list) =>
                  (list ?? []).map((l) => (l.id === next.id ? next : l)).sort(byName),
                )
              }
              onRemoved={(id) => setLabels((list) => (list ?? []).filter((l) => l.id !== id))}
              onRefused={setRefusal}
            />
          ))}
        </ul>
      ) : (
        <p className="m-0 text-xs text-muted-foreground">
          Labels sort this team's tasks. Add them here, set them on a task, and filter the board by
          them.
        </p>
      )}
      <form onSubmit={(e) => void handleAdd(e)} className="flex items-center gap-2">
        <input
          aria-label="New label"
          placeholder="New label"
          value={draft}
          maxLength={40}
          onChange={(e) => {
            setDraft(e.target.value)
            setRefusal(null)
          }}
          className="h-9 min-w-0 flex-1 rounded-lg border border-border bg-transparent px-2.5 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-border-strong"
        />
        <Button type="submit" size="sm" disabled={!draft.trim()}>
          <Plus size={13} strokeWidth={2} aria-hidden />
          Add
        </Button>
      </form>
      {refusal ? (
        <p className="m-0 text-xs text-muted-foreground" aria-live="polite">
          {REFUSAL_WORDS[refusal]}
        </p>
      ) : null}
    </div>
  )
}
