'use client'

import { useState, useCallback, useEffect, useRef, type KeyboardEvent } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Loader2 } from 'lucide-react'
import { useConnectionStore } from '@/stores/connection'
import { resolveWorkspaceDir, createAgent } from '@/lib/createAgent'

const DEFAULT_SOUL = `# SOUL\n\nYou are a helpful AI assistant. You approach tasks methodically, communicate clearly, and ask for clarification when needed.`

export function CreateBooModal({
  isOpen,
  onClose,
  onCreated,
}: {
  isOpen: boolean
  onClose: () => void
  onCreated: () => void
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
      const workspaceDir = await resolveWorkspaceDir(client)
      await createAgent(client, trimmedName, workspaceDir, {
        soul: role.trim() || DEFAULT_SOUL,
        identity: `# IDENTITY\n\nYou are ${trimmedName}.`,
        tools: '# TOOLS\n',
      })
      onCreated()
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
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
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
            className="w-full max-w-md rounded-2xl border border-white/10 bg-background p-6 shadow-2xl"
          >
            <h2
              className="mb-5 text-[16px] font-semibold text-text"
              style={{ fontFamily: 'var(--font-display)' }}
            >
              Create a new Boo
            </h2>

            {/* Name */}
            <label className="mb-1 block text-[11px] font-medium uppercase tracking-widest text-secondary">
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
              className="mb-4 w-full rounded-lg border border-white/10 bg-surface px-3 py-2 text-[13px] text-text outline-none transition placeholder:text-secondary/40 focus:border-white/20 focus:ring-1 focus:ring-ring/30"
              style={{ fontFamily: 'var(--font-body)' }}
            />

            {/* Role */}
            <label className="mb-1 block text-[11px] font-medium uppercase tracking-widest text-secondary">
              Role (optional)
            </label>
            <textarea
              value={role}
              onChange={(e) => setRole(e.target.value)}
              rows={4}
              placeholder="What should this Boo do?"
              className="mb-4 w-full resize-none rounded-lg border border-white/10 bg-surface px-3 py-2 text-[13px] text-text outline-none transition placeholder:text-secondary/40 focus:border-white/20 focus:ring-1 focus:ring-ring/30"
              style={{ fontFamily: 'var(--font-body)' }}
            />

            {/* Error */}
            {error && <p className="mb-3 text-[12px] text-destructive">{error}</p>}

            {/* Actions */}
            <div className="flex items-center justify-end gap-3">
              <button
                type="button"
                onClick={onClose}
                disabled={creating}
                className="rounded-lg px-4 py-2 text-[13px] font-medium text-secondary transition-colors hover:text-text disabled:opacity-40"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleSubmit()}
                disabled={!name.trim() || creating}
                className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-[13px] font-semibold text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {creating && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                Create Boo
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
