import { Providers } from './app/providers'
import { ToastContainer } from '@/features/ui/ToastContainer'
import { GatewayBootstrap } from '@/features/connection/GatewayBootstrap'
import { TeamSidebar } from '@/features/layout/TeamSidebar'
import { AgentListColumn } from '@/features/layout/AgentListColumn'
import { ContentArea } from '@/features/layout/ContentArea'

export function App() {
  return (
    <Providers>
      <ToastContainer />
      <GatewayBootstrap />
      <div className="flex h-screen overflow-hidden bg-background text-foreground">
        {/* Col 1 — Team sidebar (60px) */}
        <TeamSidebar />
        {/* Col 2 — Agent list + nav (208px) */}
        <AgentListColumn />
        {/* Col 3+4 — Content area */}
        <main className="flex flex-1 flex-col overflow-hidden">
          <ContentArea />
        </main>
      </div>
    </Providers>
  )
}
