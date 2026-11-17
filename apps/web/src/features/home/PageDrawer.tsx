// A team page in a drawer: the markdown read, an editor, and its revision history.
//
// Every save is a new revision (agents write pages too, with write_page), so
// nothing is overwritten: History lists each revision with who wrote it (a person,
// or an agent and its run), and Restore makes a new revision that copies an old
// one. A page can be pinned to the team's Home, or archived.

import { useCallback, useEffect, useId, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Archive, Pencil, Pin, PinOff, RotateCcw, X } from 'lucide-react'

import {
  archivePage,
  createPage,
  getPage,
  getPageRevision,
  listPageRevisions,
  revertPage,
  setPagePinned,
  updatePage,
  type GoalSummary,
  type TeamPageRevision,
  type TeamPageRevisionMeta,
  type TeamPageWithBody,
} from '@clawboo/control-client'

import { MD_COMPONENTS } from '@/features/chat/chatComponents'
import { Button, IconButton } from '@/features/shared/Button'
import { Modal } from '@/features/shared/Modal'
import { Select } from '@/features/shared/Select'
import { Skeleton } from '@/features/shared/Skeleton'
import { Tabs } from '@/features/shared/Tabs'
import { confirm } from '@/stores/confirm'
import { useToastStore } from '@/stores/toast'

import { actorName, formatDate, relativeTime } from './homeFormat'
import { FIELD_LABEL, INPUT_CLASS, TEXTAREA_CLASS, FULL_WIDTH, goalOptions } from './homeForm'
import type { HomeNames } from './useHomeNames'
import { homeWrite } from './homeWrite'

/** What the drawer shows: a page by id, or a new page (optionally for a goal). */
export type PageTarget = { pageId: string } | { newPage: true; goalId?: string | null }

const NO_GOAL = ''

export function PageDrawer({
  target,
  onClose,
  teamId,
  goals,
  now,
  names,
  onChanged,
}: {
  /** Null: closed. */
  target: PageTarget | null
  onClose: () => void
  teamId: string
  goals: GoalSummary[]
  now: number
  names: HomeNames
  /** A page was saved, pinned, restored or archived: Home reads again. */
  onChanged: () => void
}) {
  return (
    <Modal
      open={target !== null}
      onClose={onClose}
      variant="drawer"
      label="Page"
      data-testid="page-drawer"
      panelClassName="surface-overlay-tier flex w-[640px] max-w-full flex-col overflow-hidden"
    >
      {target ? (
        <PageBody
          key={'pageId' in target ? target.pageId : 'new'}
          target={target}
          onClose={onClose}
          teamId={teamId}
          goals={goals}
          now={now}
          names={names}
          onChanged={onChanged}
        />
      ) : null}
    </Modal>
  )
}

function PageBody({
  target,
  onClose,
  teamId,
  goals,
  now,
  names,
  onChanged,
}: {
  target: PageTarget
  onClose: () => void
  teamId: string
  goals: GoalSummary[]
  now: number
  names: HomeNames
  onChanged: () => void
}) {
  const isNew = !('pageId' in target)
  // The page to read on open. A new page needs no read: saving it answers with it.
  const pageId = 'pageId' in target ? target.pageId : null
  const [page, setPage] = useState<TeamPageWithBody | null>(null)
  const [missing, setMissing] = useState(false)
  const [tab, setTab] = useState<'page' | 'history'>('page')
  const [editing, setEditing] = useState(isNew)

  const read = useCallback(async () => {
    if (!pageId) return
    try {
      const got = await getPage(teamId, pageId)
      if (got) setPage(got)
      else setMissing(true)
    } catch {
      setMissing(true)
    }
  }, [teamId, pageId])

  useEffect(() => {
    void read()
  }, [read])

  async function togglePin() {
    if (!page) return
    const saved = await homeWrite(page.pinned ? 'unpin the page' : 'pin the page', () =>
      setPagePinned(teamId, page.id, !page.pinned),
    )
    if (saved) {
      // Only the pin changes: a revision saved while the pin was on its way stays.
      setPage((p) => (p && p.id === saved.id ? { ...p, pinned: saved.pinned } : p))
      onChanged()
    }
  }

  async function archive() {
    if (!page) return
    const ok = await confirm({
      title: `Archive ${page.title}?`,
      message: 'It leaves Home and the goal it belongs to. Its revisions are kept.',
      confirmLabel: 'Archive',
      tone: 'danger',
    })
    if (!ok) return
    const done = await homeWrite('archive the page', () => archivePage(teamId, page.id), {
      success: 'Page archived.',
    })
    if (done) {
      onChanged()
      onClose()
    }
  }

  const header = (
    <div className="flex h-12 shrink-0 items-center gap-1 border-b border-border px-3">
      <span className="min-w-0 flex-1 truncate px-1 text-sm font-semibold text-foreground">
        {isNew && !page ? 'New page' : (page?.title ?? '')}
      </span>
      {page ? (
        <>
          <IconButton
            size="sm"
            label={page.pinned ? 'Unpin from Home' : 'Pin to Home'}
            aria-pressed={page.pinned}
            onClick={() => void togglePin()}
            data-testid="page-pin"
          >
            {page.pinned ? <PinOff size={15} aria-hidden /> : <Pin size={15} aria-hidden />}
          </IconButton>
          <IconButton
            size="sm"
            label="Archive page"
            onClick={() => void archive()}
            data-testid="page-archive"
          >
            <Archive size={15} aria-hidden />
          </IconButton>
        </>
      ) : null}
      <IconButton size="sm" label="Close" onClick={onClose}>
        <X size={16} aria-hidden />
      </IconButton>
    </div>
  )

  if (missing) {
    return (
      <>
        {header}
        <p className="p-5 text-sm text-muted-foreground">This page could not be read.</p>
      </>
    )
  }

  if (editing) {
    return (
      <>
        {header}
        <PageEditor
          teamId={teamId}
          page={page}
          goals={goals}
          defaultGoalId={'newPage' in target ? (target.goalId ?? null) : null}
          onCancel={() => (page ? setEditing(false) : onClose())}
          onSaved={(saved) => {
            setPage(saved)
            setEditing(false)
            onChanged()
          }}
        />
      </>
    )
  }

  return (
    <>
      {header}
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3">
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { id: 'page', label: 'Page' },
            { id: 'history', label: 'History', ...(page ? { count: page.revision } : {}) },
          ]}
        />
        <span className="flex-1" />
        {tab === 'page' && page ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setEditing(true)}
            data-testid="page-edit"
          >
            <Pencil size={14} aria-hidden />
            Edit
          </Button>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {!page ? (
          <div className="flex flex-col gap-2">
            <Skeleton height={18} width="50%" />
            <Skeleton height={14} />
            <Skeleton height={14} width="80%" />
          </div>
        ) : tab === 'page' ? (
          <>
            <p className="mb-4 text-xs text-muted-foreground" data-testid="page-byline">
              Revision {page.revision}, written by {actorName(page.updatedBy, names)}{' '}
              {relativeTime(page.updatedAt, now)}
            </p>
            {page.body.trim() ? (
              <div
                data-testid="page-body"
                className="min-w-0 break-words text-sm text-foreground [&>*:first-child]:mt-0"
              >
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>
                  {page.body}
                </ReactMarkdown>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">This page is empty.</p>
            )}
          </>
        ) : (
          <PageHistory
            teamId={teamId}
            page={page}
            now={now}
            names={names}
            onRestored={(saved) => {
              setPage(saved)
              setTab('page')
              onChanged()
            }}
          />
        )}
      </div>
    </>
  )
}

function PageEditor({
  teamId,
  page,
  goals,
  defaultGoalId,
  onCancel,
  onSaved,
}: {
  teamId: string
  page: TeamPageWithBody | null
  goals: GoalSummary[]
  defaultGoalId: string | null
  onCancel: () => void
  onSaved: (page: TeamPageWithBody) => void
}) {
  const ids = { title: useId(), body: useId() }
  const [title, setTitle] = useState(page?.title ?? '')
  const [body, setBody] = useState(page?.body ?? '')
  const [goalId, setGoalId] = useState(page?.goalId ?? defaultGoalId ?? NO_GOAL)
  const [pinned, setPinned] = useState(true)
  const [busy, setBusy] = useState(false)
  // A new title or text makes a revision; a new goal alone does not.
  const titleChanged = !page || title.trim() !== page.title
  const bodyChanged = !page || body !== page.body
  const goalChanged = !page || (goalId || null) !== page.goalId
  const changed = titleChanged || bodyChanged || goalChanged
  const canSave = title.trim().length > 0 && changed && !busy
  const saveNote = !page
    ? 'Saving makes revision 1.'
    : titleChanged || bodyChanged
      ? `Saving makes revision ${page.revision + 1}.`
      : goalChanged
        ? 'Saving changes only its goal, so it makes no new revision.'
        : null

  async function save() {
    if (!canSave) return
    setBusy(true)
    const saved = await homeWrite(page ? 'save the page' : 'add the page', () =>
      page
        ? updatePage(teamId, page.id, {
            // Only what changed, so a goal-only edit makes no revision.
            ...(titleChanged ? { title: title.trim() } : {}),
            ...(bodyChanged ? { body } : {}),
            ...(goalChanged ? { goalId: goalId || null } : {}),
          })
        : createPage(teamId, { title: title.trim(), body, goalId: goalId || null, pinned }),
    )
    setBusy(false)
    if (saved) onSaved(saved)
  }

  return (
    <form
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={(e) => {
        e.preventDefault()
        void save()
      }}
    >
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-4">
        <div>
          <label htmlFor={ids.title} className={FIELD_LABEL}>
            Title
          </label>
          <input
            id={ids.title}
            data-testid="page-title"
            className={INPUT_CLASS}
            maxLength={140}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            disabled={busy}
            placeholder="Launch checklist"
            autoComplete="off"
          />
        </div>
        <div className="flex min-h-0 flex-1 flex-col">
          <label htmlFor={ids.body} className={FIELD_LABEL}>
            Page (markdown)
          </label>
          <textarea
            id={ids.body}
            data-testid="page-body-input"
            className={`${TEXTAREA_CLASS} min-h-[240px] flex-1 font-mono text-[13px]`}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            disabled={busy}
            placeholder={'# Heading\n\nWhat the team should know.'}
          />
        </div>
        <div className="flex flex-wrap items-end gap-4">
          {goals.length > 0 || page?.goalId ? (
            <div className="min-w-[200px] flex-1">
              <span className={FIELD_LABEL}>Goal</span>
              <Select
                style={FULL_WIDTH}
                aria-label="Goal"
                value={goalId}
                onChange={setGoalId}
                disabled={busy}
                options={goalOptions(goals, page?.goalId ?? null)}
              />
            </div>
          ) : null}
          {!page ? (
            <label className="flex h-9 cursor-pointer items-center gap-2 text-sm text-foreground">
              <input
                type="checkbox"
                checked={pinned}
                onChange={(e) => setPinned(e.target.checked)}
                disabled={busy}
                className="size-4 accent-[var(--primary)]"
              />
              Pin to Home
            </label>
          ) : null}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2 border-t border-border px-5 py-3">
        <span className="text-xs text-muted-foreground">{saveNote}</span>
        <span className="flex-1" />
        <Button variant="secondary" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button
          type="submit"
          variant="primary"
          disabled={!canSave}
          loading={busy}
          data-testid="page-save"
        >
          {page ? 'Save' : 'Add page'}
        </Button>
      </div>
    </form>
  )
}

/** How many revisions the history reads at a time. */
const REVISIONS_PAGE = 50

type RevisionPreview =
  | { revision: number; state: 'loading' }
  | { revision: number; state: 'ready'; data: TeamPageRevision }
  | { revision: number; state: 'missing' | 'failed' }

function PageHistory({
  teamId,
  page,
  now,
  names,
  onRestored,
}: {
  teamId: string
  page: TeamPageWithBody
  now: number
  names: HomeNames
  onRestored: (page: TeamPageWithBody) => void
}) {
  // The list is newest first and without words, a page at a time; one revision's
  // words are read when it is picked.
  const [revisions, setRevisions] = useState<TeamPageRevisionMeta[] | null>(null)
  const [nextBefore, setNextBefore] = useState<number | null>(null)
  const [failed, setFailed] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [preview, setPreview] = useState<RevisionPreview | null>(null)
  const [busy, setBusy] = useState(false)
  const pickedRef = useRef<number | null>(null)

  useEffect(() => {
    let live = true
    setRevisions(null)
    setFailed(false)
    listPageRevisions(teamId, page.id, { limit: REVISIONS_PAGE })
      .then((list) => {
        if (!live) return
        setRevisions(list.revisions)
        setNextBefore(list.nextBefore)
      })
      .catch(() => {
        if (live) setFailed(true)
      })
    return () => {
      live = false
    }
  }, [teamId, page.id, page.revision])

  async function showOlder() {
    if (nextBefore === null) return
    setLoadingMore(true)
    try {
      const list = await listPageRevisions(teamId, page.id, {
        before: nextBefore,
        limit: REVISIONS_PAGE,
      })
      setRevisions((now) => [...(now ?? []), ...list.revisions])
      setNextBefore(list.nextBefore)
    } catch {
      useToastStore
        .getState()
        .addToast({ type: 'error', message: 'Couldn’t read older revisions. Please try again.' })
    } finally {
      setLoadingMore(false)
    }
  }

  async function pick(revision: number) {
    if (pickedRef.current === revision) {
      pickedRef.current = null
      setPreview(null)
      return
    }
    pickedRef.current = revision
    setPreview({ revision, state: 'loading' })
    try {
      const data = await getPageRevision(teamId, page.id, revision)
      // A later pick wins over a slow read for an earlier one.
      if (pickedRef.current !== revision) return
      setPreview(data ? { revision, state: 'ready', data } : { revision, state: 'missing' })
    } catch {
      if (pickedRef.current === revision) setPreview({ revision, state: 'failed' })
    }
  }

  if (failed) return <p className="text-sm text-muted-foreground">The history could not be read.</p>
  if (!revisions) {
    return (
      <div className="flex flex-col gap-2">
        <Skeleton height={14} />
        <Skeleton height={14} width="70%" />
      </div>
    )
  }

  async function restore(revision: number) {
    setBusy(true)
    const saved = await homeWrite(
      'restore the revision',
      () => revertPage(teamId, page.id, revision),
      { success: `Restored revision ${revision} as revision ${page.revision + 1}.` },
    )
    setBusy(false)
    if (saved) onRestored(saved)
  }

  const picked = preview?.revision ?? null

  return (
    <div className="flex flex-col gap-4">
      <ol className="m-0 flex list-none flex-col p-0" data-testid="page-revisions">
        {revisions.map((r) => (
          <li key={r.id} className="border-b border-border last:border-b-0">
            <button
              type="button"
              aria-pressed={picked === r.revision}
              onClick={() => void pick(r.revision)}
              className={[
                'flex w-full cursor-pointer flex-col gap-0.5 rounded-md px-2 py-2 text-left transition-colors hover:bg-foreground/[0.03]',
                picked === r.revision ? 'bg-foreground/[0.04]' : '',
              ].join(' ')}
            >
              <span className="flex items-baseline gap-2">
                <span className="text-sm font-medium text-foreground">Revision {r.revision}</span>
                {r.revision === page.revision ? (
                  <span className="text-micro font-semibold uppercase tracking-wide text-muted-foreground">
                    Current
                  </span>
                ) : null}
                <span className="ml-auto text-xs tabular-nums text-muted-foreground">
                  {formatDate(r.createdAt, now)} · {relativeTime(r.createdAt, now)}
                </span>
              </span>
              <span className="text-xs text-muted-foreground">
                {r.author?.kind === 'agent'
                  ? `Written by ${actorName(r.author, names)}${r.executionId ? ' in a run' : ''}`
                  : `Written by ${actorName(r.author, names)}`}
                {r.revertedFrom !== null ? `, restoring revision ${r.revertedFrom}` : ''}
                {`, ${r.bodyChars.toLocaleString('en-US')} ${r.bodyChars === 1 ? 'character' : 'characters'}`}
              </span>
            </button>
          </li>
        ))}
      </ol>
      {nextBefore !== null ? (
        <div>
          <Button
            size="sm"
            variant="ghost"
            loading={loadingMore}
            onClick={() => void showOlder()}
            data-testid="page-revisions-older"
          >
            Show older revisions
          </Button>
        </div>
      ) : null}
      {preview ? (
        <div className="rounded-xl border border-border p-4" data-testid="page-revision-preview">
          {preview.state === 'loading' ? (
            <div className="flex flex-col gap-2">
              <Skeleton height={16} width="40%" />
              <Skeleton height={14} />
            </div>
          ) : preview.state === 'ready' ? (
            <>
              <div className="mb-3 flex items-center gap-2">
                <span className="text-sm font-semibold text-foreground">{preview.data.title}</span>
                <span className="flex-1" />
                {preview.revision !== page.revision ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    loading={busy}
                    onClick={() => void restore(preview.revision)}
                    data-testid="page-restore"
                  >
                    <RotateCcw size={14} aria-hidden />
                    Restore this revision
                  </Button>
                ) : null}
              </div>
              <div className="min-w-0 break-words text-sm text-foreground [&>*:first-child]:mt-0">
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>
                  {preview.data.body || '_Empty_'}
                </ReactMarkdown>
              </div>
            </>
          ) : (
            <p className="m-0 text-sm text-muted-foreground">
              {preview.state === 'missing'
                ? 'That revision is not there any more.'
                : 'That revision could not be read.'}
            </p>
          )}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">Pick a revision to read it.</p>
      )}
    </div>
  )
}
