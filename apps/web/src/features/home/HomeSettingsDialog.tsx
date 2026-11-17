// A team's Home switches: weekly goal updates (a normal team routine that asks the
// lead to draft an update for each active goal), and the lead-written status line
// (off by default, because it costs model calls).

import { useState } from 'react'
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
  const [busy, setBusy] = useState<'lead' | 'weekly' | null>(null)

  async function setLeadWrites(next: boolean) {
    setBusy('lead')
    const saved = await homeWrite('save the setting', () =>
      updateTeamHomeSettings(teamId, { leadWritesStatus: next }),
    )
    setBusy(null)
    if (saved) onChanged(saved)
  }

  async function weekly() {
    setBusy('weekly')
    const result = await homeWrite('turn on weekly updates', () => turnOnWeeklyUpdates(teamId), {
      success: 'Weekly updates are on. The lead drafts them; you publish them.',
    })
    setBusy(null)
    if (result) onChanged(result.settings)
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
          {settings.weeklyUpdatesRoutineId ? (
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
              Off, Home writes one sentence from the board&apos;s numbers. On, the team lead writes
              it in a short turn, only when the board changed, at most every 6 hours and 4 times a
              day. Each costs a model call; Home shows the model and run behind it.
            </span>
          </span>
          <Switch
            checked={settings.leadWritesStatus}
            disabled={busy === 'lead'}
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
