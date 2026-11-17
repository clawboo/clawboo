// A team's Home switches: weekly goal updates (a normal team routine that asks the
// lead to draft an update for each active goal), and the lead-written status line
// (off by default, because it costs model calls).

import { useEffect, useRef, useState } from 'react'
import { CalendarClock } from 'lucide-react'

import {
  turnOnWeeklyUpdates,
  updateTeamHomeSettings,
  type TeamHomeSettings,
} from '@clawboo/control-client'

import { Button } from '@/features/shared/Button'
import { Modal } from '@/features/shared/Modal'
import { Switch } from '@/features/shared/Switch'
import { useSettingsModalStore } from '@/stores/settingsModal'

import { DIALOG_PANEL } from './homeForm'
import { homeWrite } from './homeWrite'

export function HomeSettingsDialog({
  open,
  onClose,
  teamId,
  teamName,
  settings,
  onChanged,
}: {
  open: boolean
  onClose: () => void
  teamId: string
  teamName: string
  settings: TeamHomeSettings
  onChanged: (settings: TeamHomeSettings) => void
}) {
  // One write at a time: each answer is the whole settings, so two in flight would
  // let the later answer put back what the earlier one changed. The ref turns a
  // second press away before the controls have re-rendered as disabled.
  const [busy, setBusy] = useState<'lead' | 'weekly' | null>(null)
  const pending = useRef(false)
  // What the server last said. A save shows at once, not when Home's next read lands
  // (and still shows if that read fails); a newer read replaces it.
  const [current, setCurrent] = useState(settings)
  useEffect(() => setCurrent(settings), [settings])

  async function setLeadWrites(next: boolean) {
    if (pending.current) return
    pending.current = true
    setBusy('lead')
    const saved = await homeWrite('save the setting', () =>
      updateTeamHomeSettings(teamId, { leadWritesStatus: next }),
    )
    pending.current = false
    setBusy(null)
    if (saved) {
      setCurrent(saved)
      onChanged(saved)
    }
  }

  async function weekly() {
    if (pending.current) return
    pending.current = true
    setBusy('weekly')
    const result = await homeWrite('turn on weekly updates', () => turnOnWeeklyUpdates(teamId), {
      success: 'Weekly updates are on. The lead drafts them; you publish them.',
    })
    pending.current = false
    setBusy(null)
    if (result) {
      setCurrent(result.settings)
      onChanged(result.settings)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      label={`Home settings for ${teamName}`}
      data-testid="home-settings"
      panelClassName={DIALOG_PANEL}
    >
      <div className="px-5 pb-2 pt-5">
        <h2 className="text-base font-semibold text-foreground">Home settings</h2>
        <p className="mt-1 text-xs text-muted-foreground">For {teamName}.</p>
      </div>
      <div className="flex flex-col gap-4 overflow-y-auto px-5 py-3">
        <div className="flex items-start gap-3 rounded-xl border border-border p-3">
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium text-foreground">Weekly goal updates</span>
            <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
              Once a week the team lead drafts an update for each active goal. Drafts wait in Needs
              you until you publish or discard them. It is a team routine: change its time or turn
              it off in Routines.
            </span>
          </span>
          {current.weeklyUpdatesRoutineId ? (
            <Button
              size="sm"
              variant="secondary"
              data-testid="home-weekly-manage"
              onClick={() => {
                onClose()
                useSettingsModalStore.getState().openSettings('routines')
              }}
            >
              <CalendarClock size={14} aria-hidden />
              In Routines
            </Button>
          ) : (
            <Button
              size="sm"
              variant="primary"
              loading={busy === 'weekly'}
              disabled={busy !== null}
              data-testid="home-weekly-on"
              onClick={() => void weekly()}
            >
              Turn on
            </Button>
          )}
        </div>
        <div className="flex items-start gap-3 rounded-xl border border-border p-3">
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium text-foreground">
              The lead writes the status line
            </span>
            <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
              Off, Home writes one sentence from the board&apos;s numbers and run costs. On, the
              team lead writes it in a short turn, only when the board changed, at most every 6
              hours and 4 times a day. Each costs a model call; Home names the lead and the model
              under the line.
            </span>
            {!current.leadCanWriteStatus ? (
              <span
                className="mt-1.5 block text-xs leading-relaxed text-foreground"
                data-testid="home-lead-cannot-write"
              >
                This team&apos;s lead cannot write it: an OpenClaw lead has no way to, and a team
                with no lead has nobody to. Home keeps writing the line from the board.
              </span>
            ) : null}
          </span>
          <Switch
            checked={current.leadWritesStatus}
            // A lead that cannot write the line is never offered it: turning it on would
            // be refused, so the switch says why instead. One already on can be turned off.
            disabled={busy !== null || (!current.leadCanWriteStatus && !current.leadWritesStatus)}
            onChange={(next) => void setLeadWrites(next)}
            label="The lead writes the status line"
          />
        </div>
      </div>
      <div className="flex items-center gap-2 border-t border-border px-5 py-3">
        <span className="flex-1" />
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      </div>
    </Modal>
  )
}
