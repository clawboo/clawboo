import { lazy, Suspense } from 'react'
import { AnimatePresence } from 'framer-motion'
import { useEditorStore } from '@/stores/editor'

// The editor pulls in the whole CodeMirror stack. This overlay is mounted
// eagerly by ContentArea but renders nothing until the user opens a file, so
// lazy-loading the editor itself keeps CodeMirror off the entry chunk.
const AgentFileEditor = lazy(() =>
  import('./AgentFileEditor').then((m) => ({ default: m.AgentFileEditor })),
)

export function AgentFileEditorOverlay() {
  const isOpen = useEditorStore((s) => s.isOpen)
  const agentId = useEditorStore((s) => s.agentId)
  const agentName = useEditorStore((s) => s.agentName)
  const closeEditor = useEditorStore((s) => s.closeEditor)

  return (
    <AnimatePresence>
      {isOpen && agentId && agentName && (
        // `null` fallback: the overlay animates in over the current view, so a
        // spinner would flash on top of it. The editor mounts once its chunk
        // resolves.
        <Suspense key={agentId} fallback={null}>
          <AgentFileEditor agentId={agentId} agentName={agentName} onClose={closeEditor} />
        </Suspense>
      )}
    </AnimatePresence>
  )
}
