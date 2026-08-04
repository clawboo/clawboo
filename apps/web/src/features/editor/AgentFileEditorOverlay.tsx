import { AnimatePresence } from 'framer-motion'
import { AlertTriangle } from 'lucide-react'
import { useEditorStore } from '@/stores/editor'
import { Button } from '@/features/shared/Button'
import { LazyBoundary } from '@/features/shared/LazyBoundary'
import { createRetryableLazy } from '@/lib/lazyRetry'

// The editor pulls in the whole CodeMirror stack. This overlay is mounted
// eagerly by ContentArea but renders nothing until the user opens a file, so
// lazy-loading the editor itself keeps CodeMirror off the entry chunk.
//
// Retryable + boundary-wrapped: this overlay is a SIBLING of ContentArea's
// AnimatePresence, so it sits outside the per-view boundary. A failed CodeMirror
// chunk here would otherwise escape all the way to the root and blank the app.
const agentFileEditorSource = createRetryableLazy(() =>
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
        <LazyBoundary
          key={agentId}
          source={agentFileEditorSource}
          label="the file editor"
          // `null` fallback: the overlay animates in over the current view, so a
          // spinner would flash on top of it. The editor mounts once its chunk
          // resolves.
          suspenseFallback={null}
          render={(AgentFileEditor) => (
            <AgentFileEditor agentId={agentId} agentName={agentName} onClose={closeEditor} />
          )}
          logContext={{ surface: 'agent-file-editor', agentId }}
          // A bespoke fallback: the default panel card would tile the whole
          // content area behind this overlay. A small floating card that can be
          // dismissed puts the user straight back on a working dashboard.
          fallback={({ error, retry }) => (
            <div
              role="alert"
              data-testid="editor-error-boundary"
              className="fixed inset-0 z-50 flex items-center justify-center p-6"
              style={{ background: 'var(--overlay-scrim)' }}
            >
              <div className="surface-overlay-tier w-full max-w-[380px] rounded-2xl p-6 text-center">
                <AlertTriangle
                  size={22}
                  strokeWidth={1.75}
                  color="var(--amber)"
                  aria-hidden
                  style={{ margin: '0 auto' }}
                />
                <h1
                  className="mt-3 font-display text-[15px] font-bold text-foreground"
                  style={{ letterSpacing: '-0.01em' }}
                >
                  Couldn’t load the file editor.
                </h1>
                <p className="mt-1.5 text-[12px] leading-relaxed text-muted-foreground">
                  {error.message || error.name}
                </p>
                <div className="mt-4 flex items-center justify-center gap-2">
                  <Button variant="primary" size="sm" onClick={retry}>
                    Try again
                  </Button>
                  <Button variant="secondary" size="sm" onClick={closeEditor}>
                    Close
                  </Button>
                </div>
              </div>
            </div>
          )}
        />
      )}
    </AnimatePresence>
  )
}
