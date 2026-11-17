// A team page: its markdown read with who wrote the revision, an edit that makes
// a new revision, the history naming each revision's author (a person, or an
// agent in a run), restore as a new revision, pin, and a new page.

import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { TeamPageRevision, TeamPageWithBody } from '@clawboo/control-client'

import { HOME_FIXTURE_NOW, makePage } from '@/__vitest__/homeFixtures'
import { server } from '@/__vitest__/mswServer'

import { PageDrawer } from '../PageDrawer'

const T = { timeout: 4000 }
const names = { meId: 'local', agentName: (id: string) => (id === 'a1' ? 'Maya' : null) }
const ME = { kind: 'person' as const, id: 'local', name: 'You' }
const MAYA = { kind: 'agent' as const, id: 'a1', name: 'Maya' }

function page(over: Partial<TeamPageWithBody> = {}): TeamPageWithBody {
  return {
    ...makePage({
      id: 'p1',
      title: 'Launch checklist',
      revision: 2,
      updatedBy: MAYA,
      pinned: true,
    }),
    body: '# Launch checklist\n\n- Landing page',
    ...over,
  }
}

const revisions: TeamPageRevision[] = [
  {
    id: 'r2',
    pageId: 'p1',
    revision: 2,
    title: 'Launch checklist',
    body: '# Launch checklist\n\n- Landing page',
    author: MAYA,
    executionId: 'e1',
    revertedFrom: null,
    createdAt: HOME_FIXTURE_NOW,
  },
  {
    id: 'r1',
    pageId: 'p1',
    revision: 1,
    title: 'Launch checklist',
    body: 'First draft',
    author: ME,
    executionId: null,
    revertedFrom: null,
    createdAt: HOME_FIXTURE_NOW - 86_400_000,
  },
]

function renderDrawer(target: Parameters<typeof PageDrawer>[0]['target'] = { pageId: 'p1' }) {
  const onChanged = vi.fn()
  render(
    <PageDrawer
      target={target}
      onClose={() => {}}
      teamId="t1"
      goals={[]}
      now={HOME_FIXTURE_NOW}
      names={names}
      onChanged={onChanged}
    />,
  )
  return onChanged
}

afterEach(cleanup)

describe('a team page', () => {
  it('reads the page with who wrote its revision', async () => {
    server.use(
      http.get('/api/home/teams/:teamId/pages/:pageId', () => HttpResponse.json({ page: page() })),
    )
    renderDrawer()
    expect(await screen.findByTestId('page-byline', {}, T)).toHaveTextContent(
      'Revision 2, written by Maya',
    )
    expect(screen.getByTestId('page-body')).toHaveTextContent('Landing page')
  })

  it('saves an edit as a new revision', async () => {
    let body: unknown = null
    server.use(
      http.get('/api/home/teams/:teamId/pages/:pageId', () => HttpResponse.json({ page: page() })),
      http.patch('/api/home/teams/:teamId/pages/:pageId', async ({ request }) => {
        body = await request.json()
        return HttpResponse.json({
          page: page({ revision: 3, updatedBy: ME, body: 'New body' }),
        })
      }),
    )
    const user = userEvent.setup()
    const onChanged = renderDrawer()
    await user.click(await screen.findByTestId('page-edit', {}, T))
    expect(screen.getByText('Saving makes revision 3.')).toBeInTheDocument()
    const text = screen.getByTestId('page-body-input')
    await user.clear(text)
    await user.type(text, 'New body')
    await user.click(screen.getByTestId('page-save'))
    await waitFor(
      () => expect(body).toEqual({ title: 'Launch checklist', body: 'New body', goalId: null }),
      T,
    )
    expect(await screen.findByTestId('page-byline', {}, T)).toHaveTextContent(
      'Revision 3, written by you',
    )
    expect(onChanged).toHaveBeenCalled()
  })

  it('lists who wrote each revision and restores an old one as a new revision', async () => {
    let reverted: unknown = null
    server.use(
      http.get('/api/home/teams/:teamId/pages/:pageId', () => HttpResponse.json({ page: page() })),
      http.get('/api/home/teams/:teamId/pages/:pageId/revisions', () =>
        HttpResponse.json({ revisions }),
      ),
      http.post('/api/home/teams/:teamId/pages/:pageId/revert', async ({ request }) => {
        reverted = await request.json()
        return HttpResponse.json({
          page: page({ revision: 3, updatedBy: ME, body: 'First draft' }),
        })
      }),
    )
    const user = userEvent.setup()
    renderDrawer()
    await screen.findByTestId('page-byline', {}, T)
    await user.click(screen.getByRole('tab', { name: /History/ }))
    const list = await screen.findByTestId('page-revisions', {}, T)
    expect(list).toHaveTextContent('Written by Maya in a run')
    expect(list).toHaveTextContent('Written by you')
    await user.click(within(list).getByRole('button', { name: /Revision 1/ }))
    expect(screen.getByTestId('page-revision-preview')).toHaveTextContent('First draft')
    await user.click(screen.getByTestId('page-restore'))
    await waitFor(() => expect(reverted).toEqual({ revision: 1 }), T)
    expect(await screen.findByTestId('page-byline', {}, T)).toHaveTextContent('Revision 3')
  })

  it('unpins a pinned page', async () => {
    let pinned: unknown = null
    server.use(
      http.get('/api/home/teams/:teamId/pages/:pageId', () => HttpResponse.json({ page: page() })),
      http.post('/api/home/teams/:teamId/pages/:pageId/pin', async ({ request }) => {
        pinned = await request.json()
        return HttpResponse.json({ page: makePage({ id: 'p1', pinned: false }) })
      }),
    )
    const user = userEvent.setup()
    renderDrawer()
    await screen.findByTestId('page-byline', {}, T)
    await user.click(screen.getByRole('button', { name: 'Unpin from Home' }))
    await waitFor(() => expect(pinned).toEqual({ pinned: false }), T)
    expect(await screen.findByRole('button', { name: 'Pin to Home' }, T)).toBeInTheDocument()
  })

  it('writes a new page, pinned by default', async () => {
    let body: unknown = null
    server.use(
      http.post('/api/home/teams/:teamId/pages', async ({ request }) => {
        body = await request.json()
        return HttpResponse.json({
          page: page({
            id: 'p9',
            title: 'Brand voice',
            revision: 1,
            updatedBy: ME,
            body: 'Plain words.',
          }),
        })
      }),
    )
    const user = userEvent.setup()
    renderDrawer({ newPage: true, goalId: null })
    await user.type(await screen.findByTestId('page-title', {}, T), 'Brand voice')
    await user.type(screen.getByTestId('page-body-input'), 'Plain words.')
    await user.click(screen.getByTestId('page-save'))
    await waitFor(
      () =>
        expect(body).toEqual({
          title: 'Brand voice',
          body: 'Plain words.',
          goalId: null,
          pinned: true,
        }),
      T,
    )
    expect(await screen.findByTestId('page-byline', {}, T)).toHaveTextContent('Revision 1')
  })
})
