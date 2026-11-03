// TeamVerifyCommandEditor: the team's verify command, the check the
// verification gate runs for the team's tasks. Unset, each agent's own command
// in its worktree's init.sh is used. Source of truth: settings table
// `team-verify-command:<teamId>`.
//
// Used by `TeamSettingsSheet`, opened from the team header gear icon.

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
} from 'react'
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
  const [lineBreakRefused, setLineBreakRefused] = useState<boolean>(false)

  // Only the newest read or save may write state, so a slow read never lands
  // over a later one. `settled` marks the first read that landed, whichever
  // read it was. `shown` lets a later read keep an unsaved draft.
  const latest = useRef(0)
  const settled = useRef(false)
  const shown = useRef({ command, clean })
  shown.current = { command, clean }

  useEffect(() => {
    let active = true
    const read = () => {
      const id = ++latest.current
      void fetchTeamVerifyCommand(teamId).then((value) => {
        if (!active || id !== latest.current) return
        const first = !settled.current
        settled.current = true
        if (value === null) {
          // A failed re-read keeps what is on screen; only the first read says so.
          if (first) {
            setCommand('')
            setClean('')
            setLoadFailed(true)
            setLoading(false)
          }
          return
        }
        if (first || shown.current.command.trim() === shown.current.clean) setCommand(value)
        setClean(value)
        setLoadFailed(false)
        setLoading(false)
      })
    }
    settled.current = false
    setLoading(true)
    setLoadFailed(false)
    read()
    // The command can change elsewhere (the API, another window) while the sheet
    // is open, so read it again when the window regains focus: the Active check
    // line must name what the gate runs.
    const onFocus = () => read()
    window.addEventListener('focus', onFocus)
    return () => {
      active = false
      window.removeEventListener('focus', onFocus)
    }
  }, [teamId])

  // A single-line input drops line breaks from pasted or dropped text, which
  // would join two commands into one the gate then runs through a shell.
  const refuseLineBreaks = useCallback((text: string, e: { preventDefault: () => void }) => {
    if (!/[\r\n]/.test(text)) return
    e.preventDefault()
    setLineBreakRefused(true)
  }, [])

  // The server trims, so surrounding spaces alone are not a change. After a
  // failed read the stored value is unknown, so any save, empty included, may
  // replace it.
  const isDirty = command.trim() !== clean
  const canSave = isDirty || loadFailed

  const handleSave = useCallback(
    async (e: FormEvent) => {
      e.preventDefault()
      if (!canSave) return
      latest.current++
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
        The command Clawboo runs to check an agent&apos;s work, such as{' '}
        <code className="font-mono text-[11px] text-foreground/70">npm test</code>. Only task-runner
        tasks that changed files are checked, and those reach Done only when the command succeeds;
        work handed out in team chat and tasks given on the Board are never checked. Leave it empty
        to let each agent write its own.
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
            onChange={(e) => {
              setCommand(e.target.value)
              setLineBreakRefused(false)
            }}
            onPaste={(e: ClipboardEvent<HTMLInputElement>) =>
              refuseLineBreaks(e.clipboardData.getData('text'), e)
            }
            onDrop={(e: DragEvent<HTMLInputElement>) =>
              refuseLineBreaks(e.dataTransfer.getData('text'), e)
            }
            disabled={saving}
            maxLength={TEAM_VERIFY_COMMAND_MAX_CHARS}
            spellCheck={false}
            autoComplete="off"
            placeholder="None set. For example: npm test"
            className="w-full rounded-xl border border-border bg-surface px-4 py-2.5 font-mono text-[12px] text-foreground outline-none transition placeholder:text-foreground/30 focus:border-primary focus:ring-4 focus:ring-primary/15"
          />
          {lineBreakRefused && (
            <p role="alert" className="m-0 text-[12px] text-destructive">
              The work check is one line. Paste a single command, or join commands with{' '}
              <code className="font-mono text-[11px]">&amp;&amp;</code>.
            </p>
          )}
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
