// A task's labels in its drawer: the ones it has, and a small menu of its team's to
// add or take off. Saved on each change. Labels are made in Team settings, or here
// by typing a new name.

import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Check, Plus } from 'lucide-react'

import { useToastStore } from '@/stores/toast'
import { createTeamLabel, fetchTeamLabels, setTaskLabels, type TaskLabel } from '@/lib/teamLabels'

import { ToolbarPopover } from './BoardToolbar'

export function LabelChip({ name }: { name: string }) {
  return (
    <span
      data-testid="task-label"
      className="inline-flex max-w-[140px] items-center truncate rounded-md border border-border px-1.5 text-xs text-muted-foreground"
    >
      <span className="truncate">{name}</span>
    </span>
  )
}

export function TaskLabelsSelect({
  taskId,
  teamId,
  labels,
  onChange,
}: {
  taskId: string
  teamId: string
  labels: readonly TaskLabel[]
  onChange: (labels: TaskLabel[]) => void
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const [options, setOptions] = useState<TaskLabel[] | null>(null)
  const [draft, setDraft] = useState('')
  const addToast = useToastStore((s) => s.addToast)
  // A slow save must not land over a newer choice.
  const latest = useRef(0)

  useEffect(() => {
    if (!anchor) return
    let active = true
    void fetchTeamLabels(teamId).then((value) => {
      if (active) setOptions(value ?? [])
    })
    return () => {
      active = false
    }
  }, [anchor, teamId])

  const save = async (next: TaskLabel[]) => {
    const id = ++latest.current
    const previous = [...labels]
    onChange(next)
    const saved = await setTaskLabels(
      taskId,
      next.map((l) => l.id),
    )
    if (id !== latest.current) return
    if (saved) onChange(saved)
    else {
      onChange(previous)
      addToast({ type: 'error', message: 'Couldn’t change the labels. Please try again.' })
    }
  }

  const toggle = (label: TaskLabel) => {
    const on = labels.some((l) => l.id === label.id)
    void save(on ? labels.filter((l) => l.id !== label.id) : [...labels, label])
  }

  async function handleNew(e: FormEvent) {
    e.preventDefault()
    const name = draft.trim()
    if (!name) return
    const existing = options?.find((l) => l.name.toLowerCase() === name.toLowerCase())
    const result = existing
      ? { ok: true as const, label: existing }
      : await createTeamLabel(teamId, name)
    if (!result.ok) {
      addToast({ type: 'error', message: 'Couldn’t add that label.' })
      return
    }
    setDraft('')
    setOptions((list) => (existing ? list : [...(list ?? []), result.label]))
    if (!labels.some((l) => l.id === result.label.id)) void save([...labels, result.label])
  }

  return (
    <span className="flex flex-wrap items-center gap-1" data-testid="task-labels">
      {labels.map((label) => (
        <LabelChip key={label.id} name={label.name} />
      ))}
      <button
        type="button"
        data-testid="task-labels-edit"
        aria-haspopup="dialog"
        aria-expanded={anchor != null}
        onClick={(e) => {
          const el = e.currentTarget
          setAnchor((a) => (a ? null : el))
        }}
        className="inline-flex h-6 cursor-pointer items-center gap-1 rounded-md px-1.5 text-xs text-muted-foreground transition-colors hover:bg-foreground/[0.04] hover:text-foreground"
      >
        <Plus size={12} strokeWidth={2} aria-hidden />
        {labels.length === 0 ? 'Add label' : <span className="sr-only">Change labels</span>}
      </button>
      {anchor ? (
        <ToolbarPopover
          anchor={anchor}
          label="Labels"
          width={220}
          testId="task-labels-menu"
          onClose={() => setAnchor(null)}
        >
          <ul className="m-0 flex max-h-56 list-none flex-col overflow-y-auto p-1">
            {(options ?? []).map((label) => {
              const on = labels.some((l) => l.id === label.id)
              return (
                <li key={label.id}>
                  <button
                    type="button"
                    role="menuitemcheckbox"
                    aria-checked={on}
                    onClick={() => toggle(label)}
                    className="flex min-h-8 w-full cursor-pointer items-center justify-between gap-2 rounded-md px-2 text-left text-sm text-foreground hover:bg-foreground/[0.04]"
                  >
                    <span className="truncate">{label.name}</span>
                    {on ? <Check size={14} strokeWidth={2} aria-hidden /> : null}
                  </button>
                </li>
              )
            })}
          </ul>
          <form onSubmit={(e) => void handleNew(e)} className="border-t border-border p-1.5">
            <input
              aria-label="New label"
              placeholder="New label"
              value={draft}
              maxLength={40}
              onChange={(e) => setDraft(e.target.value)}
              className="h-8 w-full rounded-md border border-border bg-transparent px-2 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-border-strong"
            />
          </form>
        </ToolbarPopover>
      ) : null}
    </span>
  )
}
