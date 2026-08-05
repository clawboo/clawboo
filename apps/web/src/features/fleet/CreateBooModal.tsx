import { useState, useCallback, useEffect, useId } from 'react'
import { useConnectionStore } from '@/stores/connection'
import { useTeamStore } from '@/stores/team'
import { createAgent } from '@/lib/createAgent'
import { mergeSoulWithPersonality, type PersonalityValues } from '@/lib/soulPersonality'
import { Button } from '@/features/shared/Button'
import { FormattedAlert } from '@/features/shared/FormattedAlert'
import { Modal } from '@/features/shared/Modal'

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
  const headingId = useId()
  const nameId = useId()
  const roleId = useId()

  // Reset the form each time the modal opens. Focusing the name input is NOT
  // done here any more: Modal's focus trap moves focus to the panel's first
  // focusable, which IS this input — and it does so without racing a timeout.
  useEffect(() => {
    if (isOpen) {
      setName('')
      setRole('')
      setError(null)
      setCreating(false)
    }
  }, [isOpen])

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
    <Modal
      open={isOpen}
      layer={50}
      labelledBy={headingId}
      // Cancel is already disabled while the create is in flight; without this
      // Escape and a scrim click would still call onClose, dismissing the dialog
      // while createAgent + the personality/team POSTs keep running — the user
      // would see the dialog vanish and the agent appear anyway. Mirrors
      // CreateTeamModal's `dismissible={step !== 'deploy'}`.
      dismissible={!creating}
      onClose={onClose}
      scrimClassName="backdrop-blur-sm"
      panelClassName="w-full max-w-md rounded-2xl border border-border bg-surface p-6"
      panelStyle={{ boxShadow: 'var(--shadow-overlay)' }}
      data-testid="create-boo-modal"
    >
      <h2
        id={headingId}
        className="mb-5 text-[17px] font-bold text-foreground"
        style={{ letterSpacing: '-0.01em' }}
      >
        Create a new Boo
      </h2>

      {/* Name */}
      <label
        htmlFor={nameId}
        className="mb-1.5 block font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground"
      >
        Name
      </label>
      <input
        id={nameId}
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
      <label
        htmlFor={roleId}
        className="mb-1.5 block font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground"
      >
        Role (optional)
      </label>
      <textarea
        id={roleId}
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
    </Modal>
  )
}
