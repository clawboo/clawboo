// DisplayNameEditor — the override that controls how Boo Zero refers to
// itself in chat. Stored in SQLite via `/api/boo-zero/display-name/:agentId`
// and overlaid on the fleet entry at hydration time (see GatewayBootstrap).
//
// Saving also fires an auto-sync to the Gateway-side SOUL.md heading
// (best-effort) so the LLM's persisted identity aligns with the override.
// The per-turn rules block in `lib/booZeroRules.ts` is the authoritative
// anchor either way.
//
// Lives under `features/boo-zero/` because the editor is Boo-Zero-agent-
// scoped. Rendered by the Boo Zero individual agent's `Brief` tab in
// `InlineEditor`. (Also re-exported for the System breadcrumb to point at.)

import { useCallback, useState } from 'react'
import { Save } from 'lucide-react'
import { Button } from '@/features/shared/Button'
import { useConnectionStore } from '@/stores/connection'
import { useToastStore } from '@/stores/toast'
import { syncBooZeroSoulIdentity } from '@/lib/booZeroIdentitySync'

export function DisplayNameEditor({
  agentId,
  currentName,
}: {
  agentId: string
  currentName: string
}) {
  const [value, setValue] = useState<string>(currentName)
  const [saving, setSaving] = useState<boolean>(false)
  const isDirty = value.trim() !== currentName.trim()
  const client = useConnectionStore((s) => s.client)

  const handleSave = useCallback(async () => {
    const trimmed = value.trim() || 'Boo Zero'
    setSaving(true)
    try {
      const res = await fetch(`/api/boo-zero/display-name/${encodeURIComponent(agentId)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmed }),
      })
      if (!res.ok) throw new Error('Save failed')

      // Auto-sync the new display name into Boo Zero's SOUL.md. The user's
      // act of pressing Save IS the approval — they don't need a separate
      // sync button. Best-effort (Gateway `agents.files.set('SOUL.md')` is
      // documented unreliable); the per-turn rules block remains the
      // authoritative identity surface either way.
      if (client) {
        void syncBooZeroSoulIdentity({ agentId, displayName: trimmed })
      }
      useToastStore.getState().addToast({
        type: 'success',
        message: `Boo Zero display name → "${trimmed}". Reload to apply across all views.`,
      })
    } catch (e) {
      useToastStore
        .getState()
        .addToast({ type: 'error', message: (e as Error).message ?? 'Save failed' })
    } finally {
      setSaving(false)
    }
  }, [agentId, client, value])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <p style={{ fontSize: 11, color: 'rgb(var(--foreground-rgb) / 0.45)', margin: 0 }}>
        How Boo Zero refers to itself in chats. Defaults to <code>Boo Zero</code>. Stored in
        Clawboo&apos;s SQLite. Saving automatically syncs the heading of Boo Zero&apos;s
        <code> SOUL.md</code> too (best-effort — the per-turn rules block stays authoritative either
        way).
      </p>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <input
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Boo Zero"
          maxLength={80}
          disabled={saving}
          style={{
            flex: 1,
            height: 30,
            padding: '0 10px',
            fontSize: 12,
            fontFamily: 'var(--font-body, sans-serif)',
            background: 'var(--input)',
            color: 'var(--foreground)',
            border: '1px solid var(--border)',
            borderRadius: 6,
          }}
        />
        <Button
          variant="primary"
          size="sm"
          disabled={!isDirty || saving || value.trim().length === 0}
          loading={saving}
          onClick={handleSave}
        >
          <Save size={12} strokeWidth={2} />
          Save
        </Button>
      </div>
      {isDirty && (
        <span style={{ fontSize: 10, color: 'var(--amber)' }}>
          Unsaved — save and reload to apply.
        </span>
      )}
    </div>
  )
}
