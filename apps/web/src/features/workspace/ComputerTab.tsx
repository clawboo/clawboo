// The agent page's Computer tab: its screen, or its files.
//
// [Screen] is the agent's screen, live, with Take over and links (see
// features/computer). [Files] is the read-only file view (`WorkspacePanel`),
// unchanged; the task drawer mounts that panel on its own, pinned to one task,
// where an agent-wide screen does not belong.
//
// It opens on Screen while the agent has a browser or a display running, and on
// Files otherwise. Once someone picks one, it stays on their pick.

import { useEffect, useState } from 'react'
import { apiFetch } from '@clawboo/control-client'

import { ComputerLinks } from '@/features/computer/ComputerLinks'
import { DesktopToolsNotice, type DisplaysStatus } from '@/features/computer/DesktopToolsNotice'
import { ComputerScreen } from '@/features/computer/ComputerScreen'

import { WorkspacePanel } from './WorkspacePanel'

type View = 'screen' | 'files'

export function ComputerTab({ agentId }: { agentId: string }) {
  // null until the first answer, or until someone picks a view.
  const [view, setView] = useState<View | null>(null)
  const [displays, setDisplays] = useState<DisplaysStatus | null>(null)
  const [checks, setChecks] = useState(0)

  // A new agent starts from its own state; asking again after an install keeps
  // the view the person is on (it would otherwise drop back to the files).
  useEffect(() => {
    setView(null)
  }, [agentId])

  useEffect(() => {
    let cancelled = false
    void apiFetch(`/api/agents/${encodeURIComponent(agentId)}/computer`)
      .then(async (r) => {
        const body = r.ok
          ? ((await r.json()) as {
              display?: { running?: boolean }
              browserOpen?: boolean
              displays?: DisplaysStatus
            })
          : null
        if (cancelled) return
        setDisplays(body?.displays ?? null)
        const running = body?.display?.running === true || body?.browserOpen === true
        setView((v) => v ?? (running ? 'screen' : 'files'))
      })
      .catch(() => {
        if (!cancelled) setView((v) => v ?? 'files')
      })
    return () => {
      cancelled = true
    }
  }, [agentId, checks])

  const shown: View = view ?? 'files'
  const pick = (v: View) => setView(v)

  const tab = (v: View, label: string) => (
    <button
      type="button"
      role="tab"
      aria-selected={shown === v}
      onClick={() => pick(v)}
      className={[
        'rounded-md px-2 py-0.5 text-[12px]',
        shown === v
          ? 'bg-foreground/[0.08] text-foreground'
          : 'text-muted-foreground hover:text-foreground',
      ].join(' ')}
    >
      {label}
    </button>
  )

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="computer-tab">
      <div
        role="tablist"
        aria-label="Computer"
        className="flex shrink-0 gap-1 border-b border-border px-3 py-1.5"
      >
        {tab('screen', 'Screen')}
        {tab('files', 'Files')}
      </div>
      <div className="min-h-0 flex-1">
        {shown === 'screen' ? (
          <div className="flex h-full min-h-0 flex-col">
            <DesktopToolsNotice displays={displays} onInstalled={() => setChecks((n) => n + 1)} />
            <div className="min-h-0 flex-1">
              <ComputerScreen target={{ kind: 'dashboard', agentId }} />
            </div>
            <ComputerLinks agentId={agentId} />
          </div>
        ) : (
          <WorkspacePanel agentId={agentId} />
        )}
      </div>
    </div>
  )
}
