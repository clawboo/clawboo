import { Providers } from './app/providers'
import { ToastContainer } from '@/features/ui/ToastContainer'
import { GatewayBootstrap } from '@/features/connection/GatewayBootstrap'
import { TeamSidebar } from '@/features/layout/TeamSidebar'
import { AgentListColumn } from '@/features/layout/AgentListColumn'
import { ContentArea } from '@/features/layout/ContentArea'
import { FirstRunNudge } from '@/features/fleet/FirstRunNudge'
import { UpdateChip } from '@/features/promo/UpdateChip'
import { AppTopBar } from '@/features/promo/AppTopBar'
import { SettingsModal } from '@/features/settings/SettingsModal'
import { ConfirmDialog } from '@/features/shared/ConfirmDialog'
import { ErrorBoundary } from '@/features/shared/ErrorBoundary'
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
        {/* Col 1 — Team sidebar (60px).
            Cols 1 + 2 each get their own boundary so a crash in one column can't
            take the other — or the content area — down with it. Without these, a
            throw in the agent column would unwind to the ROOT boundary and blank
            the entire app, the exact failure this change exists to prevent. The
            fallback is icon-only (a card can't fit a 60px rail) and inherits each
            column's geometry so the layout doesn't shift. */}
        <ErrorBoundary
          variant="compact"
          label="the team sidebar"
          fallbackClassName="h-full w-[60px] shrink-0 border-r border-border bg-background"
        >
          <TeamSidebar />
        </ErrorBoundary>
        {/* Col 2 — Agent list + nav (236px) — hidden in Boo Zero view or when collapsed */}
        {!isBooZero && !columnCollapsed && (
          <ErrorBoundary
            variant="compact"
            label="the agent sidebar"
            fallbackClassName="h-full shrink-0 border-r border-border bg-surface"
            fallbackStyle={{ width: 236 }}
          >
            <AgentListColumn />
          </ErrorBoundary>
        )}
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
      {/* Bottom-left "update available" chip — appears when a newer clawboo
          version is published; click to copy the update command or apply it. */}
      {onDashboard && <UpdateChip />}
      <SettingsModal />
      {/* App-root confirmation dialog (design-system replacement for
          window.confirm). Outside the inert app-shell + above the settings
          modal scrim so an imperative confirm() is always interactive. */}
      <ConfirmDialog />
    </Providers>
  )
}
