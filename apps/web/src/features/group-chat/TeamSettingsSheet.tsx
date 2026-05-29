// TeamSettingsSheet — modal that owns the per-team brief + per-team rules.
//
// Opened from the gear icon on `GroupChatViewHeader`. Hosts two editors
// stacked vertically: `TeamBriefForm` (per-team brief, read by Boo Zero
// when working in this team) and `TeamRulesEditor` (durable user-set rules
// injected into every team-agent preamble + every Boo Zero turn in this
// team).

import { useCallback, useEffect } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { X } from 'lucide-react'
import type { Team } from '@/stores/team'
import { TeamBriefForm } from './TeamBriefForm'
import { TeamRulesEditor } from './TeamRulesEditor'

interface TeamSettingsSheetProps {
  team: Team
  onClose: () => void
}

export function TeamSettingsSheet({ team, onClose }: TeamSettingsSheetProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const onBackdropClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (e.target === e.currentTarget) onClose()
    },
    [onClose],
  )

  return (
    <AnimatePresence>
      <motion.div
        key="team-settings-backdrop"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.15 }}
        onClick={onBackdropClick}
        data-testid="team-settings-backdrop"
        className="fixed inset-0 z-[60] flex items-center justify-center bg-foreground/55 p-6 backdrop-blur-sm"
      >
        <motion.div
          key="team-settings-panel"
          initial={{ opacity: 0, y: 8, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 8, scale: 0.98 }}
          transition={{ duration: 0.18 }}
          data-testid="team-settings-sheet"
          className="surface-overlay-tier flex max-h-[85vh] w-[min(720px,100%)] flex-col overflow-hidden rounded-xl"
        >
          {/* Header */}
          <div className="flex items-center gap-3 border-b border-border px-4 py-3.5">
            <span
              className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-[15px]"
              style={{ background: `${team.color}22` }}
            >
              {team.icon}
            </span>
            <div className="min-w-0 flex-1">
              <h2
                className="m-0 text-[14px] font-semibold text-foreground"
                style={{ fontFamily: 'var(--font-body, sans-serif)' }}
              >
                {team.name} — Settings
              </h2>
              <p className="m-0 mt-0.5 text-[10px] text-foreground/45">
                Brief + rules read on every turn by team agents and Boo Zero.
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close team settings"
              data-testid="team-settings-close"
              className="inline-flex h-7 w-7 cursor-pointer items-center justify-center rounded-md border-none bg-transparent text-foreground/60 hover:bg-foreground/[0.06]"
            >
              <X size={16} />
            </button>
          </div>

          {/* Body — scrollable */}
          <div className="flex flex-1 flex-col gap-6 overflow-y-auto p-[18px]">
            <section className="flex flex-col gap-2">
              <h3 className="m-0 text-[12px] font-semibold text-foreground/85">Brief</h3>
              <TeamBriefForm
                teamId={team.id}
                teamName={team.name}
                teamIcon={team.icon}
                templateId={team.templateId ?? null}
              />
            </section>

            <section className="flex flex-col gap-2">
              <h3 className="m-0 text-[12px] font-semibold text-foreground/85">Rules</h3>
              <TeamRulesEditor teamId={team.id} />
            </section>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  )
}
