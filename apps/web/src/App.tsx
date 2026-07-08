import { Providers } from './app/providers'
import { ToastContainer } from '@/features/ui/ToastContainer'
import { GatewayBootstrap } from '@/features/connection/GatewayBootstrap'
import { TeamSidebar } from '@/features/layout/TeamSidebar'
import { AgentListColumn } from '@/features/layout/AgentListColumn'
import { ContentArea } from '@/features/layout/ContentArea'
import { FirstRunNudge } from '@/features/fleet/FirstRunNudge'
import { AppTopBar } from '@/features/promo/AppTopBar'
import { SettingsModal } from '@/features/settings/SettingsModal'
import { ConfirmDialog } from '@/features/shared/ConfirmDialog'
import { useViewStore } from '@/stores/view'
import { useConnectionStore } from '@/stores/connection'
import { useSettingsModalStore } from '@/stores/settingsModal'
import { shouldShowGlobalTopBar } from '@/lib/topBar'

export function App() {
  const viewMode = useViewStore((s) => s.viewMode)
  const isBooZero = viewMode.type === 'booZero'
  const columnCollapsed = useViewStore((s) => s.columnCollapsed)
  // The first-run nudge only belongs on the settled dashboard (status 'connected'
  // in both gateway and native mode), never over the onboarding wizard.
  const onDashboard = useConnectionStore((s) => s.status === 'connected')
  // While the Settings modal is open, the whole app shell is inert so
  // background controls leave the tab order + AT tree (honouring aria-modal).
  const settingsOpen = useSettingsModalStore((s) => s.open)

  // Every nav view + agent/booZero/groupChat host the GitHub Star pill inline in
  // their own header, so the global AppTopBar (a Star-pill-only strip) would be a
  // duplicate there — it renders ONLY for `welcome`. The rule lives in
  // `lib/topBar.ts` (built from `NAV_VIEWS`) so a new dashboard tab can't silently
  // reintroduce the double-Star bug.
  const showGlobalTopBar = shouldShowGlobalTopBar(viewMode)

  return (
    <Providers>
      <ToastContainer />
      <GatewayBootstrap />
      <div
        inert={settingsOpen || undefined}
        className="flex h-screen overflow-hidden bg-background text-foreground"
      >
        {/* Col 1 — Team sidebar (60px) */}
        <TeamSidebar />
        {/* Col 2 — Agent list + nav (208px) — hidden in Boo Zero view or when collapsed */}
        {!isBooZero && !columnCollapsed && <AgentListColumn />}
        {/* Col 3+4 — Slim top bar (44px) hosts the GitHub Star pill for
            views without their own integrated chrome. Hidden on agent /
            booZero / groupChat — those views host the Star pill inside
            their own header row to save vertical space. */}
        <main className="flex flex-1 flex-col overflow-hidden">
          {showGlobalTopBar && <AppTopBar />}
          <ContentArea />
        </main>
      </div>
      {onDashboard && <FirstRunNudge />}
      <SettingsModal />
      {/* App-root confirmation dialog (design-system replacement for
          window.confirm). Outside the inert app-shell + above the settings
          modal scrim so an imperative confirm() is always interactive. */}
      <ConfirmDialog />
    </Providers>
  )
}
