import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { apiFetch } from '@clawboo/control-client'
import { PERSON_CHECK_REFUSED, resetPersonCheckNotices } from '@/lib/personCheckNotice'
import { useConfirmStore } from '@/stores/confirm'
import { useToastStore } from '@/stores/toast'
import {
  pausedByWords,
  pauseOfAgent,
  pauseOfTeam,
  pauseSubjectWords,
  usePauseStore,
  type PauseView,
} from '@/stores/pauses'

import { latestPauseEvent } from '../latestPauseEvent'
import { PausedNotice, pauseWithConfirm, PauseToggle, resumeWithToast } from '../PausedNotice'

vi.mock('@clawboo/control-client', async (orig) => ({
  ...(await orig<typeof import('@clawboo/control-client')>()),
  apiFetch: vi.fn(),
}))

const mocked = vi.mocked(apiFetch)
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status })

const pause = (over: Partial<PauseView> = {}): PauseView => ({
  kind: 'agent',
  id: 'a1',
  name: 'Ada',
  reason: null,
  pausedBy: null,
  pausedAt: 1,
  ...over,
})

beforeEach(() => {
  mocked.mockReset()
  usePauseStore.setState({ pauses: [] })
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('the words for a pause', () => {
  it('names what is paused', () => {
    expect(pauseSubjectWords(pause())).toBe('Ada is paused')
    expect(pauseSubjectWords(pause({ kind: 'team', name: 'Growth' }))).toBe(
      'The Growth team is paused',
    )
    expect(pauseSubjectWords(pause({ kind: 'task_tree', name: 'Launch' }))).toBe(
      '“Launch” and the tasks under it are paused',
    )
  })

  it('says who paused it', () => {
    expect(pausedByWords(pause())).toBe('You paused it')
    expect(pausedByWords(pause({ pausedBy: { id: 'p', name: 'Sam', role: null } }))).toBe(
      'Sam paused it',
    )
  })
})

describe('what covers an agent', () => {
  it('reads its own pause first, then its team, in the order the server does', () => {
    const own = pause()
    const team = pause({ kind: 'team', id: 'T', name: 'Growth' })
    expect(pauseOfAgent([team, own], 'a1', 'T')).toBe(own)
    expect(pauseOfAgent([team], 'a1', 'T')).toBe(team)
    expect(pauseOfAgent([team], 'a1', 'U')).toBeNull()
    expect(pauseOfAgent([team], 'a1', null)).toBeNull()
    expect(pauseOfTeam([team], 'T')).toBe(team)
  })
})

describe('PausedNotice', () => {
  it('says who or what paused it and offers Resume', async () => {
    mocked.mockResolvedValueOnce(json({ ok: true }))
    mocked.mockResolvedValueOnce(json({ pauses: [] }))
    const onChanged = vi.fn()
    render(<PausedNotice pause={pause({ reason: 'checking its work' })} onChanged={onChanged} />)
    expect(screen.getByRole('status').textContent).toContain('Ada is paused.')
    expect(screen.getByRole('status').textContent).toContain('You paused it: checking its work')

    fireEvent.click(screen.getByRole('button', { name: 'Resume' }))
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
    expect(mocked).toHaveBeenCalledWith('/api/pauses/agent/a1', { method: 'DELETE' })
  })

  it('resumes a task tree by its root', async () => {
    mocked.mockResolvedValueOnce(json({ ok: true }))
    mocked.mockResolvedValueOnce(json({ pauses: [] }))
    const onChanged = vi.fn()
    render(<PausedNotice pause={pause({ kind: 'task_tree', id: 'root' })} onChanged={onChanged} />)
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }))
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
    expect(mocked).toHaveBeenCalledWith('/api/pauses/task/root', { method: 'DELETE' })
  })

  it('says why the person check refused a resume, instead of "try again"', async () => {
    resetPersonCheckNotices()
    useToastStore.setState({ toasts: [] })
    mocked.mockResolvedValueOnce(json({ ok: false, error: 'person_only' }, 403))
    expect(await resumeWithToast({ kind: 'agent', id: 'a1' })).toBe(false)
    expect(useToastStore.getState().toasts.map((t) => t.message)).toEqual([PERSON_CHECK_REFUSED])
  })

  it('says why the person check refused a pause, instead of "try again"', async () => {
    resetPersonCheckNotices()
    useToastStore.setState({ toasts: [] })
    mocked.mockResolvedValueOnce(json({ ok: false, error: 'person_only' }, 403))
    const paused = pauseWithConfirm({ kind: 'agent', id: 'a1' }, 'Ada')
    await waitFor(() => expect(useConfirmStore.getState().open).toBe(true))
    useConfirmStore.getState().settle(true)
    expect(await paused).toBe(false)
    expect(useToastStore.getState().toasts.map((t) => t.message)).toEqual([PERSON_CHECK_REFUSED])
  })

  it('still says try again when something else went wrong', async () => {
    useToastStore.setState({ toasts: [] })
    mocked.mockResolvedValueOnce(json({ error: 'boom' }, 500))
    expect(await resumeWithToast({ kind: 'agent', id: 'a1' })).toBe(false)
    expect(useToastStore.getState().toasts.map((t) => t.message)).toEqual([
      'Could not resume. Try again.',
    ])
  })

  it('adds what this pause does not cover when told to', () => {
    render(<PausedNotice pause={pause()} note="This chat runs in the Gateway." />)
    expect(screen.getByRole('status').textContent).toContain('This chat runs in the Gateway.')
  })
})

describe('PauseToggle', () => {
  it('asks first, then pauses', async () => {
    mocked.mockResolvedValueOnce(json({ ok: true }, 201))
    mocked.mockResolvedValueOnce(json({ pauses: [pause()] }))
    const onChanged = vi.fn()
    render(
      <PauseToggle
        target={{ kind: 'agent', id: 'a1' }}
        name="Ada"
        ownPause={null}
        onChanged={onChanged}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Pause Ada' }))
    await waitFor(() => expect(useConfirmStore.getState().open).toBe(true))
    expect(mocked).not.toHaveBeenCalled()
    useConfirmStore.getState().settle(true)
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
    expect(mocked.mock.calls[0]![0]).toBe('/api/pauses')
    expect(usePauseStore.getState().pauses).toHaveLength(1)
  })

  it('does nothing if the person backs out', async () => {
    const onChanged = vi.fn()
    render(
      <PauseToggle
        target={{ kind: 'team', id: 'T' }}
        name="Growth"
        ownPause={null}
        onChanged={onChanged}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Pause the Growth team' }))
    await waitFor(() => expect(useConfirmStore.getState().open).toBe(true))
    useConfirmStore.getState().settle(false)
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
    expect(mocked).not.toHaveBeenCalled()
  })

  it('resumes without asking when its own pause holds it', async () => {
    mocked.mockResolvedValueOnce(json({ ok: true }))
    mocked.mockResolvedValueOnce(json({ pauses: [] }))
    const onChanged = vi.fn()
    render(
      <PauseToggle
        target={{ kind: 'agent', id: 'a1' }}
        name="Ada"
        ownPause={pause()}
        onChanged={onChanged}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Resume Ada' }))
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
    expect(mocked.mock.calls[0]![0]).toBe('/api/pauses/agent/a1')
  })
})

describe('latestPauseEvent', () => {
  it('finds the newest pause event, and nothing in a tail without one', () => {
    expect(latestPauseEvent([{ seq: 4, kind: 'status_changed' }])).toBe(0)
    expect(
      latestPauseEvent([
        { seq: 5, kind: 'pause_placed' },
        { seq: 6, kind: 'cost' },
        { seq: 7, kind: 'pause_lifted' },
      ]),
    ).toBe(7)
  })
})
