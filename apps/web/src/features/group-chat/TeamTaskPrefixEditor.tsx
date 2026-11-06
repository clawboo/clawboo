// The letters on a team's readable task ids, like CLB in CLB-12. A person can change
// them until the team's first task exists; after that they are fixed, so an id
// someone wrote down stays true. Used by `TeamSettingsSheet`.

import { useEffect, useState, type FormEvent } from 'react'
import { Save } from 'lucide-react'

import { Button } from '@/features/shared/Button'
import { Spinner } from '@/features/shared/Spinner'
import {
  fetchTeamTaskPrefix,
  saveTeamTaskPrefix,
  type PrefixRefusal,
  type TeamTaskPrefix,
} from '@/lib/teamLabels'
import { useToastStore } from '@/stores/toast'

const REFUSAL_WORDS: Record<PrefixRefusal, string> = {
  invalid: 'Use 2 to 6 letters and numbers, starting with a letter.',
  taken: 'Another team uses these letters. Try others.',
  locked: 'This team has tasks now, so its letters are fixed.',
  not_found: 'This team no longer exists.',
  person_only: 'Change this from the dashboard.',
  failed: 'Could not save. Please try again.',
}

export function TeamTaskPrefixEditor({ teamId }: { teamId: string }) {
  const [state, setState] = useState<TeamTaskPrefix | null>(null)
  const [loading, setLoading] = useState(true)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [refusal, setRefusal] = useState<PrefixRefusal | null>(null)
  const addToast = useToastStore((s) => s.addToast)

  useEffect(() => {
    let active = true
    setLoading(true)
    void fetchTeamTaskPrefix(teamId).then((value) => {
      if (!active) return
      setState(value)
      setDraft(value?.prefix ?? value?.suggested ?? '')
      setLoading(false)
    })
    return () => {
      active = false
    }
  }, [teamId])

  if (loading) return <Spinner size={14} />
  if (!state) {
    return <p className="m-0 text-xs text-muted-foreground">Could not read this team's task ids.</p>
  }

  const current = state.prefix ?? state.suggested
  const example = `${(state.locked ? current : draft.trim().toUpperCase()) || current}-12`

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setSaving(true)
    const result = await saveTeamTaskPrefix(teamId, draft)
    setSaving(false)
    if (!result.ok) {
      setRefusal(result.reason)
      if (result.reason === 'locked') {
        const fresh = await fetchTeamTaskPrefix(teamId)
        if (fresh) setState(fresh)
      }
      return
    }
    setRefusal(null)
    setDraft(result.prefix)
    setState({ prefix: result.prefix, suggested: result.prefix, locked: false })
    addToast({
      type: 'success',
      message: `Task ids will read ${result.prefix}-1, ${result.prefix}-2 and on`,
    })
  }

  if (state.locked) {
    return (
      <div className="flex flex-col gap-1" data-testid="team-task-prefix">
        <span className="font-mono text-sm text-foreground">{current}</span>
        <p className="m-0 text-xs text-muted-foreground">
          This team's tasks read {current}-1, {current}-2 and on. The letters are fixed now that it
          has tasks, and renaming the team does not change them.
        </p>
      </div>
    )
  }

  const unchanged = draft.trim().toUpperCase() === (state.prefix ?? '')
  return (
    <form
      onSubmit={(e) => void handleSubmit(e)}
      className="flex flex-col gap-2"
      data-testid="team-task-prefix"
    >
      <div className="flex items-center gap-2">
        <input
          aria-label="Letters on this team's task ids"
          value={draft}
          maxLength={6}
          autoCapitalize="characters"
          spellCheck={false}
          onChange={(e) => {
            setDraft(e.target.value)
            setRefusal(null)
          }}
          className="h-9 w-28 rounded-lg border border-border bg-transparent px-2.5 font-mono text-sm uppercase text-foreground outline-none focus:border-border-strong"
        />
        <Button type="submit" size="sm" disabled={saving || unchanged || !draft.trim()}>
          {saving ? <Spinner size={13} /> : <Save size={13} strokeWidth={2} aria-hidden />}
          Save
        </Button>
      </div>
      <p className="m-0 text-xs text-muted-foreground" aria-live="polite">
        {refusal
          ? REFUSAL_WORDS[refusal]
          : `This team's tasks will read ${example}. You can change the letters until its first task.`}
      </p>
    </form>
  )
}
