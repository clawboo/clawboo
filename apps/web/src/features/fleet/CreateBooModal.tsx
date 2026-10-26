import { useState, useCallback, useEffect, useId } from 'react'
import { apiFetch, fetchRegistryHealth } from '@clawboo/control-client'
import { useTeamStore } from '@/stores/team'
import { createAgent } from '@/lib/createAgent'
import { agentSourceFor, type DefaultAgentSource } from '@/lib/defaultAgentSource'
import {
  DEFAULT_PERSONALITY as SHIPPED_DEFAULT_PERSONALITY,
  mergeSoulWithPersonality,
  type PersonalityValues,
} from '@/lib/soulPersonality'
import { Button } from '@/features/shared/Button'
import { FormattedAlert } from '@/features/shared/FormattedAlert'
import { Modal } from '@/features/shared/Modal'

const DEFAULT_SOUL = `# SOUL\n\nYou are a helpful AI assistant. You approach tasks methodically, communicate clearly, and ask for clarification when needed.`

// One shared default so the three creation paths cannot drift apart.
const DEFAULT_PERSONALITY: PersonalityValues = SHIPPED_DEFAULT_PERSONALITY

const RUNTIME_HINT: Record<DefaultAgentSource, string> = {
  openclaw: 'Runs on OpenClaw, through your Gateway.',
  'clawboo-native': 'Runs on Clawboo Native: no OpenClaw Gateway is connected.',
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

  // WHICH RUNTIME, SAID BEFORE IT IS CHOSEN. OpenClaw while the server's
  // Gateway connection is up, otherwise Clawboo Native (see defaultAgentSource).
  // The server's state is read once per open, and until it answers there is no
  // hint. What the hint says is what the Boo gets.
  const [serverGateway, setServerGateway] = useState<boolean | null>(null)
  useEffect(() => {
    if (!isOpen) return
    let live = true
    setServerGateway(null)
    void fetchRegistryHealth().then((h) => {
      if (live) setServerGateway(h.connection === 'connected')
    })
    return () => {
      live = false
    }
  }, [isOpen])
  const runtime: DefaultAgentSource | null =
    serverGateway === null ? null : agentSourceFor(serverGateway)

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

    setCreating(true)
    setError(null)

    try {
      const baseSoul = role.trim() || DEFAULT_SOUL
      const soulWithPersonality = mergeSoulWithPersonality(baseSoul, DEFAULT_PERSONALITY)

      // The runtime the hint names; a submit before the server answered waits
      // for it, so a Boo can be made on an install with no Gateway at all.
      const sourceId =
        runtime ?? agentSourceFor((await fetchRegistryHealth()).connection === 'connected')
      const agentId = await createAgent(
        trimmedName,
        {
          soul: soulWithPersonality,
          identity: `# IDENTITY\n\nYou are ${trimmedName}.`,
          tools: '# TOOLS\n',
        },
        sourceId,
      )

      // Persist default personality to SQLite so sliders load correctly
      void apiFetch('/api/personality', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId, values: DEFAULT_PERSONALITY }),
      }).catch(() => {})

      // Assign to currently selected team (best-effort)
      const selectedTeamId = useTeamStore.getState().selectedTeamId
      if (selectedTeamId) {
        try {
          await apiFetch(`/api/teams/${selectedTeamId}/agents`, {
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
  }, [name, role, creating, runtime, onCreated, onClose])

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

      {runtime && (
        <p
          data-testid="create-boo-runtime"
          className="-mt-1 mb-4 text-[12px] text-muted-foreground"
        >
          {RUNTIME_HINT[runtime]}
        </p>
      )}

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
