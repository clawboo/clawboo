import { Providers } from './app/providers'
import { ToastContainer } from '@/features/ui/ToastContainer'
import { GatewayBootstrap } from '@/features/connection/GatewayBootstrap'
import { AgentFileEditorOverlay } from '@/features/editor/AgentFileEditorOverlay'
import { FleetSidebar } from '@/features/fleet/FleetSidebar'
import Home from './app/page'

export function App() {
  return (
    <Providers>
      <ToastContainer />
      <GatewayBootstrap />
      <AgentFileEditorOverlay />
      <div className="flex h-screen overflow-hidden bg-background text-foreground">
        <aside className="w-64 shrink-0 border-r border-border bg-surface">
          <FleetSidebar />
        </aside>
        <main className="flex flex-1 flex-col overflow-hidden">
          <Home />
        </main>
      </div>
    </Providers>
  )
}
