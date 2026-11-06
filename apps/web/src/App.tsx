import { Providers } from './app/providers'
import { ToastContainer } from '@/features/ui/ToastContainer'
import { GatewayBootstrap } from '@/features/connection/GatewayBootstrap'
import { RunStatusBridge } from '@/features/obs/RunStatusBridge'
import { NeedsYouAlerts } from '@/features/alerts/NeedsYouAlerts'
import { InboxBridge } from '@/features/inbox/InboxBridge'
import { AppSidebar } from '@/features/layout/AppSidebar'
import { ContentArea } from '@/features/layout/ContentArea'
import { FirstRunNudge } from '@/features/fleet/FirstRunNudge'
import { UpdateChip } from '@/features/promo/UpdateChip'
import { AppTopBar } from '@/features/promo/AppTopBar'
import { SettingsModal } from '@/features/settings/SettingsModal'
import { ConfirmDialog } from '@/features/shared/ConfirmDialog'
import { FinishPromptDialog } from '@/features/board/FinishPromptDialog'
import { useViewStore } from '@/stores/view'
import { isSessionLive, useConnectionStore } from '@/stores/connection'
import { useSettingsModalStore } from '@/stores/settingsModal'
import { useBooZeroStore } from '@/stores/booZero'
import { shouldShowGlobalTopBar } from '@/lib/topBar'

export function App() {
  const viewMode = useViewStore((s) => s.viewMode)
  // The first-run nudge only belongs on the settled dashboard (status 'connected'
  // in both gateway and native mode), never over the onboarding wizard. Uses the
  // live-session predicate so a transient socket drop does not unmount these.
  const onDashboard = useConnectionStore((s) => isSessionLive(s.status))
  // While the Settings modal is open, the whole app shell is inert so
  // background controls leave the tab order + AT tree (honouring aria-modal).
  const settingsOpen = useSettingsModalStore((s) => s.open)

  // Every nav view + agent/booZero/groupChat host the GitHub Star pill inline in
  // their own header, so the global AppTopBar (a Star-pill-only strip) would be a
  // duplicate there — it renders ONLY for `welcome`. The rule lives in
  // `lib/topBar.ts` (built from `NAV_VIEWS`) so a new dashboard tab can't silently
  // reintroduce the double-Star bug.
  // The Boo Zero view without a Boo Zero falls back to the welcome screen, and
  // takes the bar with it.
  const hasBooZero = useBooZeroStore((s) => s.booZeroAgentId !== null)
  const showGlobalTopBar = shouldShowGlobalTopBar(viewMode, { hasBooZero })

  return (
    <Providers>
      <ToastContainer />
      <GatewayBootstrap />
      {/* Lights the fleet up during board runs, which no other status writer covers. */}
      <RunStatusBridge />
      {/* Browser notifications for what needs the person, while the tab is in
          the background. Opt-in, and quiet inside the desktop app. */}
      <NeedsYouAlerts />
      {/* The person's inbox and its badge, woken by the same event tail. */}
      <InboxBridge />
      {/* `--clawboo-titlebar-inset` (unset = 0) lets an embedder reserve a strip
          for its own title bar, such as an inset macOS one, so it never sits on
          the sidebar. The fallback lives here rather than on :root, so a value
          the embedder sets anywhere wins without a cascade fight.
          `h-dvh`, not `h-screen`: a phone browser's `100vh` is the viewport with
          its toolbars hidden, which puts the bottom of the app (the chat's
          message box) under them while they show. */}
      <div
        inert={settingsOpen || undefined}
        data-testid="app-shell"
        className="flex h-dvh overflow-hidden bg-background text-foreground"
        style={{ paddingTop: 'var(--clawboo-titlebar-inset, 0px)' }}
      >
        {/* Cols 1 + 2 — team rail + agent column, resizable and collapsible. Each
            column keeps its own error boundary (inside AppSidebar) so a crash in
            one can't take the other, or the content area, down with it. */}
        <AppSidebar />
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
      {/* Finishing a task by hand (Done or Cancelled) asks which day, from the
          board's drag or the task drawer. Same root placement as the confirm. */}
      <FinishPromptDialog />
    </Providers>
  )
}
