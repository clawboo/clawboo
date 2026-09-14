import { useCallback, useEffect, useState } from 'react'
import { Terminal } from 'lucide-react'

import { apiFetch } from '@clawboo/control-client'
import { Switch } from '@/features/shared/Switch'
import { confirm } from '@/stores/confirm'
import { useToastStore } from '@/stores/toast'

// ─── NativeShellSettings ───────────────────────────────────────────────────
// Whether a clawboo-native Boo may ASK to run shell commands.
//
// THE COPY IS THE FEATURE HERE. The switch does not decide whether commands run:
// every single one is put in front of a person, there is no allowlist, and
// nothing is remembered. A label reading "Allow shell access" would be read as
// handing over the machine, and a label reading "Safe" would be a lie. It says
// what actually changes, which is whether the Boo may ask at all.
//
// The confirmation exists for the same reason. Turning this on is the moment a
// Boo goes from reading and writing files inside its own folder to being able to
// propose running programs, and that deserves one deliberate click rather than a
// toggle someone flips while scanning a settings page.

interface Props {
  agentId: string
}

export function NativeShellSettings({ agentId }: Props) {
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)
  const addToast = useToastStore((s) => s.addToast)

  useEffect(() => {
    let alive = true
    setEnabled(null)
    void apiFetch(`/api/agents/${encodeURIComponent(agentId)}/shell`)
      .then(async (r) => {
        // THROW on a non-2xx rather than falling through. `apiFetch` resolves on
        // any status, so the previous shape turned a transient server failure
        // into `enabled: false`: a Boo that CAN ask to run commands, shown as
        // one that cannot. An unreadable setting is not an off setting.
        if (!r.ok) throw new Error(`could not read the shell setting (${r.status})`)
        return (await r.json()) as { enabled?: boolean }
      })
      .then((body) => {
        if (alive) setEnabled(body?.enabled === true)
      })
      .catch(() => {
        // Left in its loading state, which renders nothing, rather than showing
        // a switch whose position would be a guess.
      })
    return () => {
      alive = false
    }
  }, [agentId])

  const change = useCallback(
    async (next: boolean) => {
      if (next) {
        const ok = await confirm({
          title: 'Let this Boo ask to run commands?',
          message:
            'It will be able to propose running programs on this computer. You are asked to approve every command before it runs, and nothing is remembered, so you will see each one.',
          confirmLabel: 'Allow it to ask',
          tone: 'danger',
        })
        if (!ok) return
      }

      setBusy(true)
      try {
        const res = await apiFetch(`/api/agents/${encodeURIComponent(agentId)}/shell`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: next }),
        })
        const body = (await res.json().catch(() => null)) as {
          enabled?: boolean
          error?: string
        } | null
        if (!res.ok) {
          addToast({ message: body?.error ?? 'Could not change that setting', type: 'error' })
          return
        }
        // THE STORED VALUE, not the requested one. The route reads back after
        // writing, so this reflects what is actually in force.
        setEnabled(body?.enabled === true)
        addToast({ message: 'Saved', type: 'success' })
      } catch {
        addToast({ message: 'clawboo could not be reached', type: 'error' })
      } finally {
        setBusy(false)
      }
    },
    [agentId, addToast],
  )

  if (enabled === null) return null

  return (
    <div>
      <div className="mb-2 flex items-center gap-1.5">
        <Terminal size={14} strokeWidth={2} style={{ color: 'var(--amber)' }} />
        <span className="text-[12px] font-semibold text-foreground">Running commands</span>
      </div>

      <div
        className="rounded-2xl border border-border bg-surface p-4"
        style={{ boxShadow: 'var(--shadow-raised)' }}
      >
        <label className="flex cursor-pointer items-start justify-between gap-4">
          <span className="flex flex-col gap-1">
            <span className="text-[12.5px] font-medium text-foreground">
              Let this Boo ask to run commands
            </span>
            <span className="text-[11.5px] leading-relaxed text-muted-foreground">
              You are asked before every command. Nothing is remembered, so a command you allowed
              once will ask again the next time.
            </span>
          </span>
          <Switch
            checked={enabled}
            disabled={busy}
            onChange={(next) => void change(next)}
            label="Let this Boo ask to run commands"
          />
        </label>

        {enabled && (
          <p className="mt-3 border-t border-border pt-2.5 text-[11px] leading-relaxed text-muted-foreground">
            Commands run in this Boo&apos;s working folder, as you, with access to the network. One
            program at a time: it cannot use pipes, redirects, or a shell.
          </p>
        )}
      </div>
    </div>
  )
}
