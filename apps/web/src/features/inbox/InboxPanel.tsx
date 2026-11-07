// The person's inbox: what wants them, across every team, from any browser.
//
//   · Needs you: what is waiting on them, the same cards the Board shows.
//   · Unread: what someone else changed or commented on since they last opened it.
//   · Mine: what is assigned to them, the same tasks as the Board's Mine filter.
//   · All: every task, newest change first.
//
// Read state lives on the server (see @clawboo/db's board/readState.ts). Opening a
// task is what reads it, and the Board's own drawer does the opening, so a task
// opened anywhere counts. No timer here beyond the Needs you cards' own approvals
// poll, as on the Board: the list reads again after the badge's read lands, so a
// burst of events costs one read of each, and a hidden tab reads neither.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence } from 'framer-motion'
import { Inbox } from 'lucide-react'

import { NeedsYouItems, useNeedsYou } from '@/features/board/NeedsYouColumn'
import { StatusGlyph, glyphKindOf } from '@/features/board/StatusGlyph'
import { TaskDetailDrawer, type DrawerPosition } from '@/features/board/TaskDetailDrawer'
import { taskOwnerOf } from '@/features/board/TaskCard'
import { boardColumnOf, isMyTask } from '@/features/board/boardStatus'
import { agoLabel } from '@/features/board/calendar/calendarFormat'
import { useBoardPerson } from '@/features/board/useBoardPerson'
import { CollapsedSidebarToggle } from '@/features/layout/SidebarToggle'
import { GitHubStarButton } from '@/features/promo/GitHubStarButton'
import { Button } from '@/features/shared/Button'
import { EmptyState } from '@/features/shared/EmptyState'
import { FormattedAlert } from '@/features/shared/FormattedAlert'
import { Select } from '@/features/shared/Select'
import { Skeleton } from '@/features/shared/Skeleton'
import { Tabs, type TabItem } from '@/features/shared/Tabs'
import { fetchBoardResult, type BoardTask } from '@/lib/boardClient'
import { useReadSequencer } from '@/lib/useReadSequencer'
import { useFleetStore } from '@/stores/fleet'
import { useTeamStore } from '@/stores/team'
import { useToastStore } from '@/stores/toast'

import { useInboxStore } from './inboxStore'
import {
  activityOf,
  byNewestChange,
  changeLabel,
  changedAt,
  isUnread,
  newestSeq,
  type InboxTab,
} from './inboxModel'

/** How many rows a list shows before asking. */
const PAGE = 100

/** What a tab says with nothing to list. Needs you has its own. */
const EMPTY: Record<Exclude<InboxTab, 'needs-you'>, { title: string; helper: string }> = {
  unread: {
    title: 'Nothing unread',
    helper: 'Comments and changes from anyone else show up here until you open the task.',
  },
  mine: {
    title: 'Nothing assigned to you',
    helper: 'Tasks you take on, and tasks an agent hands back to you, show up here.',
  },
  all: { title: 'No tasks yet', helper: 'Tasks from every team show up here.' },
}

function InboxRow({
  task,
  unread,
  detail,
  onOpen,
}: {
  task: BoardTask
  unread: boolean
  detail: string
  onOpen: (id: string) => void
}) {
  const at = changedAt(task)
  const title = task.title?.trim() || 'Untitled task'
  return (
    <li>
      <button
        type="button"
        data-testid="inbox-row"
        data-task-id={task.id}
        data-focus-restore-id={task.id}
        onClick={() => onOpen(task.id)}
        className="flex w-full cursor-pointer items-start gap-2.5 rounded-lg px-2 py-2 text-left transition-colors hover:bg-foreground/[0.035] focus-visible:outline-2 focus-visible:outline-offset-1"
      >
        <span aria-hidden className="flex h-[18px] shrink-0 items-center">
          <StatusGlyph kind={glyphKindOf(boardColumnOf(task))} />
        </span>
        <span className="min-w-0 flex-1">
          <span
            className={[
              'block truncate text-compact',
              unread ? 'font-semibold text-foreground' : 'text-foreground/70',
            ].join(' ')}
          >
            {title}
          </span>
          <span className="block truncate text-xs text-muted-foreground">{detail}</span>
        </span>
        <span className="flex h-[18px] shrink-0 items-center gap-2 text-xs tabular-nums text-muted-foreground">
          {at !== null ? agoLabel(at, Date.now()) : null}
          <span className="flex w-1.5 justify-center">
            {unread ? (
              <span
                data-testid="inbox-row-unread"
                className="inline-block size-1.5 rounded-full bg-foreground"
              >
                <span className="sr-only">Unread</span>
              </span>
            ) : null}
          </span>
        </span>
      </button>
    </li>
  )
}

export function InboxPanel() {
  const teams = useTeamStore((s) => s.teams)
  const agents = useFleetStore((s) => s.agents)
  const marks = useInboxStore((s) => s.marks)
  const allMark = useInboxStore((s) => s.allMark)
  const approvalsWaiting = useInboxStore((s) => s.approvals.length)
  const revision = useInboxStore((s) => s.revision)
  const addToast = useToastStore((s) => s.addToast)
  const me = useBoardPerson()

  const [teamFilter, setTeamFilter] = useState('all')
  const [tasks, setTasks] = useState<BoardTask[]>([])
  const [loaded, setLoaded] = useState(false)
  const [failed, setFailed] = useState(false)
  const [picked, setPicked] = useState<InboxTab | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  const [limit, setLimit] = useState(PAGE)
  const [announcement, setAnnouncement] = useState('')
  const tabsRef = useRef<HTMLDivElement>(null)

  // Reads can overlap (a wake, a filter change, an action on a card).
  const reads = useReadSequencer()
  const loadedRef = useRef(false)
  const refresh = useCallback(async () => {
    const read = reads.beginRead()
    const res = await fetchBoardResult(teamFilter === 'all' ? undefined : teamFilter)
    if (!read.isCurrent()) return
    if (res.ok) {
      setTasks(res.tasks)
      setFailed(false)
    } else {
      // A failed read after a good one keeps what is on screen.
      setFailed((was) => was || !loadedRef.current)
    }
    loadedRef.current = true
    setLoaded(true)
  }, [teamFilter, reads])

  // On opening, on a new filter, and after each read of the inbox lands.
  useEffect(() => {
    void refresh()
  }, [refresh, revision])

  const onFilter = useCallback((value: string) => {
    loadedRef.current = false
    setLoaded(false)
    setLimit(PAGE)
    setTeamFilter(value)
  }, [])

  const needsYou = useNeedsYou(teamFilter, tasks)
  const readMarks = useMemo(() => ({ marks, allMark }), [marks, allMark])
  const unreadList = useMemo(
    () => tasks.filter((t) => isUnread(t, readMarks) || t.id === openId).sort(byNewestChange),
    [tasks, readMarks, openId],
  )
  const unreadCount = useMemo(
    () => tasks.filter((t) => isUnread(t, readMarks)).length,
    [tasks, readMarks],
  )
  const allList = useMemo(() => [...tasks].sort(byNewestChange), [tasks])
  const mineList = useMemo(() => allList.filter((t) => isMyTask(t, me)), [allList, me])

  // Opens on what matters most, decided once: a list that swaps itself when an
  // approval arrives would move under the person's hand. The Needs you cards read
  // their approvals a moment after the tasks, so the badge's count stands in.
  if (picked === null && loaded) {
    setPicked(needsYou.total > 0 || approvalsWaiting > 0 ? 'needs-you' : 'unread')
  }
  const tab: InboxTab = picked ?? 'needs-you'
  const list = tab === 'unread' ? unreadList : tab === 'mine' ? mineList : allList
  const shown = list.slice(0, limit)

  const TABS: TabItem<InboxTab>[] = [
    { id: 'needs-you', label: 'Needs you', count: needsYou.total },
    { id: 'unread', label: 'Unread', count: unreadCount },
    { id: 'mine', label: 'Mine', count: mineList.length },
    { id: 'all', label: 'All', count: tasks.length },
  ]

  const detailOf = useCallback(
    (task: BoardTask): string => {
      const owner = taskOwnerOf(task)
      const agent = owner ? agents.find((a) => a.id === owner)?.name : undefined
      const team = teams.find((t) => t.id === task.teamId)?.name
      return [changeLabel(task), team, agent].filter(Boolean).join(' · ')
    },
    [agents, teams],
  )

  // J and K step through the list the drawer was opened from.
  const position = useMemo<DrawerPosition | null>(() => {
    if (!openId) return null
    const ids = list.map((t) => t.id)
    const index = ids.indexOf(openId)
    if (index < 0) return null
    return { index, total: ids.length, prev: ids[index - 1] ?? null, next: ids[index + 1] ?? null }
  }, [openId, list])

  const markAll = useCallback(async () => {
    const through = newestSeq(tasks)
    const unread = tasks.filter((t) => isUnread(t, readMarks))
    setAnnouncement('')
    // The button goes with the last unread task, so focus moves to the tabs.
    tabsRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus()
    const ok = await useInboxStore.getState().markAllRead(
      teamFilter === 'all'
        ? { through }
        : {
            through,
            teamId: teamFilter,
            shown: unread.map((t) => ({ id: t.id, seq: activityOf(t)?.seq ?? 0 })),
          },
    )
    if (ok) setAnnouncement('Everything marked read.')
    else addToast({ type: 'error', message: 'Couldn’t mark everything read. Please try again.' })
  }, [tasks, readMarks, teamFilter, addToast])

  const onTabChange = useCallback((next: InboxTab) => {
    setPicked(next)
    setLimit(PAGE)
  }, [])

  return (
    <div className="board-ink-focus flex h-full flex-col" data-testid="inbox-panel">
      <div
        data-testid="inbox-header"
        className="flex min-h-12 flex-wrap items-center gap-x-3 gap-y-1 px-4 pt-1"
      >
        <CollapsedSidebarToggle className="-ml-2 -mr-1" />
        <h1 className="text-xl font-semibold tracking-tight text-foreground">Inbox</h1>
        <Select
          size="sm"
          aria-label="Filter by team"
          value={teamFilter}
          onChange={(value) => onFilter(value)}
        >
          <option value="all">All teams</option>
          {teams.map((t) => (
            <option key={t.id} value={t.id}>
              {t.icon} {t.name}
            </option>
          ))}
        </Select>
        <div className="ml-auto flex items-center gap-2">
          <GitHubStarButton />
        </div>
      </div>

      <div className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col px-4">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 pt-1">
          <div ref={tabsRef} className="-ml-3 max-w-full overflow-x-auto">
            <Tabs tabs={TABS} value={tab} onChange={onTabChange} />
          </div>
          {/* It clears every unread task, so not from a tab showing only some of them. */}
          {(tab === 'unread' || tab === 'all') && unreadCount > 0 ? (
            <Button variant="ghost" size="sm" onClick={() => void markAll()}>
              Mark all read
            </Button>
          ) : null}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto pb-6 pt-2">
          {!loaded ? (
            <div aria-busy="true" aria-label="Loading your inbox" className="space-y-2 px-2 pt-2">
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : failed ? (
            // Said as such: "Nothing unread" here would be a claim it cannot make.
            <div data-testid="inbox-fetch-error" className="max-w-[460px] px-2 pt-2">
              <FormattedAlert tone="error">
                <span className="flex items-center gap-2">
                  Couldn’t load your inbox.
                  <Button variant="ghost" size="sm" onClick={() => void refresh()}>
                    Retry
                  </Button>
                </span>
              </FormattedAlert>
            </div>
          ) : tab === 'needs-you' ? (
            <NeedsYouItems
              model={needsYou}
              teamFilter={teamFilter}
              onOpenTask={setOpenId}
              onTasksChanged={() => void refresh()}
            />
          ) : shown.length === 0 ? (
            <div data-testid="inbox-empty">
              <EmptyState icon={Inbox} {...EMPTY[tab]} />
            </div>
          ) : (
            <>
              <ul>
                {shown.map((task) => (
                  <InboxRow
                    key={task.id}
                    task={task}
                    unread={isUnread(task, readMarks)}
                    detail={detailOf(task)}
                    onOpen={setOpenId}
                  />
                ))}
              </ul>
              {list.length > shown.length ? (
                <div className="px-2 pt-2">
                  <Button variant="ghost" size="sm" onClick={() => setLimit((n) => n + PAGE)}>
                    {`Show ${Math.min(PAGE, list.length - shown.length)} more`}
                  </Button>
                </div>
              ) : null}
            </>
          )}
        </div>
      </div>

      <div role="status" className="sr-only">
        {announcement}
      </div>

      <AnimatePresence
        // Closing the drawer hands focus back to the row that opened it. When the row
        // has left the list, it goes to the tabs rather than being lost to the page.
        onExitComplete={() => {
          const a = document.activeElement
          if (a && a !== document.body && a.isConnected) return
          tabsRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus()
        }}
      >
        {openId && (
          <TaskDetailDrawer
            taskId={openId}
            onClose={() => setOpenId(null)}
            onStatusCommitted={() => void refresh()}
            onChanged={() => void refresh()}
            position={position}
            onOpenTask={setOpenId}
          />
        )}
      </AnimatePresence>
    </div>
  )
}
