// Home: one page for every team, with a team picker like the Board's ("All teams"
// plus each team, starting on the team the sidebar has selected). A team's Home
// shows its status line, what needs you, its goals, KPIs, work in flight, spend,
// routines, pinned pages and recent files; All teams shows each team's headline
// numbers. A goal opens its own page here, and a task opens the board drawer over
// Home, so the person never loses their place.
//
// The team rail and the Board's goal chips ask for a team (and a goal) through
// the view store's one-shot `homeFocus`, the way "Open on board" asks the Board.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { AnimatePresence } from 'framer-motion'
import { FileText, Lightbulb, Plus, RefreshCw, Settings2, Target } from 'lucide-react'

import {
  dismissKpiSuggestion,
  listKpis,
  listPages,
  type GoalSummary,
  type KpiTile,
  type TeamGoal,
  type TeamHome,
  type TeamPage,
} from '@clawboo/control-client'

import { BoardMenu } from '@/features/board/BoardMenu'
import { TaskDetailDrawer } from '@/features/board/TaskDetailDrawer'
import { CollapsedSidebarToggle } from '@/features/layout/SidebarToggle'
import { GitHubStarButton } from '@/features/promo/GitHubStarButton'
import { Button, IconButton } from '@/features/shared/Button'
import { EmptyState } from '@/features/shared/EmptyState'
import { Modal } from '@/features/shared/Modal'
import { Select } from '@/features/shared/Select'
import { Skeleton } from '@/features/shared/Skeleton'
import { useGoalsStore } from '@/stores/goals'
import { useSettingsModalStore } from '@/stores/settingsModal'
import { useTeamStore } from '@/stores/team'
import { useToastStore } from '@/stores/toast'
import { useViewStore } from '@/stores/view'

import { AllTeamsView } from './AllTeamsView'
import { GoalDialog, type GoalDialogContext } from './GoalDialog'
import { GoalPage } from './GoalPage'
import { DIALOG_PANEL } from './homeForm'
import { HomeSettingsDialog } from './HomeSettingsDialog'
import { KpiDetailDialog } from './KpiDetailDialog'
import { KpiDialog, type KpiDialogMode } from './KpiDialog'
import { PageDrawer, type PageTarget } from './PageDrawer'
import { PageCards, TeamHomeView, type TeamHomeActions } from './TeamHomeView'
import { useHome } from './useHome'
import { useHomeNames } from './useHomeNames'
import { homeWrite } from './homeWrite'

const ALL = 'all'
/** How often relative times ("3m ago") move on. */
const CLOCK_MS = 30_000

export function HomePanel() {
  const teams = useTeamStore((s) => s.teams)
  const selectedTeamId = useTeamStore((s) => s.selectedTeamId)
  const teamsHydrated = useTeamStore((s) => s.hydrated)
  const homeFocus = useViewStore((s) => s.homeFocus)
  const activeTeams = useMemo(() => teams.filter((t) => !t.isArchived), [teams])

  const [teamFilter, setTeamFilter] = useState<string>(
    () => homeFocus?.teamId ?? selectedTeamId ?? ALL,
  )
  const [goalId, setGoalId] = useState<string | null>(() => homeFocus?.goalId ?? null)
  const [taskId, setTaskId] = useState<string | null>(null)
  const [goalDialog, setGoalDialog] = useState<{
    editing: TeamGoal | null
    parentId: string | null
    context?: GoalDialogContext
  } | null>(null)
  const [kpiDialog, setKpiDialog] = useState<{ teamId: string; mode: KpiDialogMode } | null>(null)
  const [kpiDetail, setKpiDetail] = useState<KpiTile | null>(null)
  const [pageTarget, setPageTarget] = useState<PageTarget | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [pagesOpen, setPagesOpen] = useState(false)
  const [newAnchor, setNewAnchor] = useState<HTMLElement | null>(null)
  const [goalReload, setGoalReload] = useState(0)
  const [now, setNow] = useState(() => Date.now())
  const names = useHomeNames()

  // The rail or a goal chip asked for a team (and maybe a goal). Taken before the
  // fallback below, which then sends a request for a team that is gone to All teams.
  useEffect(() => {
    if (!homeFocus) return
    setTeamFilter(homeFocus.teamId)
    setGoalId(homeFocus.goalId)
    useViewStore.getState().clearHomeFocus()
  }, [homeFocus])

  // A team that went away (deleted or archived) falls back to All teams, once the
  // team list is known: before it loads, an unknown id may simply not be read yet.
  // Deleting the last team leaves no teams, which still falls back.
  const team = teamFilter === ALL ? null : (activeTeams.find((t) => t.id === teamFilter) ?? null)
  const teamsKnown = teamsHydrated || teams.length > 0
  useEffect(() => {
    if (teamFilter !== ALL && teamsKnown && !team) {
      setTeamFilter(ALL)
      setGoalId(null)
    }
  }, [teamFilter, team, teamsKnown])

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), CLOCK_MS)
    return () => clearInterval(id)
  }, [])

  const { load, refresh } = useHome(teamFilter)

  // The server says the team is gone (deleted in another tab, say): back to All teams.
  const teamGone = load.state === 'error' && load.teamGone
  useEffect(() => {
    if (teamGone && teamFilter !== ALL) {
      setTeamFilter(ALL)
      setGoalId(null)
    }
  }, [teamGone, teamFilter])

  // Back from a goal page returns focus to that goal's row, so a keyboard or screen
  // reader user carries on from where they were.
  const panelRef = useRef<HTMLDivElement>(null)
  const returnToGoal = useRef<string | null>(null)
  const closeGoal = () => {
    returnToGoal.current = goalId
    setGoalId(null)
  }
  // Each read moves the clock on, so its own times read from the moment it landed.
  useEffect(() => {
    if (load.state === 'ready') setNow(Date.now())
  }, [load])

  // The data shown must be for the team picked: a read for the last team can
  // still be on screen for a frame after a switch.
  const teamHome: TeamHome | null =
    load.state === 'ready' && load.data.scope === 'team' && load.data.home.team.id === teamFilter
      ? load.data.home
      : null
  const allHome =
    load.state === 'ready' && load.data.scope === 'all' && teamFilter === ALL
      ? load.data.home
      : null
  const goals: GoalSummary[] = teamHome?.goals ?? []

  useEffect(() => {
    const id = returnToGoal.current
    if (goalId !== null || !id || !teamHome) return
    returnToGoal.current = null
    const rows = panelRef.current?.querySelectorAll<HTMLElement>('[data-testid="home-goal-row"]')
    Array.from(rows ?? [])
      .find((row) => row.dataset.goalId === id)
      ?.focus()
  }, [goalId, teamHome])

  // After a write: Home reads again, the open goal page too, and the Board's goal
  // chips and pickers forget the team's goals.
  const afterWrite = useCallback(
    (teamId: string | null = team?.id ?? null) => {
      void refresh()
      setGoalReload((n) => n + 1)
      if (teamId) useGoalsStore.getState().invalidate(teamId)
    },
    [refresh, team?.id],
  )

  const pickTeam = (value: string) => {
    setTeamFilter(value)
    setGoalId(null)
  }

  const reviewSuggestion = useCallback(async (kpiId: string, teamId: string) => {
    try {
      const tiles = await listKpis(teamId)
      const kpi = tiles.find((t) => t.kpi.id === kpiId)?.kpi
      if (kpi && kpi.status === 'suggested') setKpiDialog({ teamId, mode: { kind: 'accept', kpi } })
      else useToastStore.getState().addToast({ type: 'info', message: 'That suggestion is gone.' })
    } catch {
      useToastStore
        .getState()
        .addToast({ type: 'error', message: 'Couldn’t read the suggestion. Please try again.' })
    }
  }, [])

  const dismissSuggestion = useCallback(
    async (kpiId: string, teamId: string) => {
      const done = await homeWrite('dismiss the suggestion', () =>
        dismissKpiSuggestion(teamId, kpiId),
      )
      if (done) {
        setKpiDialog(null)
        afterWrite(teamId)
      }
    },
    [afterWrite],
  )

  const actions: TeamHomeActions = {
    openGoal: setGoalId,
    openTask: setTaskId,
    openKpi: setKpiDetail,
    openPage: (pageId) => setPageTarget({ pageId }),
    addGoal: () => setGoalDialog({ editing: null, parentId: null }),
    addKpi: () => team && setKpiDialog({ teamId: team.id, mode: { kind: 'new' } }),
    addPage: () => setPageTarget({ newPage: true }),
    reviewSuggestion: (kpiId, teamId) => void reviewSuggestion(kpiId, teamId),
    dismissSuggestion: (kpiId, teamId) => void dismissSuggestion(kpiId, teamId),
    openBoardNeedsYou: (teamId) => useViewStore.getState().openBoardNeedsYou(teamId ?? ALL),
    openRoutines: () => useSettingsModalStore.getState().openSettings('routines'),
    openSettings: () => setSettingsOpen(true),
  }

  const header = (
    <div
      data-testid="home-header"
      className="flex min-h-12 shrink-0 flex-wrap items-center gap-x-3 gap-y-1 px-4 pt-1"
    >
      <CollapsedSidebarToggle className="-ml-2 -mr-1" />
      <h1 className="text-xl font-semibold tracking-tight text-foreground">Home</h1>
      <Select
        size="sm"
        aria-label="Show Home for"
        data-testid="home-team-picker"
        value={team ? team.id : ALL}
        onChange={pickTeam}
      >
        <option value={ALL}>All teams</option>
        {activeTeams.map((t) => (
          <option key={t.id} value={t.id}>
            {t.icon} {t.name}
          </option>
        ))}
      </Select>
      <div className="ml-auto flex items-center gap-1.5">
        <GitHubStarButton />
        {team ? (
          <>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setPagesOpen(true)}
              data-testid="home-pages-button"
            >
              <FileText size={14} aria-hidden />
              <span className="max-sm:sr-only">Pages</span>
            </Button>
            <IconButton
              size="sm"
              label="Home settings"
              onClick={() => setSettingsOpen(true)}
              data-testid="home-settings-button"
            >
              <Settings2 size={15} aria-hidden />
            </IconButton>
            <Button
              size="sm"
              variant="primary"
              aria-haspopup="menu"
              aria-expanded={newAnchor !== null}
              data-testid="home-new"
              onClick={(e) => {
                const el = e.currentTarget
                setNewAnchor((a) => (a ? null : el))
              }}
            >
              <Plus size={14} strokeWidth={2} aria-hidden />
              New
            </Button>
          </>
        ) : null}
      </div>
    </div>
  )

  let body: ReactNode
  if (load.state === 'error' && !load.teamGone && !teamHome && !allHome) {
    body = (
      <EmptyState
        icon={RefreshCw}
        title={load.missing ? 'Home is not available here' : 'Home could not be read'}
        helper={
          load.missing
            ? 'This Clawboo server has no Home yet. Update it to see goals, KPIs and pages.'
            : 'Check that Clawboo is still running, then try again.'
        }
        action={
          load.missing ? undefined : (
            <Button size="sm" variant="secondary" onClick={() => void refresh()}>
              Try again
            </Button>
          )
        }
      />
    )
  } else if (team && goalId) {
    body = (
      <GoalPage
        key={goalId}
        teamId={team.id}
        teamName={team.name}
        goalId={goalId}
        now={now}
        names={names}
        reloadKey={goalReload}
        actions={{
          back: closeGoal,
          openGoal: setGoalId,
          openTask: setTaskId,
          openKpi: setKpiDetail,
          openPage: (pageId) => setPageTarget({ pageId }),
          addPage: (id) => setPageTarget({ newPage: true, goalId: id }),
          addKpi: (id) => setKpiDialog({ teamId: team.id, mode: { kind: 'new', goalId: id } }),
          addChildGoal: (parentId, context) => setGoalDialog({ editing: null, parentId, context }),
          editGoal: (goal, context) => setGoalDialog({ editing: goal, parentId: null, context }),
          changed: () => afterWrite(team.id),
        }}
      />
    )
  } else if (teamHome) {
    body = <TeamHomeView home={teamHome} now={now} names={names} actions={actions} />
  } else if (allHome) {
    body = (
      <AllTeamsView
        home={allHome}
        now={now}
        names={names}
        onPickTeam={pickTeam}
        actions={{
          openTask: setTaskId,
          reviewSuggestion: actions.reviewSuggestion,
          dismissSuggestion: actions.dismissSuggestion,
          openBoardNeedsYou: actions.openBoardNeedsYou,
          openGoalOnTeam: (teamId, id) => {
            setTeamFilter(teamId)
            setGoalId(id)
          },
        }}
      />
    )
  } else {
    body = <HomeSkeleton />
  }

  return (
    <div ref={panelRef} className="flex h-full flex-col bg-background" data-testid="home-panel">
      {header}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[1120px] px-4 pb-10 pt-3 sm:px-6">{body}</div>
      </div>

      {newAnchor && team ? (
        <BoardMenu
          anchor={newAnchor}
          label="New"
          width={200}
          testId="home-new-menu"
          onClose={() => setNewAnchor(null)}
          items={[
            {
              key: 'goal',
              label: 'Goal',
              icon: <Target size={14} aria-hidden />,
              onSelect: () => setGoalDialog({ editing: null, parentId: null }),
            },
            {
              key: 'kpi',
              label: 'KPI',
              icon: <Lightbulb size={14} aria-hidden />,
              onSelect: () =>
                setKpiDialog({
                  teamId: team.id,
                  mode: { kind: 'new', goalId: goalId ?? null },
                }),
            },
            {
              key: 'page',
              label: 'Page',
              icon: <FileText size={14} aria-hidden />,
              onSelect: () => setPageTarget({ newPage: true, goalId: goalId ?? null }),
            },
          ]}
        />
      ) : null}

      {team ? (
        <>
          <GoalDialog
            open={goalDialog !== null}
            onClose={() => setGoalDialog(null)}
            teamId={team.id}
            goals={goals}
            editing={goalDialog?.editing ?? null}
            defaultParentId={goalDialog?.parentId ?? null}
            context={goalDialog?.context ?? null}
            onSaved={(goal) => {
              afterWrite(team.id)
              if (!goalDialog?.editing) setGoalId(goal.id)
            }}
          />
          <KpiDetailDialog
            tile={kpiDetail}
            onClose={() => setKpiDetail(null)}
            teamId={team.id}
            now={now}
            names={names}
            onEdit={(kpi) => {
              setKpiDetail(null)
              setKpiDialog({ teamId: team.id, mode: { kind: 'edit', kpi } })
            }}
            onChanged={() => afterWrite(team.id)}
            onOpenTask={(id) => {
              setKpiDetail(null)
              setTaskId(id)
            }}
          />
          <PageDrawer
            target={pageTarget}
            onClose={() => setPageTarget(null)}
            teamId={team.id}
            goals={goals}
            now={now}
            names={names}
            onChanged={() => afterWrite(team.id)}
          />
          {teamHome ? (
            <HomeSettingsDialog
              open={settingsOpen}
              onClose={() => setSettingsOpen(false)}
              teamId={team.id}
              teamName={team.name}
              settings={teamHome.settings}
              onChanged={() => afterWrite(team.id)}
            />
          ) : null}
          <PagesDialog
            open={pagesOpen}
            onClose={() => setPagesOpen(false)}
            teamId={team.id}
            teamName={team.name}
            now={now}
            names={names}
            onOpen={(pageId) => {
              setPagesOpen(false)
              setPageTarget({ pageId })
            }}
            onNew={() => {
              setPagesOpen(false)
              setPageTarget({ newPage: true })
            }}
          />
        </>
      ) : null}

      <KpiDialog
        mode={kpiDialog?.mode ?? null}
        onClose={() => setKpiDialog(null)}
        teamId={kpiDialog?.teamId ?? team?.id ?? ''}
        goals={kpiDialog && kpiDialog.teamId === team?.id ? goals : []}
        onSaved={() => afterWrite(kpiDialog?.teamId ?? null)}
        onDismissSuggestion={(kpi) => void dismissSuggestion(kpi.id, kpi.teamId)}
      />

      <AnimatePresence>
        {taskId ? (
          <TaskDetailDrawer
            key="home-task"
            taskId={taskId}
            onClose={() => setTaskId(null)}
            onStatusCommitted={() => void refresh()}
            onChanged={() => afterWrite()}
            onOpenTask={setTaskId}
          />
        ) : null}
      </AnimatePresence>
    </div>
  )
}

function HomeSkeleton() {
  return (
    <div className="flex flex-col gap-6" data-testid="home-skeleton" aria-busy="true">
      <Skeleton height={64} radius={12} />
      <div className="flex flex-col gap-2">
        <Skeleton height={12} width={90} />
        <Skeleton height={120} radius={12} />
      </div>
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
        <Skeleton height={96} radius={12} />
        <Skeleton height={96} radius={12} />
        <Skeleton height={96} radius={12} />
      </div>
      <span className="sr-only">Loading Home…</span>
    </div>
  )
}

/** Every page of the team, pinned or not, with New page. */
function PagesDialog({
  open,
  onClose,
  teamId,
  teamName,
  now,
  names,
  onOpen,
  onNew,
}: {
  open: boolean
  onClose: () => void
  teamId: string
  teamName: string
  now: number
  names: ReturnType<typeof useHomeNames>
  onOpen: (pageId: string) => void
  onNew: () => void
}) {
  const [pages, setPages] = useState<TeamPage[] | null>(null)
  const [failed, setFailed] = useState(false)
  const reading = useRef(0)
  useEffect(() => {
    if (!open) return
    const id = ++reading.current
    setPages(null)
    setFailed(false)
    listPages(teamId)
      .then((list) => {
        if (id === reading.current) setPages(list)
      })
      .catch(() => {
        if (id === reading.current) setFailed(true)
      })
  }, [open, teamId])
  return (
    <Modal
      open={open}
      onClose={onClose}
      label={`${teamName} pages`}
      data-testid="home-pages-dialog"
      panelClassName={`${DIALOG_PANEL} w-[640px]`}
    >
      <div className="flex items-center gap-2 px-5 pb-2 pt-5">
        <h2 className="m-0 flex-1 text-base font-semibold text-foreground">Pages</h2>
        <Button size="sm" variant="primary" onClick={onNew} data-testid="home-pages-new">
          <Plus size={14} aria-hidden />
          New page
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5 pt-2">
        {failed ? (
          <p className="text-sm text-muted-foreground">The pages could not be read.</p>
        ) : pages === null ? (
          <div className="flex flex-col gap-2">
            <Skeleton height={56} radius={12} />
            <Skeleton height={56} radius={12} />
          </div>
        ) : pages.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No pages yet. Pages are notes the team keeps; agents can write them too.
          </p>
        ) : (
          <PageCards pages={pages} now={now} names={names} onOpen={onOpen} />
        )}
      </div>
    </Modal>
  )
}
