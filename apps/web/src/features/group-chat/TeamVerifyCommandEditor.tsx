// TeamVerifyCommandEditor: the team's verify command, the check the
// verification gate runs for the team's tasks. Unset, each agent's own command
// in its worktree's init.sh is used. Source of truth: settings table
// `team-verify-command:<teamId>`.
//
// Used by `TeamSettingsSheet`, opened from the team header gear icon.

import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Save } from 'lucide-react'
import { Button } from '@/features/shared/Button'
import { Spinner } from '@/features/shared/Spinner'
import { useToastStore } from '@/stores/toast'
import {
  TEAM_VERIFY_COMMAND_MAX_CHARS,
  fetchTeamVerifyCommand,
  saveTeamVerifyCommand,
} from '@/lib/teamVerifyCommand'

export function TeamVerifyCommandEditor({ teamId }: { teamId: string }) {
  const [command, setCommand] = useState<string>('')
  const [clean, setClean] = useState<string>('')
  const [loading, setLoading] = useState<boolean>(true)
  const [loadFailed, setLoadFailed] = useState<boolean>(false)
  const [saving, setSaving] = useState<boolean>(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setLoadFailed(false)
    void fetchTeamVerifyCommand(teamId).then((value) => {
      if (cancelled) return
      setCommand(value ?? '')
      setClean(value ?? '')
      setLoadFailed(value === null)
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [teamId])

  // The server trims, so surrounding spaces alone are not a change. After a
  // failed read the stored value is unknown, so any save, empty included, may
  // replace it.
  const isDirty = command.trim() !== clean
  const canSave = isDirty || loadFailed

  const handleSave = useCallback(
    async (e: FormEvent) => {
      e.preventDefault()
      if (!canSave) return
      setSaving(true)
      try {
        const stored = await saveTeamVerifyCommand(teamId, command)
        if (stored === null) {
          useToastStore
            .getState()
            .addToast({ message: 'Could not save the work check.', type: 'error' })
          return
        }
        setCommand(stored)
        setClean(stored)
        setLoadFailed(false)
        useToastStore.getState().addToast({
          message: stored ? 'Work check saved.' : 'Work check cleared.',
          type: 'success',
        })
      } finally {
        setSaving(false)
      }
    },
    [canSave, command, teamId],
  )

  return (
    <form className="flex flex-col gap-3" onSubmit={handleSave}>
      <p className="m-0 text-[12px] leading-relaxed text-foreground/45">
        The command Clawboo runs in a task&apos;s folder to check an agent&apos;s work, such as{' '}
        <code className="font-mono text-[11px] text-foreground/70">npm test</code>. A task reaches
        Done only when the command succeeds. Leave it empty to let each agent write its own.
      </p>
      {loading ? (
        <div className="flex items-center gap-2 p-2.5 text-[12px] text-foreground/50">
          <Spinner size={13} /> Loading work check…
        </div>
      ) : (
        <>
          {loadFailed ? (
            <p role="alert" className="m-0 text-[12px] text-destructive">
              Could not load this team&apos;s work check. Saving replaces it.
            </p>
          ) : (
            // Where the check that runs now comes from, in the task drawer's
            // words (`set for the team` / `written by the agent`). It follows
            // the saved value, not the draft.
            <p data-testid="work-check-active" className="m-0 text-[12px] text-foreground/70">
              <span className="font-medium text-foreground">Active check:</span>{' '}
              {clean ? (
                <>
                  <code className="font-mono text-[11px]">{clean}</code>, set for the team.
                </>
              ) : (
                <>each agent&apos;s own, written by the agent in its task folder.</>
              )}
            </p>
          )}
          <input
            // The visible "Work check" heading lives in the parent sheet, so the
            // control carries its own name rather than borrowing one.
            aria-label="Work check command"
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            disabled={saving}
            maxLength={TEAM_VERIFY_COMMAND_MAX_CHARS}
            spellCheck={false}
            autoComplete="off"
            placeholder="None set. For example: npm test"
            className="w-full rounded-xl border border-border bg-surface px-4 py-2.5 font-mono text-[12px] text-foreground outline-none transition placeholder:text-foreground/30 focus:border-primary focus:ring-4 focus:ring-primary/15"
          />
          <div className="flex items-center gap-2.5">
            <Button type="submit" variant="primary" size="sm" disabled={!canSave} loading={saving}>
              {!saving && <Save size={14} strokeWidth={2} />}
              Save check
            </Button>
            {isDirty && (
              <span className="font-mono text-[11px] uppercase tracking-[0.1em] text-amber">
                Unsaved changes
              </span>
            )}
          </div>
        </>
      )}
    </form>
  )
}
