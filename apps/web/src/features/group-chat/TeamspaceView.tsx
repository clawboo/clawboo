// TeamspaceView: the team's Home. It will hold the team's dashboards and the
// artifacts its agents make; until those exist, it says so.

import { LayoutDashboard } from 'lucide-react'
import { EmptyState } from '@/features/shared/EmptyState'
import { CollapsedSidebarToggle } from '@/features/layout/SidebarToggle'
import { GitHubStarButton } from '@/features/promo/GitHubStarButton'
import { useTeamStore } from '@/stores/team'

export function TeamspaceView({ teamId }: { teamId: string }) {
  const team = useTeamStore((s) => s.teams.find((t) => t.id === teamId) ?? null)
  if (!team) return null

  return (
    <div className="flex h-full flex-col bg-background" data-testid="teamspace-view">
      <header className="flex h-11 shrink-0 items-center gap-2 px-3">
        <CollapsedSidebarToggle />
        <span className="truncate text-[14px] font-semibold text-foreground">{team.name}</span>
        <span className="text-[13px] text-muted-foreground">Home</span>
        <span className="ml-auto">
          <GitHubStarButton />
        </span>
      </header>
      <div className="flex min-h-0 flex-1 items-center justify-center p-8">
        <EmptyState
          icon={LayoutDashboard}
          title="Dashboards and artifacts"
          helper={`${team.name}'s dashboards, and the artifacts its agents make, will live here.`}
          paddingTop={0}
        />
      </div>
    </div>
  )
}
