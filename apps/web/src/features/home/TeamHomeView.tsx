// One team's Home, top to bottom: the status line (with its as-of time and who
// wrote it), Needs you, goals, KPI tiles, requests in flight, spend against
// budget, upcoming routines, pinned pages and recent files. Each section hides
// when it is empty; a team with no goals, KPIs or pages yet gets first-run
// prompts in their place.

import type { ReactNode } from 'react'
import {
  Bot,
  Calculator,
  CalendarClock,
  ChevronRight,
  FileText,
  FolderOpen,
  Lightbulb,
  ListChecks,
  Pin,
  Plus,
  Target,
} from 'lucide-react'

import type { HomeNeedsYou, KpiTile, TeamHome, TeamPage } from '@clawboo/control-client'

import { AgentBooAvatar } from '@/components/AgentBooAvatar'
import { Button } from '@/features/shared/Button'

import { GoalRow, orderGoals } from './GoalRow'
import {
  actorName,
  formatBytes,
  formatUsd,
  nextRunWords,
  reasonLabel,
  relativeTime,
} from './homeFormat'
import { HEADING_ACTION, HOME_CARD, HOME_ROW, HomeSection, ProgressBar } from './homeParts'
import { KpiTileCard } from './KpiTileCard'
import type { HomeNames } from './useHomeNames'

export interface TeamHomeActions {
  openGoal: (goalId: string) => void
  openTask: (taskId: string) => void
  openKpi: (tile: KpiTile) => void
  openPage: (pageId: string) => void
  addGoal: () => void
  addKpi: () => void
  addPage: () => void
  reviewSuggestion: (kpiId: string, teamId: string) => void
  dismissSuggestion: (kpiId: string, teamId: string) => void
  /** Approvals and questions live on the Board's Needs you. */
  openBoardNeedsYou: (teamId: string | null) => void
  openRoutines: () => void
  openSettings: () => void
}

export function TeamHomeView({
  home,
  now,
  names,
  actions,
}: {
  home: TeamHome
  now: number
  names: HomeNames
  actions: TeamHomeActions
}) {
  const firstRun =
    home.goals.length === 0 && home.kpis.length === 0 && home.pinnedPages.length === 0
  const showSpend =
    home.spend.budget !== null || home.spend.last30DaysUsd > 0 || home.spend.last7DaysUsd > 0
  return (
    <div className="flex flex-col gap-7" data-testid="team-home">
      <StatusLine home={home} now={now} names={names} />

      {home.needsYou.total > 0 ? (
        <NeedsYouSection
          needsYou={home.needsYou}
          teamId={home.team.id}
          now={now}
          names={names}
          actions={actions}
        />
      ) : null}

      {firstRun ? (
        <FirstRun weeklyOn={home.settings.weeklyUpdatesRoutineId !== null} actions={actions} />
      ) : null}

      {home.goals.length > 0 ? (
        <HomeSection
          id="goals"
          title="Goals"
          count={home.goals.length}
          action={
            <button type="button" className={HEADING_ACTION} onClick={actions.addGoal}>
              <Plus size={13} strokeWidth={2.25} aria-hidden />
              Add goal
            </button>
          }
        >
          <div className={`${HOME_CARD} divide-y divide-border overflow-hidden`}>
            {orderGoals(home.goals).map(({ summary, child }) => (
              <GoalRow
                key={summary.goal.id}
                summary={summary}
                now={now}
                indent={child}
                onOpen={actions.openGoal}
              />
            ))}
          </div>
        </HomeSection>
      ) : null}

      {home.kpis.length > 0 ? (
        <HomeSection
          id="kpis"
          title="KPIs"
          count={home.kpis.length}
          action={
            <button type="button" className={HEADING_ACTION} onClick={actions.addKpi}>
              <Plus size={13} strokeWidth={2.25} aria-hidden />
              Add KPI
            </button>
          }
        >
          <KpiGrid tiles={home.kpis} now={now} names={names} onOpen={actions.openKpi} />
        </HomeSection>
      ) : null}

      {home.inFlight.length > 0 ? (
        <HomeSection id="in-flight" title="In flight" count={home.inFlight.length}>
          <div className={`${HOME_CARD} divide-y divide-border overflow-hidden`}>
            {home.inFlight.map((r) => {
              const goal = r.goalId ? home.goals.find((g) => g.goal.id === r.goalId) : null
              const pct = r.subtaskCount > 0 ? (r.subtasksDone / r.subtaskCount) * 100 : 0
              return (
                <button
                  key={r.taskId}
                  type="button"
                  data-testid="home-in-flight-row"
                  className={HOME_ROW}
                  onClick={() => actions.openTask(r.taskId)}
                >
                  {r.leadAgentId ? (
                    <AgentBooAvatar agentId={r.leadAgentId} size={22} />
                  ) : (
                    <ListChecks size={18} aria-hidden className="text-muted-foreground" />
                  )}
                  <span className="flex min-w-0 flex-1 flex-col gap-1">
                    <span className="flex min-w-0 items-baseline gap-2">
                      {r.identifier ? (
                        <span className="shrink-0 font-mono text-micro text-muted-foreground">
                          {r.identifier}
                        </span>
                      ) : null}
                      <span className="truncate text-sm text-foreground">{r.title}</span>
                    </span>
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="w-20 shrink-0 sm:w-28">
                        <ProgressBar
                          percent={pct}
                          label={`${r.title}: ${r.subtasksDone} of ${r.subtaskCount} done`}
                        />
                      </span>
                      <span className="truncate text-xs tabular-nums text-muted-foreground">
                        {r.subtaskCount > 0
                          ? `${r.subtasksDone} of ${r.subtaskCount} done`
                          : 'No work filed yet'}
                        {goal ? ` · ${goal.goal.title}` : ''}
                      </span>
                    </span>
                  </span>
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground max-sm:hidden">
                    {relativeTime(r.updatedAt, now)}
                  </span>
                </button>
              )
            })}
          </div>
        </HomeSection>
      ) : null}

      {showSpend ? <SpendSection home={home} /> : null}

      {home.routines.length > 0 ? (
        <HomeSection
          id="routines"
          title="Upcoming routines"
          count={home.routines.length}
          action={
            <button type="button" className={HEADING_ACTION} onClick={actions.openRoutines}>
              Routines
              <ChevronRight size={13} aria-hidden />
            </button>
          }
        >
          <div className={`${HOME_CARD} divide-y divide-border overflow-hidden`}>
            {home.routines.map((r) => (
              <div key={r.id} className="flex min-w-0 items-center gap-3 px-3 py-2.5">
                {r.agentId ? (
                  <AgentBooAvatar agentId={r.agentId} size={22} />
                ) : (
                  <CalendarClock size={18} aria-hidden className="text-muted-foreground" />
                )}
                <span className="min-w-0 flex-1 truncate text-sm text-foreground">{r.name}</span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {r.target === 'team' ? 'Team' : (names.agentName(r.agentId ?? '') ?? 'Agent')}
                </span>
                <span className="w-28 shrink-0 text-right text-xs tabular-nums text-foreground">
                  {nextRunWords(r.nextRunAt, now)}
                </span>
              </div>
            ))}
          </div>
        </HomeSection>
      ) : null}

      {home.pinnedPages.length > 0 ? (
        <HomeSection
          id="pages"
          title="Pinned pages"
          count={home.pinnedPages.length}
          action={
            <button type="button" className={HEADING_ACTION} onClick={actions.addPage}>
              <Plus size={13} strokeWidth={2.25} aria-hidden />
              New page
            </button>
          }
        >
          <PageCards pages={home.pinnedPages} now={now} names={names} onOpen={actions.openPage} />
        </HomeSection>
      ) : null}

      {home.recentFiles.length > 0 ? (
        <HomeSection id="files" title="Recent files" count={home.recentFiles.length}>
          <div className={`${HOME_CARD} divide-y divide-border overflow-hidden`}>
            {home.recentFiles.map((f) => (
              <button
                key={`${f.taskId}:${f.path}`}
                type="button"
                data-testid="home-recent-file"
                className={HOME_ROW}
                title="Open the task that made it"
                onClick={() => actions.openTask(f.taskId)}
              >
                <FolderOpen size={16} aria-hidden className="shrink-0 text-muted-foreground" />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate font-mono text-[12.5px] text-foreground">{f.path}</span>
                  <span className="truncate text-xs text-muted-foreground">
                    {f.taskIdentifier ? `${f.taskIdentifier} · ` : ''}
                    {f.taskTitle}
                  </span>
                </span>
                <span className="shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                  {formatBytes(f.sizeBytes)}
                  <span className="block">{relativeTime(f.modifiedAt, now)}</span>
                </span>
              </button>
            ))}
          </div>
        </HomeSection>
      ) : null}
    </div>
  )
}

// ─── Status line ─────────────────────────────────────────────────────────────

function StatusLine({ home, now, names }: { home: TeamHome; now: number; names: HomeNames }) {
  const { status } = home
  const lead = status.source === 'lead'
  return (
    <div className={`${HOME_CARD} flex items-start gap-3 px-4 py-3`} data-testid="home-status-line">
      <span
        aria-hidden
        className="mt-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-lg bg-foreground/[0.05] text-muted-foreground"
      >
        {lead && status.author ? (
          <AgentBooAvatar agentId={status.author.id} size={22} />
        ) : lead ? (
          <Bot size={15} />
        ) : (
          <Calculator size={15} />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <p className="m-0 text-[15px] leading-snug text-foreground">{status.text}</p>
        <p className="m-0 mt-1 text-xs text-muted-foreground" data-testid="home-status-source">
          {lead
            ? `Written by ${actorName(status.author, names)}${status.model ? ` (${status.model})` : ''}`
            : 'Computed from the board'}
          {` · as of ${relativeTime(status.asOf, now)}`}
        </p>
      </div>
    </div>
  )
}

/** A Needs you row: at phone width the reason sits above what it is about. */
const NEEDS_ROW = `${HOME_ROW} max-sm:flex-wrap max-sm:gap-y-1`

// ─── Needs you ───────────────────────────────────────────────────────────────

export function NeedsYouSection({
  needsYou,
  teamId,
  now,
  names,
  actions,
  teamName,
}: {
  needsYou: HomeNeedsYou
  /** The team, or null for the All teams list. */
  teamId: string | null
  now: number
  names: HomeNames
  actions: Pick<
    TeamHomeActions,
    'openTask' | 'openGoal' | 'reviewSuggestion' | 'dismissSuggestion' | 'openBoardNeedsYou'
  > & { openGoalOnTeam?: (teamId: string, goalId: string) => void }
  /** Under All teams: each entry names its team. */
  teamName?: (teamId: string | null) => string | null
}) {
  const rows: ReactNode[] = []
  const teamTag = (id: string | null) => {
    const name = teamName?.(id)
    return name ? <span className="shrink-0 text-xs text-muted-foreground">{name}</span> : null
  }
  for (const t of needsYou.tasks) {
    rows.push(
      <button
        key={`task:${t.taskId}`}
        type="button"
        data-testid="home-needs-task"
        className={NEEDS_ROW}
        onClick={() => actions.openTask(t.taskId)}
      >
        <span className="board-reason w-36 shrink-0 truncate max-sm:w-full text-xs font-medium">
          {reasonLabel(t.reason)}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm text-foreground">
          {t.identifier ? (
            <span className="mr-1.5 font-mono text-micro text-muted-foreground">
              {t.identifier}
            </span>
          ) : null}
          {t.title}
        </span>
        {teamTag(t.teamId)}
      </button>,
    )
  }
  for (const d of needsYou.draftUpdates) {
    rows.push(
      <button
        key={`draft:${d.updateId}`}
        type="button"
        data-testid="home-needs-draft"
        className={NEEDS_ROW}
        onClick={() =>
          actions.openGoalOnTeam
            ? actions.openGoalOnTeam(d.teamId, d.goalId)
            : actions.openGoal(d.goalId)
        }
      >
        <span className="board-reason w-36 shrink-0 truncate max-sm:w-full text-xs font-medium">
          Draft update
        </span>
        <span className="min-w-0 flex-1 truncate text-sm text-foreground">
          {d.goalTitle}
          <span className="ml-1.5 text-xs text-muted-foreground">
            by {actorName(d.author, names)}, {relativeTime(d.createdAt, now)}
          </span>
        </span>
        {teamTag(d.teamId)}
      </button>,
    )
  }
  for (const s of needsYou.suggestedKpis) {
    rows.push(
      <div
        key={`kpi:${s.kpiId}`}
        data-testid="home-needs-suggestion"
        className="flex min-w-0 items-center gap-3 px-3 py-2.5 max-sm:flex-wrap max-sm:gap-y-1"
      >
        <span className="board-reason w-36 shrink-0 truncate max-sm:w-full text-xs font-medium">
          Suggested KPI
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm text-foreground">
            {s.name}
            <span className="ml-1.5 text-xs text-muted-foreground">
              from {actorName(s.suggestedBy, names)}
            </span>
          </span>
          {s.note ? <span className="truncate text-xs text-muted-foreground">{s.note}</span> : null}
        </span>
        {teamTag(s.teamId)}
        <span className="flex shrink-0 gap-1">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => actions.dismissSuggestion(s.kpiId, s.teamId)}
          >
            Dismiss
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => actions.reviewSuggestion(s.kpiId, s.teamId)}
          >
            Review
          </Button>
        </span>
      </div>,
    )
  }
  const waiting: string[] = []
  if (needsYou.approvals > 0)
    waiting.push(needsYou.approvals === 1 ? '1 approval' : `${needsYou.approvals} approvals`)
  if (needsYou.questions > 0)
    waiting.push(needsYou.questions === 1 ? '1 question' : `${needsYou.questions} questions`)
  if (waiting.length > 0) {
    rows.unshift(
      <button
        key="board"
        type="button"
        data-testid="home-needs-board"
        className={NEEDS_ROW}
        onClick={() => actions.openBoardNeedsYou(teamId)}
      >
        <span className="board-reason w-36 shrink-0 truncate max-sm:w-full text-xs font-medium">
          On the Board
        </span>
        <span className="min-w-0 flex-1 truncate text-sm text-foreground">
          {waiting.join(' and ')} waiting for you
        </span>
        <ChevronRight size={14} aria-hidden className="shrink-0 text-muted-foreground" />
      </button>,
    )
  }
  return (
    <HomeSection id="needs-you" title="Needs you" count={needsYou.total}>
      <div className={`${HOME_CARD} divide-y divide-border overflow-hidden`}>{rows}</div>
    </HomeSection>
  )
}

// ─── KPIs ────────────────────────────────────────────────────────────────────

export function KpiGrid({
  tiles,
  now,
  names,
  onOpen,
}: {
  tiles: KpiTile[]
  now: number
  names: HomeNames
  onOpen: (tile: KpiTile) => void
}) {
  return (
    <div className="grid grid-cols-1 gap-2.5 min-[480px]:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
      {tiles.map((tile) => (
        <KpiTileCard key={tile.kpi.id} tile={tile} now={now} names={names} onOpen={onOpen} />
      ))}
    </div>
  )
}

// ─── Spend ───────────────────────────────────────────────────────────────────

function SpendSection({ home }: { home: TeamHome }) {
  const { spend } = home
  const budget = spend.budget
  const pct = budget && budget.limitUsd > 0 ? (budget.spentUsd / budget.limitUsd) * 100 : null
  const est = spend.includesEstimates ? ', estimates included' : ''
  return (
    <HomeSection id="spend" title="Spend">
      <div className={`${HOME_CARD} flex flex-col gap-3 px-4 py-3`} data-testid="home-spend">
        <div className="flex flex-wrap gap-x-8 gap-y-2">
          <div>
            <div className="text-xs text-muted-foreground">Last 7 days</div>
            <div className="text-lg font-semibold tabular-nums text-foreground">
              {formatUsd(spend.last7DaysUsd)}
            </div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Last 30 days</div>
            <div className="text-lg font-semibold tabular-nums text-foreground">
              {formatUsd(spend.last30DaysUsd)}
            </div>
          </div>
          {budget ? (
            <div className="min-w-[200px] flex-1">
              <div className="flex items-baseline gap-2 text-xs text-muted-foreground">
                <span>
                  Budget: {formatUsd(budget.spentUsd)} of {formatUsd(budget.limitUsd)}
                </span>
                <span className="ml-auto">
                  {budget.status === 'paused'
                    ? 'Paused by its cap'
                    : budget.mode === 'cap'
                      ? 'Stops runs at the limit'
                      : 'Warns at the limit'}
                </span>
              </div>
              <div className="mt-2">
                <ProgressBar
                  percent={pct ?? 0}
                  color={
                    budget.status === 'paused' || (pct ?? 0) >= 100
                      ? 'var(--destructive)'
                      : (pct ?? 0) >= 80
                        ? 'var(--amber)'
                        : 'var(--mint)'
                  }
                  label={`Budget used: ${Math.round(pct ?? 0)}%`}
                />
              </div>
            </div>
          ) : null}
        </div>
        <p className="m-0 text-xs text-muted-foreground">
          Computed from the team&apos;s runs{est}.
          {budget ? null : ' No budget is set for this team.'}
        </p>
      </div>
    </HomeSection>
  )
}

// ─── Pages ───────────────────────────────────────────────────────────────────

export function PageCards({
  pages,
  now,
  names,
  onOpen,
}: {
  pages: TeamPage[]
  now: number
  names: HomeNames
  onOpen: (pageId: string) => void
}) {
  return (
    <div className="grid grid-cols-1 gap-2.5 min-[480px]:grid-cols-2 lg:grid-cols-3">
      {pages.map((p) => (
        <button
          key={p.id}
          type="button"
          data-testid="home-page-card"
          onClick={() => onOpen(p.id)}
          className={`${HOME_CARD} flex min-w-0 cursor-pointer flex-col gap-1 p-3 text-left transition-colors hover:border-border-strong focus-visible:outline-2 focus-visible:outline-offset-2`}
        >
          <span className="flex min-w-0 items-center gap-2">
            <FileText size={15} aria-hidden className="shrink-0 text-muted-foreground" />
            <span className="truncate text-sm font-medium text-foreground">{p.title}</span>
            {p.pinned ? (
              <Pin
                size={12}
                aria-label="Pinned"
                className="ml-auto shrink-0 text-muted-foreground"
              />
            ) : null}
          </span>
          <span className="truncate text-xs text-muted-foreground">
            Revision {p.revision} by {actorName(p.updatedBy, names)},{' '}
            {relativeTime(p.updatedAt, now)}
          </span>
        </button>
      ))}
    </div>
  )
}

// ─── First run ───────────────────────────────────────────────────────────────

function FirstRun({ weeklyOn, actions }: { weeklyOn: boolean; actions: TeamHomeActions }) {
  const prompts: {
    icon: typeof Target
    title: string
    helper: string
    cta: string
    run: () => void
    testId: string
  }[] = [
    {
      icon: Target,
      title: 'Add a goal',
      helper: 'Link board tasks to it and its progress counts them.',
      cta: 'Add a goal',
      run: actions.addGoal,
      testId: 'home-first-goal',
    },
    {
      icon: Lightbulb,
      title: 'Track a KPI',
      helper: 'Worked out from the board, reported by an agent, or typed by you.',
      cta: 'Add a KPI',
      run: actions.addKpi,
      testId: 'home-first-kpi',
    },
    {
      icon: FileText,
      title: 'Write a page',
      helper: 'Notes the team keeps. Agents can write them too; every revision is kept.',
      cta: 'Write a page',
      run: actions.addPage,
      testId: 'home-first-page',
    },
  ]
  return (
    <section aria-label="Get started" data-testid="home-first-run" className="flex flex-col gap-3">
      <div className="grid grid-cols-1 gap-2.5 md:grid-cols-3">
        {prompts.map((p) => {
          const Icon = p.icon
          return (
            <div key={p.title} className={`${HOME_CARD} flex flex-col items-start gap-2 p-4`}>
              <span
                aria-hidden
                className="inline-flex size-9 items-center justify-center rounded-full border border-border bg-foreground/[0.04] text-muted-foreground"
              >
                <Icon size={17} strokeWidth={1.75} />
              </span>
              <span className="text-sm font-semibold text-foreground">{p.title}</span>
              <span className="text-xs leading-relaxed text-muted-foreground">{p.helper}</span>
              <Button size="sm" variant="secondary" onClick={p.run} data-testid={p.testId}>
                <Plus size={14} aria-hidden />
                {p.cta}
              </Button>
            </div>
          )
        })}
      </div>
      {!weeklyOn ? (
        <p className="m-0 text-xs text-muted-foreground">
          Want the lead to draft a weekly update on each goal?{' '}
          <button
            type="button"
            onClick={actions.openSettings}
            className="cursor-pointer text-foreground underline decoration-border underline-offset-2 hover:decoration-foreground"
          >
            Turn on weekly updates
          </button>
        </p>
      ) : null}
    </section>
  )
}
