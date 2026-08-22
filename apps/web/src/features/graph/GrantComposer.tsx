// GrantComposer — the J4 "share with a second agent" dialog.
//
// Opens from the graph's `onConnect` when a grant-backed connector tile is
// dragged onto another Boo. Least-privilege defaults on purpose: `read` and
// "ask on risky calls" are one click to accept, escalation is a deliberate act.
// The quiet line under the title carries the one fact people get wrong about
// sharing: the target gets its OWN grant, the source's access is untouched.

import { useState } from 'react'
import { Modal } from '@/features/shared/Modal'
import { Button } from '@/features/shared/Button'
import { useGraphStore } from './store'
import { grantConnectorToAgent, type GrantConnectorRequest } from './operations/grantConnector'

type Mode = GrantConnectorRequest['mode']

const MODES: { id: Mode; label: string; blurb: string }[] = [
  { id: 'read', label: 'Read', blurb: 'Look things up. Nothing changes.' },
  { id: 'write', label: 'Write', blurb: 'Create and update. Risky calls ask first.' },
  { id: 'admin', label: 'Admin', blurb: 'Settings and deletion too. Use sparingly.' },
]

/** Verb names the mode, so the button restates the decision being made. */
function primaryLabel(mode: Mode): string {
  if (mode === 'read') return 'Grant read access'
  if (mode === 'write') return 'Grant write access'
  return 'Grant admin access'
}

export function GrantComposer() {
  const state = useGraphStore((s) => s.grantComposer)
  const setState = useGraphStore((s) => s.setGrantComposer)
  const [mode, setMode] = useState<Mode>('read')
  const [busy, setBusy] = useState(false)

  if (!state) return null

  const close = () => {
    if (busy) return
    setState(null)
    setMode('read')
  }

  const confirm = async () => {
    setBusy(true)
    const ok = await grantConnectorToAgent(
      {
        capabilityId: state.capabilityId,
        connectorId: state.connectorId,
        targetAgentId: state.targetAgentId,
        mode,
        approvalPolicy: 'risk',
      },
      { connectorName: state.connectorName, targetAgentName: state.targetAgentName },
    )
    setBusy(false)
    if (ok) {
      setState(null)
      setMode('read')
    }
    // On failure the dialog stays open: the toast said what went wrong, and
    // closing would discard the user's mode choice along with it.
  }

  return (
    <Modal
      open
      onClose={close}
      dismissible={!busy}
      label={`Share ${state.connectorName} with ${state.targetAgentName}`}
      panelClassName="w-[420px] max-w-[calc(100vw-48px)] rounded-2xl p-5"
    >
      <h2 className="text-base font-semibold text-foreground">
        Share {state.connectorName} with {state.targetAgentName}
      </h2>
      <p className="mt-1 text-xs text-muted-foreground">
        {state.targetAgentName} gets its own grant. {state.sourceAgentName}&rsquo;s access does not
        change.
      </p>

      <div role="radiogroup" aria-label="Access mode" className="mt-4 flex flex-col gap-2">
        {MODES.map((m) => (
          <label
            key={m.id}
            className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition-colors ${
              mode === m.id ? 'border-border-strong bg-surface-raised' : 'border-border'
            }`}
          >
            <input
              type="radio"
              name="grant-mode"
              value={m.id}
              checked={mode === m.id}
              onChange={() => setMode(m.id)}
              className="mt-0.5"
            />
            <span>
              <span className="block text-sm font-medium text-foreground">{m.label}</span>
              <span className="block text-xs text-muted-foreground">{m.blurb}</span>
            </span>
          </label>
        ))}
      </div>

      <div className="mt-5 flex justify-end gap-2">
        <Button variant="secondary" onClick={close} disabled={busy}>
          Cancel
        </Button>
        <Button variant="primary" onClick={confirm} loading={busy}>
          {primaryLabel(mode)}
        </Button>
      </div>
    </Modal>
  )
}
