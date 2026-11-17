// A goal's own page, the project dashboard: its description, owner, target date
// and health (with the history of who set it), progress over the linked tasks
// (each opens the board drawer), its KPIs, its updates (agents' drafts to publish,
// edit or discard, and the published history), what its tasks cost, the goals
// under it and the pages linked to it.

import { useCallback, useEffect, useId, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Archive, ChevronLeft, FileText, Pencil, Plus } from 'lucide-react'

import {
  archiveGoal,
  createGoalUpdate,
  discardGoalUpdate,
  getGoal,
  GOAL_HEALTHS,
  publishGoalUpdate,
  setGoalHealth,
  updateGoal,
  type GoalDetail,
  type GoalHealth,
  type GoalStatus,
  type GoalTask,
  type GoalUpdate,
  type KpiTile,
  type TeamGoal,
} from '@clawboo/control-client'

import { MD_COMPONENTS } from '@/features/chat/chatComponents'
import { statusLabel } from '@/features/board/boardStatus'
import { Button } from '@/features/shared/Button'
import { Select } from '@/features/shared/Select'
import { Skeleton } from '@/features/shared/Skeleton'
import { confirm } from '@/stores/confirm'

import type { GoalDialogContext } from './GoalDialog'
import { GoalRow } from './GoalRow'
import {
  actorName,
  formatDate,
  formatUsd,
  HEALTH_LABEL,
  healthLabel,
  progressPercent,
  progressWords,
  relativeTime,
  scopeWords,
  targetDateWords,
} from './homeFormat'
import { TEXTAREA_CLASS } from './homeForm'
import {
  HEADING_ACTION,
  HealthDot,
  HOME_CARD,
  HOME_ROW,
  HomeSection,
  ProgressBar,
} from './homeParts'
import { KpiGrid, PageCards } from './TeamHomeView'
import type { HomeNames } from './useHomeNames'
import { homeWrite } from './homeWrite'

const NO_HEALTH = ''

const LINK_WORDS: Record<GoalTask['linkedVia'], string> = {
  own: 'Linked',
  request: 'Through its request',
  parent: 'Through its parent task',
}

export interface GoalPageActions {
  back: () => void
  openGoal: (goalId: string) => void
  openTask: (taskId: string) => void
  openKpi: (tile: KpiTile) => void
  openPage: (pageId: string) => void
  addPage: (goalId: string) => void
  addKpi: (goalId: string) => void
  /** A new goal under this one, with the parent's title for the picker. */
  addChildGoal: (parentId: string, context: GoalDialogContext) => void
  /** Edit this goal, with what the page knows of its parent and children. */
  editGoal: (goal: TeamGoal, context: GoalDialogContext) => void
  /** Something on the goal changed: Home's lists read again. */
  changed: () => void
}

export function GoalPage({
  teamId,
  teamName,
  goalId,
  now,
  names,
  reloadKey,
  actions,
}: {
  teamId: string
  teamName: string
  goalId: string
  now: number
  names: HomeNames
  /** Changes when a dialog on Home saved something this page shows. */
  reloadKey: number
  actions: GoalPageActions
}) {
  const [detail, setDetail] = useState<GoalDetail | null>(null)
  // Only the server saying "no such goal" (a 404) means it is gone. Any other failed
  // read keeps the last detail on screen and says the read failed, with Try again.
  const [missing, setMissing] = useState(false)
  const [readFailed, setReadFailed] = useState(false)
  const [retrying, setRetrying] = useState(false)

  // Only the newest read lands: one started before a write must not paint the goal as
  // it was over the read that followed the write.
  const reading = useRef(0)
  const read = useCallback(async () => {
    const id = ++reading.current
    try {
      const got = await getGoal(teamId, goalId)
      if (id !== reading.current) return
      if (got) {
        setDetail(got)
        setMissing(false)
      } else setMissing(true)
      setReadFailed(false)
    } catch {
      if (id === reading.current) setReadFailed(true)
    }
  }, [teamId, goalId])

  useEffect(() => {
    void read()
  }, [read, reloadKey])

  const retry = async () => {
    setRetrying(true)
    await read()
    setRetrying(false)
  }

  // Opening a goal moves focus to its title, so a keyboard or screen reader user lands
  // on the page they opened rather than on the row that is gone.
  const headingRef = useRef<HTMLHeadingElement>(null)
  const focusedFor = useRef<string | null>(null)
  useEffect(() => {
    if (!detail || focusedFor.current === detail.summary.goal.id) return
    focusedFor.current = detail.summary.goal.id
    headingRef.current?.focus()
  }, [detail])

  const changed = () => {
    void read()
    actions.changed()
  }

  const back = (
    <button
      type="button"
      onClick={actions.back}
      data-testid="goal-back"
      className="-ml-2 inline-flex h-7 cursor-pointer items-center gap-1 rounded-md px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-foreground/[0.05] hover:text-foreground"
    >
      <ChevronLeft size={14} aria-hidden />
      {teamName} Home
    </button>
  )

  const readFailedNote = readFailed ? (
    <div
      role="status"
      data-testid="goal-read-failed"
      className="flex flex-wrap items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm text-foreground"
    >
      <span className="min-w-0 flex-1">
        {detail
          ? 'This goal could not be read again, so what shows may be out of date.'
          : 'This goal could not be read.'}
      </span>
      <Button size="sm" variant="secondary" loading={retrying} onClick={() => void retry()}>
        Try again
      </Button>
    </div>
  ) : null

  if (missing) {
    return (
      <div className="flex flex-col gap-3" data-testid="goal-page">
        {back}
        <p className="text-sm text-muted-foreground">
          This goal is not on {teamName} any more. It may have been archived.
        </p>
      </div>
    )
  }
  if (!detail && readFailed) {
    return (
      <div className="flex flex-col gap-3" data-testid="goal-page">
        {back}
        {readFailedNote}
      </div>
    )
  }
  if (!detail) {
    return (
      <div className="flex flex-col gap-3" data-testid="goal-page">
        {back}
        <Skeleton height={28} width="45%" />
        <Skeleton height={14} width="70%" />
        <Skeleton height={80} />
      </div>
    )
  }

  const { summary, parent, children, healthHistory, tasks, kpis, updates, pages } = detail
  const { goal, progress, cost } = summary
  const drafts = updates.filter((u) => u.state === 'draft')
  const published = updates.filter((u) => u.state === 'published')
  const due = goal.targetDate !== null ? targetDateWords(goal.targetDate, now) : null
  const scope = scopeWords(progress)

  async function setHealth(value: string) {
    const health = (value || null) as GoalHealth | null
    const saved = await homeWrite('set the health', () => setGoalHealth(teamId, goal.id, health))
    if (saved) changed()
  }

  async function setStatus(status: GoalStatus) {
    const saved = await homeWrite(
      'change the goal',
      () => updateGoal(teamId, goal.id, { status }),
      {
        success:
          status === 'done'
            ? 'Goal marked done.'
            : status === 'dropped'
              ? 'Goal dropped.'
              : 'Goal reopened.',
      },
    )
    if (saved) changed()
  }

  async function archive() {
    const ok = await confirm({
      title: `Archive ${goal.title}?`,
      message:
        'It leaves Home. Its tasks keep their link and its updates are kept. Goals under it lose their parent.',
      confirmLabel: 'Archive',
      tone: 'danger',
    })
    if (!ok) return
    const done = await homeWrite('archive the goal', () => archiveGoal(teamId, goal.id), {
      success: 'Goal archived.',
    })
    if (done) {
      actions.changed()
      actions.back()
    }
  }

  return (
    <div className="flex flex-col gap-7" data-testid="goal-page">
      <div className="flex flex-col gap-3">
        {back}
        {readFailedNote}
        <div className="flex flex-wrap items-start gap-3">
          <span className="mt-2" style={{ opacity: summary.updateMissing ? 0.45 : 1 }}>
            <HealthDot health={goal.health} size={12} />
          </span>
          <div className="min-w-0 flex-1">
            <h2
              ref={headingRef}
              tabIndex={-1}
              className="m-0 text-section font-semibold tracking-tight text-foreground outline-none"
              data-testid="goal-title-heading"
            >
              {goal.title}
            </h2>
            <p className="m-0 mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
              {goal.status !== 'active' ? (
                <span className="font-semibold uppercase tracking-wide">
                  {goal.status === 'done' ? 'Done' : 'Dropped'}
                </span>
              ) : null}
              <span>Owner: {goal.owner ? actorName(goal.owner, names) : 'nobody'}</span>
              {due ? (
                <span className={due.overdue ? 'text-destructive' : undefined}>{due.text}</span>
              ) : null}
              <span>Update every {goal.updateCadenceDays}d</span>
              {parent ? (
                <button
                  type="button"
                  onClick={() => actions.openGoal(parent.id)}
                  className="cursor-pointer underline decoration-border underline-offset-2 hover:text-foreground"
                >
                  Under {parent.title}
                </button>
              ) : null}
              {summary.updateMissing ? (
                <span className="board-reason font-semibold">Update missing</span>
              ) : null}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Select
              size="sm"
              aria-label="Health"
              data-testid="goal-health"
              value={goal.health ?? NO_HEALTH}
              onChange={(v) => void setHealth(v)}
              options={[
                { value: NO_HEALTH, label: 'No health set' },
                ...GOAL_HEALTHS.map((h) => ({ value: h, label: HEALTH_LABEL[h] })),
              ]}
            />
            <Button
              size="sm"
              variant="secondary"
              onClick={() =>
                actions.editGoal(goal, {
                  parent,
                  childCount: Math.max(children.length, summary.childCount),
                })
              }
              data-testid="goal-edit"
            >
              <Pencil size={14} aria-hidden />
              Edit
            </Button>
            {goal.status === 'active' ? (
              <Button size="sm" variant="secondary" onClick={() => void setStatus('done')}>
                Mark done
              </Button>
            ) : (
              <Button size="sm" variant="secondary" onClick={() => void setStatus('active')}>
                Reopen
              </Button>
            )}
            {goal.status === 'active' ? (
              <Button size="sm" variant="ghost" onClick={() => void setStatus('dropped')}>
                Drop
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void archive()}
              data-testid="goal-archive"
            >
              <Archive size={14} aria-hidden />
              Archive
            </Button>
          </div>
        </div>
        {goal.archivedAt !== null ? (
          <p
            role="status"
            data-testid="goal-archived-note"
            className="m-0 rounded-lg border border-border px-3 py-2 text-sm text-foreground"
          >
            This goal is archived, so it takes no updates. Its tasks keep their link.
          </p>
        ) : null}
        {goal.healthSetBy && goal.healthSetAt ? (
          <p className="m-0 text-xs text-muted-foreground">
            {healthLabel(goal.health)}, set by {actorName(goal.healthSetBy, names)}{' '}
            {relativeTime(goal.healthSetAt, now)}
          </p>
        ) : null}
        {goal.description.trim() ? (
          <div className="min-w-0 break-words text-sm text-foreground [&>*:first-child]:mt-0">
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>
              {goal.description}
            </ReactMarkdown>
          </div>
        ) : null}
      </div>

      <section
        aria-label="Progress and cost"
        className={`${HOME_CARD} grid gap-4 px-4 py-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]`}
        data-testid="goal-progress"
      >
        <div className="min-w-0">
          <div className="text-xs text-muted-foreground">Progress</div>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="text-xl font-semibold tabular-nums text-foreground">
              {progressPercent(progress)}%
            </span>
            <span className="truncate text-xs tabular-nums text-muted-foreground">
              {progressWords(progress)}
            </span>
          </div>
          <div className="mt-2">
            <ProgressBar
              percent={progressPercent(progress)}
              faded={summary.updateMissing}
              label={`Progress: ${progressWords(progress)}`}
            />
          </div>
          <div className="mt-1.5 text-xs text-muted-foreground">
            Computed from the board{scope ? `. ${scope[0]!.toUpperCase()}${scope.slice(1)}.` : '.'}
          </div>
        </div>
        <div className="min-w-0">
          <div className="text-xs text-muted-foreground">Cost of its tasks</div>
          <div className="mt-1 text-xl font-semibold tabular-nums text-foreground">
            {formatUsd(cost.usd)}
          </div>
          <div className="mt-1.5 text-xs text-muted-foreground" data-testid="goal-cost-note">
            {cost.includesEstimates
              ? 'Computed from runs, including estimates.'
              : 'Computed from runs.'}
          </div>
        </div>
      </section>

      <UpdatesSection
        teamId={teamId}
        goalId={goal.id}
        archived={goal.archivedAt !== null}
        drafts={drafts}
        published={published}
        now={now}
        names={names}
        onChanged={changed}
      />

      <HomeSection id="goal-tasks" title="Linked tasks" count={tasks.length}>
        {tasks.length === 0 ? (
          <p className="m-0 text-xs text-muted-foreground">
            No tasks yet. Pick this goal on a task in the board drawer, in New task, or for a
            request in team chat.
          </p>
        ) : (
          <div className={`${HOME_CARD} divide-y divide-border overflow-hidden`}>
            {tasks.map((t) => (
              <button
                key={t.taskId}
                type="button"
                data-testid="goal-task-row"
                className={HOME_ROW}
                onClick={() => actions.openTask(t.taskId)}
              >
                <span className="w-24 shrink-0 truncate text-xs text-muted-foreground">
                  {t.dropped ? 'Dropped' : statusLabel(t.status)}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                  {t.identifier ? (
                    <span className="mr-1.5 font-mono text-micro text-muted-foreground">
                      {t.identifier}
                    </span>
                  ) : null}
                  {t.title}
                  {t.isMainTask ? (
                    <span className="ml-1.5 text-xs text-muted-foreground">(request)</span>
                  ) : null}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground max-sm:hidden">
                  {LINK_WORDS[t.linkedVia]}
                </span>
                <span className="w-16 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                  {t.checked === true ? 'Checked' : t.checked === false ? 'Check failed' : ''}
                </span>
                <span className="w-16 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                  {t.costUsd > 0 ? formatUsd(t.costUsd) : ''}
                </span>
              </button>
            ))}
          </div>
        )}
      </HomeSection>

      <HomeSection
        id="goal-kpis"
        title="KPIs"
        count={kpis.length}
        action={
          <button type="button" className={HEADING_ACTION} onClick={() => actions.addKpi(goal.id)}>
            <Plus size={13} strokeWidth={2.25} aria-hidden />
            Add KPI
          </button>
        }
      >
        {kpis.length === 0 ? (
          <p className="m-0 text-xs text-muted-foreground">No KPIs on this goal yet.</p>
        ) : (
          <KpiGrid tiles={kpis} now={now} names={names} onOpen={actions.openKpi} />
        )}
      </HomeSection>

      {healthHistory.length > 0 ? (
        <HomeSection id="goal-health-history" title="Health history" count={healthHistory.length}>
          <ol className={`${HOME_CARD} m-0 list-none divide-y divide-border p-0`}>
            {healthHistory.map((h, i) => (
              <li key={`${h.setAt}:${i}`} className="flex items-center gap-3 px-3 py-2">
                <HealthDot health={h.health} size={9} decorative />
                <span className="text-sm text-foreground">{healthLabel(h.health)}</span>
                <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                  set by {actorName(h.setBy, names)}
                  {h.updateId ? ', publishing an update' : ''}
                </span>
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                  {formatDate(h.setAt, now)}
                </span>
              </li>
            ))}
          </ol>
        </HomeSection>
      ) : null}

      {goal.parentGoalId === null ? (
        <HomeSection
          id="goal-children"
          title="Goals under it"
          count={children.length}
          action={
            <button
              type="button"
              className={HEADING_ACTION}
              onClick={() =>
                actions.addChildGoal(goal.id, {
                  parent: { id: goal.id, title: goal.title },
                  childCount: 0,
                })
              }
            >
              <Plus size={13} strokeWidth={2.25} aria-hidden />
              Add goal
            </button>
          }
        >
          {children.length === 0 ? (
            <p className="m-0 text-xs text-muted-foreground">None yet.</p>
          ) : (
            <div className={`${HOME_CARD} divide-y divide-border overflow-hidden`}>
              {children.map((c) => (
                <GoalRow key={c.goal.id} summary={c} now={now} onOpen={actions.openGoal} />
              ))}
            </div>
          )}
        </HomeSection>
      ) : null}

      <HomeSection
        id="goal-pages"
        title="Pages"
        count={pages.length}
        action={
          <button type="button" className={HEADING_ACTION} onClick={() => actions.addPage(goal.id)}>
            <Plus size={13} strokeWidth={2.25} aria-hidden />
            New page
          </button>
        }
      >
        {pages.length === 0 ? (
          <p className="m-0 flex items-center gap-1.5 text-xs text-muted-foreground">
            <FileText size={13} aria-hidden />
            No pages on this goal yet.
          </p>
        ) : (
          <PageCards pages={pages} now={now} names={names} onOpen={actions.openPage} />
        )}
      </HomeSection>
    </div>
  )
}

// ─── Updates ─────────────────────────────────────────────────────────────────

function UpdatesSection({
  teamId,
  goalId,
  archived,
  drafts,
  published,
  now,
  names,
  onChanged,
}: {
  teamId: string
  goalId: string
  /** An archived goal takes no updates. */
  archived: boolean
  drafts: GoalUpdate[]
  published: GoalUpdate[]
  now: number
  names: HomeNames
  onChanged: () => void
}) {
  const [writing, setWriting] = useState(false)
  // Archived since the page was read: read again, so the page says so.
  const readAgainIfArchived = (code: string | null) => {
    if (code === 'goal_archived') {
      setWriting(false)
      onChanged()
    }
  }
  return (
    <HomeSection
      id="goal-updates"
      title="Updates"
      count={drafts.length + published.length}
      action={
        !writing && !archived ? (
          <button
            type="button"
            className={HEADING_ACTION}
            onClick={() => setWriting(true)}
            data-testid="goal-write-update"
          >
            <Plus size={13} strokeWidth={2.25} aria-hidden />
            Write an update
          </button>
        ) : null
      }
    >
      <div className="flex flex-col gap-2.5">
        {writing ? (
          <UpdateEditor
            submitLabel="Publish"
            onCancel={() => setWriting(false)}
            onSubmit={async (body, health) => {
              const done = await homeWrite(
                'publish the update',
                () => createGoalUpdate(teamId, goalId, { body, health }),
                { success: 'Update published.', onRefused: readAgainIfArchived },
              )
              if (done) {
                setWriting(false)
                onChanged()
              }
              return done !== null
            }}
          />
        ) : null}
        {drafts.map((u) => (
          <DraftCard
            key={u.id}
            teamId={teamId}
            update={u}
            now={now}
            names={names}
            onChanged={onChanged}
          />
        ))}
        {published.length === 0 && drafts.length === 0 && !writing ? (
          <p className="m-0 text-xs text-muted-foreground">
            No updates yet. Write one, or turn on weekly updates in Home settings so the lead drafts
            them.
          </p>
        ) : null}
        {published.map((u) => (
          <article
            key={u.id}
            data-testid="goal-update-published"
            className={`${HOME_CARD} px-4 py-3`}
          >
            <header className="mb-2 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
              {u.health ? <HealthDot health={u.health} size={8} decorative /> : null}
              {u.health ? <span className="text-foreground">{HEALTH_LABEL[u.health]}</span> : null}
              <span>
                {u.author?.kind === 'agent'
                  ? `Drafted by ${actorName(u.author, names)}, published by ${actorName(u.publishedBy, names)}`
                  : `By ${actorName(u.author, names)}`}
              </span>
              <span className="ml-auto tabular-nums">
                {u.publishedAt
                  ? `${formatDate(u.publishedAt, now)} · ${relativeTime(u.publishedAt, now)}`
                  : ''}
              </span>
            </header>
            <div className="min-w-0 break-words text-sm text-foreground [&>*:first-child]:mt-0">
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>
                {u.body}
              </ReactMarkdown>
            </div>
          </article>
        ))}
      </div>
    </HomeSection>
  )
}

function DraftCard({
  teamId,
  update,
  now,
  names,
  onChanged,
}: {
  teamId: string
  update: GoalUpdate
  now: number
  names: HomeNames
  onChanged: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  // Archived since the page was read (its drafts went with it): read again.
  const readAgainIfArchived = (code: string | null) => {
    if (code === 'goal_archived') onChanged()
  }

  async function publish(body?: string, health?: GoalHealth | null) {
    setBusy(true)
    const done = await homeWrite(
      'publish the update',
      () =>
        publishGoalUpdate(
          teamId,
          update.id,
          body === undefined ? {} : { body, health: health ?? null },
        ),
      { success: 'Update published.', onRefused: readAgainIfArchived },
    )
    setBusy(false)
    if (done) onChanged()
    return done !== null
  }

  async function discard() {
    setBusy(true)
    const done = await homeWrite('discard the draft', () => discardGoalUpdate(teamId, update.id))
    setBusy(false)
    if (done) onChanged()
  }

  return (
    <article
      data-testid="goal-update-draft"
      className="rounded-xl border border-dashed border-border-strong bg-surface px-4 py-3"
    >
      <header className="mb-2 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
        <span className="board-reason font-semibold uppercase tracking-wide">Draft</span>
        <span>
          by {actorName(update.author, names)}
          {update.executionId ? ' in a run' : ''}, {relativeTime(update.createdAt, now)}
        </span>
        {update.health ? (
          <span className="inline-flex items-center gap-1">
            <HealthDot health={update.health} size={8} decorative />
            suggests {HEALTH_LABEL[update.health]}
          </span>
        ) : null}
      </header>
      {editing ? (
        <UpdateEditor
          initialBody={update.body}
          initialHealth={update.health}
          submitLabel="Publish"
          onCancel={() => setEditing(false)}
          onSubmit={(body, health) => publish(body, health)}
        />
      ) : (
        <>
          <div className="min-w-0 break-words text-sm text-foreground [&>*:first-child]:mt-0">
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>
              {update.body}
            </ReactMarkdown>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="primary"
              loading={busy}
              onClick={() => void publish()}
              data-testid="draft-publish"
            >
              Publish
            </Button>
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => setEditing(true)}>
              Edit
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => void discard()}
              data-testid="draft-discard"
            >
              Discard
            </Button>
            {update.health ? (
              <span className="text-xs text-muted-foreground">
                Publishing sets the goal to {HEALTH_LABEL[update.health]}.
              </span>
            ) : null}
          </div>
        </>
      )}
    </article>
  )
}

function UpdateEditor({
  initialBody = '',
  initialHealth = null,
  submitLabel,
  onCancel,
  onSubmit,
}: {
  initialBody?: string
  initialHealth?: GoalHealth | null
  submitLabel: string
  onCancel: () => void
  onSubmit: (body: string, health: GoalHealth | null) => Promise<boolean>
}) {
  const bodyId = useId()
  const [body, setBody] = useState(initialBody)
  const [health, setHealth] = useState<string>(initialHealth ?? NO_HEALTH)
  const [busy, setBusy] = useState(false)
  const canSubmit = body.trim().length > 0 && !busy
  return (
    <form
      className="flex flex-col gap-2"
      data-testid="goal-update-editor"
      onSubmit={async (e) => {
        e.preventDefault()
        if (!canSubmit) return
        setBusy(true)
        await onSubmit(body.trim(), (health || null) as GoalHealth | null)
        setBusy(false)
      }}
    >
      <label htmlFor={bodyId} className="sr-only">
        Update
      </label>
      <textarea
        id={bodyId}
        data-testid="goal-update-body"
        className={TEXTAREA_CLASS}
        rows={5}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        disabled={busy}
        placeholder="What moved, what is next, what is in the way. Markdown works."
      />
      <div className="flex flex-wrap items-center gap-2">
        <Select
          size="sm"
          aria-label="Health with this update"
          value={health}
          onChange={setHealth}
          options={[
            { value: NO_HEALTH, label: 'Leave health as it is' },
            ...GOAL_HEALTHS.map((h) => ({ value: h, label: `Set ${HEALTH_LABEL[h]}` })),
          ]}
        />
        <span className="flex-1" />
        <Button size="sm" variant="secondary" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
        <Button
          size="sm"
          variant="primary"
          type="submit"
          disabled={!canSubmit}
          loading={busy}
          data-testid="goal-update-submit"
        >
          {submitLabel}
        </Button>
      </div>
    </form>
  )
}
