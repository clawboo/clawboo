// Home for All teams: the totals across every team, a Needs you list across
// teams, and one card per team with the same headline numbers (its status line,
// goals with progress, its first KPIs, what needs you, spend against budget).
// Clicking a team's card switches the picker to it.

import { ChevronRight, Users } from 'lucide-react'

import type { AllTeamsHome, AllTeamsHomeRow } from '@clawboo/control-client'

import { EmptyState } from '@/features/shared/EmptyState'

import { formatUsd, progressPercent, progressWords } from './homeFormat'
import { HealthDot, HOME_CARD, HomeSection, ProgressBar, Stat, TeamMark } from './homeParts'
import { KpiTileCard } from './KpiTileCard'
import { NeedsYouSection, type TeamHomeActions } from './TeamHomeView'
import type { HomeNames } from './useHomeNames'

/** How many goals a team's card lists before "and N more". */
const CARD_GOALS = 3
/** How many KPI tiles a team's card shows. */
const CARD_KPIS = 2

export function AllTeamsView({
  home,
  now,
  names,
  onPickTeam,
  actions,
}: {
  home: AllTeamsHome
  now: number
  names: HomeNames
  onPickTeam: (teamId: string) => void
  actions: Pick<
    TeamHomeActions,
    'openTask' | 'reviewSuggestion' | 'dismissSuggestion' | 'openBoardNeedsYou'
  > & { openGoalOnTeam: (teamId: string, goalId: string) => void }
}) {
  const { totals } = home
  const teamName = (id: string | null) =>
    id ? (home.teams.find((t) => t.team.id === id)?.team.name ?? null) : null

  if (home.teams.length === 0) {
    return (
      <EmptyState
        icon={Users}
        title="No teams yet"
        helper="Create a team from the team rail on the left. Its Home shows its goals, KPIs and pages."
      />
    )
  }

  return (
    <div className="flex flex-col gap-7" data-testid="all-teams-home">
      <section
        aria-label="Totals across teams"
        className={`${HOME_CARD} grid grid-cols-2 gap-4 px-4 py-3 sm:grid-cols-3 lg:grid-cols-5`}
        data-testid="home-totals"
      >
        <Stat label="Requests in flight" value={String(totals.requestsInFlight)} />
        <Stat label="Needs you" value={String(totals.needsYou)} />
        <Stat label="Done this week" value={String(totals.doneLast7Days)} />
        <Stat
          label="Spent this week"
          value={formatUsd(totals.spentLast7DaysUsd)}
          note="Computed from runs"
        />
        <Stat
          label="Active goals"
          value={String(totals.goalsActive)}
          note={
            totals.goalsAtRisk + totals.goalsOffTrack > 0
              ? `${totals.goalsAtRisk} at risk, ${totals.goalsOffTrack} off track`
              : undefined
          }
        />
      </section>

      {home.needsYou.total > 0 ? (
        <NeedsYouSection
          needsYou={home.needsYou}
          teamId={null}
          now={now}
          names={names}
          teamName={teamName}
          actions={{
            ...actions,
            openGoal: () => undefined,
          }}
        />
      ) : null}

      <HomeSection id="teams" title="Teams" count={home.teams.length}>
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 2xl:grid-cols-3">
          {home.teams.map((row) => (
            <TeamCard key={row.team.id} row={row} now={now} names={names} onPick={onPickTeam} />
          ))}
        </div>
      </HomeSection>
    </div>
  )
}

function TeamCard({
  row,
  now,
  names,
  onPick,
}: {
  row: AllTeamsHomeRow
  now: number
  names: HomeNames
  onPick: (teamId: string) => void
}) {
  const { team, status, goals, kpis, needsYouCount, spend } = row
  const budget = spend.budget
  return (
    <button
      type="button"
      data-testid="home-team-card"
      onClick={() => onPick(team.id)}
      aria-label={`Open ${team.name} Home`}
      className={`${HOME_CARD} flex min-w-0 cursor-pointer flex-col gap-3 p-4 text-left transition-colors hover:border-border-strong focus-visible:outline-2 focus-visible:outline-offset-2`}
    >
      <span className="flex min-w-0 items-center gap-2.5">
        <TeamMark icon={team.icon} color={team.color} size={28} />
        <span className="min-w-0 flex-1 truncate text-[15px] font-semibold text-foreground">
          {team.name}
        </span>
        {needsYouCount > 0 ? (
          <span className="board-reason shrink-0 text-xs font-medium">
            {needsYouCount} need{needsYouCount === 1 ? 's' : ''} you
          </span>
        ) : null}
        <ChevronRight size={15} aria-hidden className="shrink-0 text-muted-foreground" />
      </span>
      <span className="text-[13px] leading-snug text-foreground">
        {status.text}
        <span className="mt-0.5 block text-xs text-muted-foreground">
          {status.source === 'lead' ? 'Written by the lead' : 'Computed from the board'}
        </span>
      </span>
      {goals.length > 0 ? (
        <span className="flex flex-col gap-2">
          {goals.slice(0, CARD_GOALS).map((g) => (
            <span key={g.goal.id} className="flex min-w-0 items-center gap-2">
              <HealthDot health={g.goal.health} size={8} />
              <span className="min-w-0 flex-1 truncate text-xs text-foreground">
                {g.goal.title}
              </span>
              <span className="w-16 shrink-0">
                <ProgressBar
                  percent={progressPercent(g.progress)}
                  faded={g.updateMissing}
                  label={`${g.goal.title}: ${progressWords(g.progress)}`}
                />
              </span>
            </span>
          ))}
          {goals.length > CARD_GOALS ? (
            <span className="text-xs text-muted-foreground">
              and {goals.length - CARD_GOALS} more
            </span>
          ) : null}
        </span>
      ) : null}
      {kpis.length > 0 ? (
        <span className="grid grid-cols-1 gap-2 min-[420px]:grid-cols-2">
          {kpis.slice(0, CARD_KPIS).map((tile) => (
            <KpiTileCard key={tile.kpi.id} tile={tile} now={now} names={names} compact />
          ))}
        </span>
      ) : null}
      <span className="flex items-center gap-2 text-xs tabular-nums text-muted-foreground">
        <span>{formatUsd(spend.last7DaysUsd)} this week</span>
        {budget ? (
          <>
            <span aria-hidden>·</span>
            <span>
              {formatUsd(budget.spentUsd)} of {formatUsd(budget.limitUsd)} budget
            </span>
          </>
        ) : null}
      </span>
    </button>
  )
}
