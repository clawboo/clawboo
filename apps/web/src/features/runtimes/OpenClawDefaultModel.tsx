// The default model for OpenClaw-runtime agents — folded into the OpenClaw
// runtime row's Manage body. The System panel no longer carries a generic
// "Default Model" section: it only ever wrote openclaw.json's
// agents.defaults.model.primary (an OpenClaw-only setting), so sitting as a
// top-level "Default Model" it read like a cross-runtime global. Native keeps
// its own default-model pick on its provider row; per-agent overrides live in
// agent detail. This is strictly "the fallback model an OpenClaw agent uses
// when it has no per-agent model."

import { useCallback, useEffect, useState } from 'react'

import { ModelSelector } from '@/features/maintenance/ModelSelector'
import { useConnectionStore } from '@/stores/connection'
import { useToastStore } from '@/stores/toast'

const muted = (o: number) => `rgb(var(--foreground-rgb) / ${o})`

export function OpenClawDefaultModel() {
  const client = useConnectionStore((s) => s.client)
  const addToast = useToastStore((s) => s.addToast)
  const [currentModel, setCurrentModel] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let cancelled = false
    fetch('/api/system/openclaw-config')
      .then(
        (r) =>
          r.json() as Promise<{
            config?: { agents?: { defaults?: { model?: { primary?: string } } } }
          }>,
      )
      .then((data) => {
        if (cancelled) return
        setCurrentModel(data?.config?.agents?.defaults?.model?.primary ?? null)
        setLoaded(true)
      })
      .catch(() => {
        if (!cancelled) setLoaded(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const handleModelChange = useCallback(
    async (model: string) => {
      try {
        const res = await fetch('/api/system/openclaw-config', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model }),
        })
        if (!res.ok) throw new Error(`Server returned ${res.status}`)
        setCurrentModel(model)
        addToast({ message: 'Default model updated', type: 'success' })
        // Best-effort Gateway hot reload. OpenClaw 2026.5.x's config.patch needs
        // the snapshot hash (from config.get), and the model lives at
        // agents.defaults.model.primary (the config-file shape used above).
        if (client) {
          try {
            const snapshot = await client.config.get()
            const baseHash = (snapshot['hash'] ?? snapshot['baseHash']) as string | undefined
            await client.config.patch(
              { agents: { defaults: { model: { primary: model } } } },
              baseHash,
            )
          } catch {
            // hot reload failed — the config file was still updated
          }
        }
      } catch (err) {
        addToast({
          message: `Failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
          type: 'error',
        })
      }
    },
    [client, addToast],
  )

  if (!loaded) return null

  return (
    <div className="flex flex-col gap-2" data-testid="openclaw-default-model">
      <span
        className="font-mono text-[10px] uppercase tracking-widest"
        style={{ color: muted(0.5) }}
      >
        Default model
      </span>
      <div className="flex items-center gap-3">
        <ModelSelector currentModel={currentModel} onModelChange={handleModelChange} />
      </div>
      <p className="text-[11px] leading-relaxed" style={{ color: muted(0.4) }}>
        Used by all OpenClaw agents by default.
      </p>
    </div>
  )
}
