// TeamSettingsSheet — modal that owns the per-team brief + per-team rules.
//
// Opened from the gear icon on `GroupChatViewHeader`. Hosts two editors
// stacked vertically: `TeamBriefForm` (per-team brief, read by Boo Zero
// when working in this team) and `TeamRulesEditor` (durable user-set rules
// injected into every team-agent preamble + every Boo Zero turn in this
// team).
//
// Before this sheet existed, both editors lived inside the System-panel
// Boo Zero section — semantically wrong (team-scoped data under a
// system/agent surface) and hard to discover. Now they live with the team.

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
  // Esc closes the sheet.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // Click on the dark backdrop closes; clicks inside the panel don't bubble.
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
        style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(0,0,0,0.55)',
          zIndex: 60,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 24,
        }}
      >
        <motion.div
          key="team-settings-panel"
          initial={{ opacity: 0, y: 8, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 8, scale: 0.98 }}
          transition={{ duration: 0.18 }}
          data-testid="team-settings-sheet"
          style={{
            width: 'min(720px, 100%)',
            maxHeight: '85vh',
            background: '#0d1117',
            border: '1px solid rgba(255,255,255,0.08)',
            borderRadius: 12,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
          }}
        >
          {/* Header */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              padding: '14px 16px',
              borderBottom: '1px solid rgba(255,255,255,0.06)',
            }}
          >
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 28,
                height: 28,
                borderRadius: 8,
                background: `${team.color}22`,
                fontSize: 15,
              }}
            >
              {team.icon}
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <h2
                style={{
                  margin: 0,
                  fontSize: 14,
                  fontWeight: 600,
                  color: '#E8E8E8',
                  fontFamily: 'var(--font-body, sans-serif)',
                }}
              >
                {team.name} — Settings
              </h2>
              <p
                style={{
                  margin: '2px 0 0',
                  fontSize: 10,
                  color: 'rgba(232,232,232,0.45)',
                }}
              >
                Brief + rules read on every turn by team agents and Boo Zero.
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close team settings"
              data-testid="team-settings-close"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 28,
                height: 28,
                borderRadius: 6,
                border: 'none',
                background: 'transparent',
                color: 'rgba(232,232,232,0.6)',
                cursor: 'pointer',
              }}
            >
              <X size={16} />
            </button>
          </div>

          {/* Body — scrollable */}
          <div
            style={{
              flex: 1,
              overflowY: 'auto',
              padding: 18,
              display: 'flex',
              flexDirection: 'column',
              gap: 24,
            }}
          >
            <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <h3
                style={{
                  margin: 0,
                  fontSize: 12,
                  fontWeight: 600,
                  color: 'rgba(232,232,232,0.85)',
                }}
              >
                Brief
              </h3>
              <TeamBriefForm
                teamId={team.id}
                teamName={team.name}
                teamIcon={team.icon}
                templateId={team.templateId ?? null}
              />
            </section>

            <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <h3
                style={{
                  margin: 0,
                  fontSize: 12,
                  fontWeight: 600,
                  color: 'rgba(232,232,232,0.85)',
                }}
              >
                Rules
              </h3>
              <TeamRulesEditor teamId={team.id} />
            </section>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  )
}
