import { useCallback, useEffect, useState } from 'react'
import { Brain, ExternalLink, GitFork, List } from 'lucide-react'
import { GitHubStarButton } from '@/features/promo/GitHubStarButton'
import { useInSettingsModal } from '@/features/settings/settingsModalContext'
import { Button } from '@/features/shared/Button'
import { PanelHeader } from '@/features/shared/PanelHeader'
import { SegmentedControl } from '@/features/shared/SegmentedControl'
import { useSettingsModalStore } from '@/stores/settingsModal'
import { useViewStore } from '@/stores/view'
import { MemoryGraphView } from './graph/MemoryGraphView'
import { useMemoryGraphStore } from './graph/store'
import { countLabel } from './graph/types'
import { MemoryPanel } from './MemoryPanel'

// ─── MemorySurface — the NAV_PANELS['memory'] renderer ───────────────────────
//
// Memory deliberately lives in BOTH the sidebar and the Settings modal (see
// stores/settingsModal.ts). Inside the ~920×640 modal the canvas would be
// cramped, so the modal branch renders the list panel plus an "Open full view"
// escape hatch; the full-screen branch is the graph hero with a persisted
// Graph|List mode toggle (list = the unchanged MemoryPanel, which keeps its
// own header — the toggle slots into its actions so there is one header row).

type MemoryMode = 'graph' | 'list'

const MODE_KEY = 'clawboo.memory.mode'

function loadMode(): MemoryMode {
  try {
    return localStorage.getItem(MODE_KEY) === 'list' ? 'list' : 'graph'
  } catch {
    return 'graph'
  }
}

export function MemorySurface() {
  const inModal = useInSettingsModal()
  const [memoryMode, setMemoryMode] = useState<MemoryMode>(loadMode)
  const payload = useMemoryGraphStore((s) => s.payload)

  useEffect(() => {
    try {
      localStorage.setItem(MODE_KEY, memoryMode)
    } catch {
      // localStorage unavailable — mode just won't persist
    }
  }, [memoryMode])

  const openFullView = useCallback(() => {
    useSettingsModalStore.getState().close()
    useViewStore.getState().navigateTo('memory')
  }, [])

  if (inModal) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            padding: '10px 24px 0',
            flexShrink: 0,
          }}
        >
          <Button
            data-testid="memory-open-full"
            variant="secondary"
            size="sm"
            onClick={openFullView}
          >
            <ExternalLink size={13} strokeWidth={2} /> Open full view
          </Button>
        </div>
        <div style={{ flex: 1, minHeight: 0 }}>
          <MemoryPanel />
        </div>
      </div>
    )
  }

  const modeSegment = (
    <SegmentedControl<MemoryMode>
      options={[
        { id: 'graph', label: 'Graph', icon: GitFork },
        { id: 'list', label: 'List', icon: List },
      ]}
      value={memoryMode}
      onChange={setMemoryMode}
      size="sm"
      aria-label="Memory view mode"
    />
  )

  if (memoryMode === 'list') {
    return <MemoryPanel headerExtra={modeSegment} />
  }

  const subtitle = payload
    ? `${countLabel(payload.totalFacts, 'fact')} · ${countLabel(payload.totalProcedures, 'procedure')}`
    : 'The team’s shared knowledge'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <PanelHeader
        title="Memory"
        subtitle={subtitle}
        icon={Brain}
        border
        actions={
          <>
            {modeSegment}
            <GitHubStarButton />
          </>
        }
      />
      <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        <MemoryGraphView onOpenList={() => setMemoryMode('list')} />
      </div>
    </div>
  )
}
