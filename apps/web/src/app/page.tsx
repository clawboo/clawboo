'use client'

import { GhostGraphPanel } from '@/features/graph/GhostGraphPanel'
import { ChatPanel } from '@/features/chat/ChatPanel'
import { SchedulerPanel } from '@/features/scheduler/SchedulerPanel'
import { ApprovalsPanel } from '@/features/approvals/ApprovalsPanel'
import { CostDashboard } from '@/app/cost/CostDashboard'
import { MarketplacePanel } from '@/features/marketplace/MarketplacePanel'
import { useApprovalsStore } from '@/stores/approvals'
import { useViewStore } from '@/stores/view'
import type { View } from '@/stores/view'

const TABS: { id: View; label: string }[] = [
  { id: 'graph', label: '👻 Ghost Graph' },
  { id: 'chat', label: '💬 Chat' },
  { id: 'scheduler', label: '⏰ Scheduler' },
  { id: 'approvals', label: '🔐 Approvals' },
  { id: 'cost', label: '💰 Cost' },
  { id: 'marketplace', label: '🛒 Marketplace' },
]

export default function Home() {
  const view = useViewStore((s) => s.view)
  const setView = useViewStore((s) => s.setView)
  const pendingApprovals = useApprovalsStore((s) => s.pendingApprovals)
  const approvalCount = pendingApprovals.size

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* View toggle tab bar */}
      <div
        style={{
          height: 40,
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          padding: '0 12px',
          borderBottom: '1px solid rgba(255,255,255,0.06)',
        }}
      >
        {TABS.map((tab) => {
          const badge = tab.id === 'approvals' && approvalCount > 0 ? approvalCount : 0
          return (
            <button
              key={tab.id}
              onClick={() => setView(tab.id)}
              style={{
                position: 'relative',
                background: view === tab.id ? 'rgba(233,69,96,0.12)' : 'transparent',
                border:
                  view === tab.id ? '1px solid rgba(233,69,96,0.28)' : '1px solid transparent',
                borderRadius: 6,
                color: view === tab.id ? '#E94560' : 'rgba(232,232,232,0.45)',
                cursor: 'pointer',
                fontSize: 12,
                fontWeight: 500,
                padding: '3px 12px',
                transition: 'all 0.15s',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
              }}
            >
              {tab.label}
              {badge > 0 && (
                <span
                  style={{
                    background: '#FBBF24',
                    color: '#0A0E1A',
                    fontSize: 9,
                    fontWeight: 700,
                    borderRadius: 10,
                    padding: '1px 5px',
                    lineHeight: 1.5,
                  }}
                >
                  {badge}
                </span>
              )}
            </button>
          )
        })}
      </div>

      {/* Main content */}
      <div
        style={{
          flex: 1,
          overflow: 'hidden',
          display: view === 'chat' ? 'flex' : 'block',
          flexDirection: 'column',
        }}
      >
        {view === 'graph' && <GhostGraphPanel />}
        {view === 'chat' && <ChatPanel />}
        {view === 'scheduler' && <SchedulerPanel />}
        {view === 'approvals' && <ApprovalsPanel />}
        {view === 'cost' && <CostDashboard />}
        {view === 'marketplace' && <MarketplacePanel />}
      </div>
    </div>
  )
}
