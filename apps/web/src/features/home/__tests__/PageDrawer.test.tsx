// A team page: its markdown read with who wrote the revision, an edit that makes
// a new revision, the history naming each revision's author (a person, or an
// agent in a run), restore as a new revision, pin, and a new page. A late pin
// answer changes only the pin, never an edit saved while it was on its way.

import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { TeamPageRevision, TeamPageWithBody } from '@clawboo/control-client'

import { HOME_FIXTURE_NOW, makeGoalSummary, makePage } from '@/__vitest__/homeFixtures'
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
    bodyChars: 34,
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
    bodyChars: 11,
    author: ME,
    executionId: null,
    revertedFrom: null,
    createdAt: HOME_FIXTURE_NOW - 86_400_000,
  },
]

/** The list answers without words; one revision's words come from its own read. */
const meta = ({ body: _body, ...rest }: TeamPageRevision) => rest

function serveRevisions(list = revisions) {
  const reads: string[] = []
  server.use(
    http.get('/api/home/teams/:teamId/pages/:pageId/revisions', ({ request }) => {
      reads.push(new URL(request.url).search)
      return HttpResponse.json({ revisions: list.map(meta), nextBefore: null })
    }),
    http.get('/api/home/teams/:teamId/pages/:pageId/revisions/:revision', ({ params }) => {
      const found = list.find((r) => r.revision === Number(params.revision))
      return found
        ? HttpResponse.json({ revision: found })
        : HttpResponse.json({ ok: false, error: 'revision_not_found' }, { status: 404 })
    }),
  )
  return reads
}

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
    const text = screen.getByTestId('page-body-input')
    await user.clear(text)
    await user.type(text, 'New body')
    expect(screen.getByText('Saving makes revision 3.')).toBeInTheDocument()
    await user.click(screen.getByTestId('page-save'))
    // Only what changed: the text.
    await waitFor(() => expect(body).toEqual({ body: 'New body' }), T)
    expect(await screen.findByTestId('page-byline', {}, T)).toHaveTextContent(
      'Revision 3, written by you',
    )
    expect(onChanged).toHaveBeenCalled()
  })

  it('moves a page to another goal without a new revision, and says so', async () => {
    let body: unknown = null
    server.use(
      http.get('/api/home/teams/:teamId/pages/:pageId', () => HttpResponse.json({ page: page() })),
      http.patch('/api/home/teams/:teamId/pages/:pageId', async ({ request }) => {
        body = await request.json()
        return HttpResponse.json({ page: page({ goalId: 'g1' }) })
      }),
    )
    const user = userEvent.setup()
    render(
      <PageDrawer
        target={{ pageId: 'p1' }}
        onClose={() => {}}
        teamId="t1"
        goals={[makeGoalSummary({ id: 'g1', title: 'Launch the beta' })]}
        now={HOME_FIXTURE_NOW}
        names={names}
        onChanged={() => {}}
      />,
    )
    await user.click(await screen.findByTestId('page-edit', {}, T))
    await user.click(screen.getByRole('button', { name: 'Goal' }))
    await user.click(await screen.findByRole('option', { name: 'Launch the beta' }))
    expect(
      screen.getByText('Saving changes only its goal, so it makes no new revision.'),
    ).toBeInTheDocument()
    await user.click(screen.getByTestId('page-save'))
    await waitFor(() => expect(body).toEqual({ goalId: 'g1' }), T)
  })

  it('names a linked goal that is no longer active in the editor', async () => {
    server.use(
      http.get('/api/home/teams/:teamId/pages/:pageId', () =>
        HttpResponse.json({ page: page({ goalId: 'g-done' }) }),
      ),
    )
    const user = userEvent.setup()
    render(
      <PageDrawer
        target={{ pageId: 'p1' }}
        onClose={() => {}}
        teamId="t1"
        goals={[makeGoalSummary({ id: 'g1', title: 'Launch the beta' })]}
        now={HOME_FIXTURE_NOW}
        names={names}
        onChanged={() => {}}
      />,
    )
    await user.click(await screen.findByTestId('page-edit', {}, T))
    expect(screen.getByRole('button', { name: 'Goal' })).toHaveTextContent(
      'A goal that is not active',
    )
  })

  it('lists who wrote each revision and restores an old one as a new revision', async () => {
    let reverted: unknown = null
    serveRevisions()
    server.use(
      http.get('/api/home/teams/:teamId/pages/:pageId', () => HttpResponse.json({ page: page() })),
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
    expect(list).toHaveTextContent('Written by Maya in a run, 34 characters')
    expect(list).toHaveTextContent('Written by you, 11 characters')
    await user.click(within(list).getByRole('button', { name: /Revision 1/ }))
    // Its words are read when it is picked.
    expect(
      await within(screen.getByTestId('page-revision-preview')).findByText('First draft', {}, T),
    ).toBeInTheDocument()
    await user.click(screen.getByTestId('page-restore'))
    await waitFor(() => expect(reverted).toEqual({ revision: 1 }), T)
    expect(await screen.findByTestId('page-byline', {}, T)).toHaveTextContent('Revision 3')
  })

  it('reads a long history a page at a time', async () => {
    const older: TeamPageRevision = { ...revisions[1]!, id: 'r0', revision: 0, title: 'Old' }
    const before: string[] = []
    server.use(
      http.get('/api/home/teams/:teamId/pages/:pageId', () => HttpResponse.json({ page: page() })),
      http.get('/api/home/teams/:teamId/pages/:pageId/revisions', ({ request }) => {
        const q = new URL(request.url).searchParams
        before.push(q.get('before') ?? '')
        return q.get('before') === '1'
          ? HttpResponse.json({ revisions: [meta(older)], nextBefore: null })
          : HttpResponse.json({ revisions: revisions.map(meta), nextBefore: 1 })
      }),
    )
    const user = userEvent.setup()
    renderDrawer()
    await screen.findByTestId('page-byline', {}, T)
    await user.click(screen.getByRole('tab', { name: /History/ }))
    await screen.findByTestId('page-revisions', {}, T)
    await user.click(screen.getByTestId('page-revisions-older'))
    await waitFor(
      () => expect(screen.getAllByRole('button', { name: /^Revision/ })).toHaveLength(3),
      T,
    )
    expect(before).toEqual(['', '1'])
    expect(screen.queryByTestId('page-revisions-older')).toBeNull()
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

describe('a pin that answers late', () => {
  it('keeps a revision saved while the pin was on its way', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    server.use(
      http.get('/api/home/teams/:teamId/pages/:pageId', () => HttpResponse.json({ page: page() })),
      http.post('/api/home/teams/:teamId/pages/:pageId/pin', async () => {
        await gate
        return HttpResponse.json({ page: makePage({ id: 'p1', revision: 2, pinned: false }) })
      }),
      http.patch('/api/home/teams/:teamId/pages/:pageId', () =>
        HttpResponse.json({ page: page({ revision: 3, updatedBy: ME, body: 'New body' }) }),
      ),
    )
    const user = userEvent.setup()
    renderDrawer()
    await user.click(await screen.findByTestId('page-pin', {}, T))
    await user.click(screen.getByTestId('page-edit'))
    const text = screen.getByTestId('page-body-input')
    await user.clear(text)
    await user.type(text, 'New body')
    await user.click(screen.getByTestId('page-save'))
    expect(await screen.findByTestId('page-byline', {}, T)).toHaveTextContent(
      'Revision 3, written by you',
    )
    await act(async () => {
      release()
      await new Promise((r) => setTimeout(r, 50))
    })
    await waitFor(
      () => expect(screen.getByTestId('page-pin')).toHaveAttribute('aria-pressed', 'false'),
      T,
    )
    expect(screen.getByTestId('page-byline')).toHaveTextContent('Revision 3, written by you')
    expect(screen.getByTestId('page-body')).toHaveTextContent('New body')
  })
})
