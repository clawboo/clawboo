import { AnimatePresence } from 'framer-motion'
import { useEditorStore } from '@/stores/editor'
import { AgentFileEditor } from './AgentFileEditor'

export function AgentFileEditorOverlay() {
  const isOpen = useEditorStore((s) => s.isOpen)
  const agentId = useEditorStore((s) => s.agentId)
  const agentName = useEditorStore((s) => s.agentName)
  const closeEditor = useEditorStore((s) => s.closeEditor)

  return (
    <AnimatePresence>
      {isOpen && agentId && agentName && (
        <AgentFileEditor
          key={agentId}
          agentId={agentId}
          agentName={agentName}
          onClose={closeEditor}
        />
      )}
    </AnimatePresence>
  )
}
