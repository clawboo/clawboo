import { useState, useCallback, useEffect, useRef, type KeyboardEvent } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { useConnectionStore } from '@/stores/connection'
import { useTeamStore } from '@/stores/team'
import { createAgent } from '@/lib/createAgent'
import { mergeSoulWithPersonality, type PersonalityValues } from '@/lib/soulPersonality'
import { Button } from '@/features/shared/Button'
import { FormattedAlert } from '@/features/shared/FormattedAlert'

const DEFAULT_SOUL = `# SOUL\n\nYou are a helpful AI assistant. You approach tasks methodically, communicate clearly, and ask for clarification when needed.`

const DEFAULT_PERSONALITY: PersonalityValues = {
  verbosity: 50,
  humor: 50,
  caution: 50,
  speed_cost: 50,
  formality: 50,
}

export function CreateBooModal({
  isOpen,
  onClose,
  onCreated,
}: {
  isOpen: boolean
  onClose: () => void
  onCreated: (agentId?: string) => void
}) {
  const [name, setName] = useState('')
  const [role, setRole] = useState('')
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const nameRef = useRef<HTMLInputElement>(null)

  // Focus name input on open
  useEffect(() => {
    if (isOpen) {
      setName('')
      setRole('')
      setError(null)
      setCreating(false)
      setTimeout(() => nameRef.current?.focus(), 100)
    }
  }, [isOpen])

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    },
    [onClose],
  )

  const handleSubmit = useCallback(async () => {
    const trimmedName = name.trim()
    if (!trimmedName || creating) return

    const client = useConnectionStore.getState().client
    if (!client) {
      setError('Not connected to Gateway.')
      return
    }

    setCreating(true)
    setError(null)

    try {
      const baseSoul = role.trim() || DEFAULT_SOUL
      const soulWithPersonality = mergeSoulWithPersonality(baseSoul, DEFAULT_PERSONALITY)

      const agentId = await createAgent(trimmedName, {
        soul: soulWithPersonality,
        identity: `# IDENTITY\n\nYou are ${trimmedName}.`,
        tools: '# TOOLS\n',
      })

      // Persist default personality to SQLite so sliders load correctly
      void fetch('/api/personality', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId, values: DEFAULT_PERSONALITY }),
      }).catch(() => {})

      // Assign to currently selected team (best-effort)
      const selectedTeamId = useTeamStore.getState().selectedTeamId
      if (selectedTeamId) {
        try {
          await fetch(`/api/teams/${selectedTeamId}/agents`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ agentId }),
          })
        } catch {
          // non-fatal — agent created but not assigned to team
        }
      }

      onCreated(agentId)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create agent.')
    } finally {
      setCreating(false)
    }
  }, [name, role, creating, onCreated, onClose])

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          key="create-boo-overlay"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          className="fixed inset-0 z-50 flex items-center justify-center backdrop-blur-sm"
          style={{ background: 'var(--overlay-scrim)' }}
          onKeyDown={handleKeyDown}
          onClick={(e) => {
            if (e.target === e.currentTarget) onClose()
          }}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.92, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.92, y: 20 }}
            transition={{ type: 'spring', damping: 28, stiffness: 360 }}
            className="w-full max-w-md rounded-2xl border border-border bg-surface p-6"
            style={{ boxShadow: 'var(--shadow-overlay)' }}
          >
            <h2 className="mb-5 text-[17px] font-bold text-foreground" style={{ letterSpacing: '-0.01em' }}>
              Create a new Boo
            </h2>

            {/* Name */}
            <label className="mb-1.5 block font-mono text-[11px] uppercase tracking-[0.14em] text-foreground/45">
              Name
            </label>
            <input
              ref={nameRef}
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Research Boo"
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleSubmit()
              }}
              className="mb-4 w-full rounded-xl border border-border bg-surface px-4 py-3 text-[14px] text-foreground outline-none transition placeholder:text-foreground/30 focus:border-primary focus:ring-4 focus:ring-primary/15"
            />

            {/* Role */}
            <label className="mb-1.5 block font-mono text-[11px] uppercase tracking-[0.14em] text-foreground/45">
              Role (optional)
            </label>
            <textarea
              value={role}
              onChange={(e) => setRole(e.target.value)}
              rows={4}
              placeholder="What should this Boo do?"
              className="mb-4 w-full resize-none rounded-xl border border-border bg-surface px-4 py-3 text-[14px] text-foreground outline-none transition placeholder:text-foreground/30 focus:border-primary focus:ring-4 focus:ring-primary/15"
            />

            {/* Error */}
            {error && (
              <div className="mb-3">
                <FormattedAlert tone="error">{error}</FormattedAlert>
              </div>
            )}

            {/* Actions */}
            <div className="flex items-center justify-end gap-3">
              <Button variant="ghost" onClick={onClose} disabled={creating}>
                Cancel
              </Button>
              <Button
                variant="primary"
                onClick={() => void handleSubmit()}
                disabled={!name.trim()}
                loading={creating}
              >
                Create Boo
              </Button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
