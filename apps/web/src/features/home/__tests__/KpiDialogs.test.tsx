// The KPI editor and a KPI's own dialog: a computed KPI picks from the closed
// metric list (its unit follows the metric), an agent KPI names who may report
// it, accepting a suggestion sends the person's edits, and a person types a
// value into a KPI whose source is a person, then sees it in the history. A save
// in flight keeps the editor open, a late history read never hides a newer one,
// and a value left open long enough turns stale. A KPI whose source changed says
// its history holds the earlier values. A dismissal holds the dialog that asked,
// and a late archive never closes another KPI's dialog.

import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { KpiValue } from '@clawboo/control-client'

import { HOME_FIXTURE_NOW, makeGoalSummary, makeKpi, makeKpiTile } from '@/__vitest__/homeFixtures'
import { server } from '@/__vitest__/mswServer'
import { ConfirmDialog } from '@/features/shared/ConfirmDialog'
import { useFleetStore } from '@/stores/fleet'

import { KpiDetailDialog } from '../KpiDetailDialog'
import { KpiDialog } from '../KpiDialog'

const T = { timeout: 4000 }
const names = { meId: 'local', agentName: (id: string) => (id === 'a1' ? 'Iris' : null) }

beforeEach(() => {
  useFleetStore.setState({
    agents: [
      { id: 'a1', name: 'Iris', teamId: 't1' },
      { id: 'a9', name: 'Elsewhere', teamId: 't2' },
    ] as never,
  })
})

afterEach(cleanup)

describe('the KPI editor', () => {
  it('defines a computed KPI from the closed metric list, in its unit', async () => {
    let body: Record<string, unknown> | null = null
    server.use(
      http.post('/api/home/teams/:teamId/kpis', async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>
        return HttpResponse.json({ kpi: makeKpiTile({ id: 'k-new', source: 'computed' }) })
      }),
    )
    const onSaved = vi.fn()
    const user = userEvent.setup()
    render(
      <KpiDialog
        mode={{ kind: 'new' }}
        onClose={() => {}}
        teamId="t1"
        goals={[]}
        onSaved={onSaved}
      />,
    )
    const dialog = await screen.findByTestId('kpi-dialog', {}, T)
    await user.type(within(dialog).getByTestId('kpi-name'), 'Spend')
    await user.click(within(dialog).getByTestId('kpi-metric'))
    const options = (await screen.findAllByRole('option')).map((o) => o.textContent)
    expect(options).toHaveLength(9)
    await user.click(screen.getByRole('option', { name: 'Spend' }))
    // A metric decides its own unit, so there is no unit field to fill.
    expect(within(dialog).queryByTestId('kpi-unit')).toBeNull()
    await user.type(within(dialog).getByTestId('kpi-target'), '25')
    await user.click(within(dialog).getByTestId('kpi-save'))
    await waitFor(
      () =>
        expect(body).toMatchObject({
          name: 'Spend',
          source: 'computed',
          metric: 'spend_usd',
          unit: '$',
          target: 25,
          staleAfterHours: null,
          reporterAgentId: null,
        }),
      T,
    )
    expect(onSaved).toHaveBeenCalled()
  })

  it("names who may report an agent KPI, from the team's agents only", async () => {
    let body: Record<string, unknown> | null = null
    server.use(
      http.post('/api/home/teams/:teamId/kpis', async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>
        return HttpResponse.json({ kpi: makeKpiTile({ id: 'k-new', source: 'agent' }) })
      }),
    )
    const user = userEvent.setup()
    render(
      <KpiDialog
        mode={{ kind: 'new' }}
        onClose={() => {}}
        teamId="t1"
        goals={[]}
        onSaved={() => {}}
      />,
    )
    const dialog = await screen.findByTestId('kpi-dialog', {}, T)
    await user.type(within(dialog).getByTestId('kpi-name'), 'Signups')
    await user.click(within(dialog).getByRole('radio', { name: 'An agent' }))
    await user.click(within(dialog).getByRole('button', { name: 'Who reports it' }))
    expect(screen.queryByRole('option', { name: 'Elsewhere' })).toBeNull()
    await user.click(screen.getByRole('option', { name: 'Iris' }))
    await user.type(within(dialog).getByTestId('kpi-unit'), 'signups')
    await user.type(within(dialog).getByTestId('kpi-stale-after'), '24')
    await user.click(within(dialog).getByTestId('kpi-save'))
    await waitFor(
      () =>
        expect(body).toMatchObject({
          source: 'agent',
          metric: null,
          reporterAgentId: 'a1',
          unit: 'signups',
          staleAfterHours: 24,
        }),
      T,
    )
  })

  it("accepts an agent's suggestion with the person's edits, or dismisses it", async () => {
    let accepted: Record<string, unknown> | null = null
    server.use(
      http.post('/api/home/teams/:teamId/kpis/:kpiId/accept', async ({ request }) => {
        accepted = (await request.json()) as Record<string, unknown>
        return HttpResponse.json({ kpi: makeKpiTile({ id: 'k-s' }) })
      }),
    )
    const suggested = makeKpi({
      id: 'k-s',
      name: 'Reply time',
      source: 'agent',
      unit: 'hours',
      direction: 'down',
      status: 'suggested',
      suggestedBy: { kind: 'agent', id: 'a1', name: 'Iris' },
      suggestionNote: 'Users mention replies',
    })
    const onDismiss = vi.fn()
    const user = userEvent.setup()
    render(
      <KpiDialog
        mode={{ kind: 'accept', kpi: suggested }}
        onClose={() => {}}
        teamId="t1"
        goals={[]}
        onSaved={() => {}}
        onDismissSuggestion={onDismiss}
      />,
    )
    const dialog = await screen.findByTestId('kpi-dialog', {}, T)
    expect(dialog).toHaveTextContent('Iris suggested this KPI')
    expect(dialog).toHaveTextContent('Users mention replies')
    await user.type(within(dialog).getByTestId('kpi-target'), '4')
    await user.click(within(dialog).getByTestId('kpi-save'))
    await waitFor(
      () => expect(accepted).toMatchObject({ name: 'Reply time', target: 4, direction: 'down' }),
      T,
    )
    await user.click(within(dialog).getByTestId('kpi-dismiss'))
    expect(onDismiss).toHaveBeenCalledWith(suggested)
  })
})

describe("the KPI editor's goal picker", () => {
  it('names a linked goal that is no longer active instead of showing No goal, and keeps it', async () => {
    let body: Record<string, unknown> | null = null
    server.use(
      http.patch('/api/home/teams/:teamId/kpis/:kpiId', async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>
        return HttpResponse.json({ kpi: makeKpiTile({ id: 'k1' }) })
      }),
    )
    const user = userEvent.setup()
    render(
      <KpiDialog
        mode={{ kind: 'edit', kpi: makeKpi({ id: 'k1', name: 'Signups', goalId: 'g-done' }) }}
        onClose={() => {}}
        teamId="t1"
        goals={[makeGoalSummary({ id: 'g1', title: 'Launch the beta' })]}
        onSaved={() => {}}
      />,
    )
    const dialog = await screen.findByTestId('kpi-dialog', {}, T)
    expect(within(dialog).getByRole('button', { name: 'Goal' })).toHaveTextContent(
      'A goal that is not active',
    )
    await user.click(within(dialog).getByTestId('kpi-save'))
    await waitFor(() => expect(body).toMatchObject({ goalId: 'g-done' }), T)
  })
})

describe("a KPI's dialog", () => {
  it('types a value into a person KPI and shows who typed each one', async () => {
    const stored: KpiValue[] = []
    let posted: Record<string, unknown> | null = null
    server.use(
      http.get('/api/home/teams/:teamId/kpis/:kpiId/values', () =>
        HttpResponse.json({ values: stored }),
      ),
      http.post('/api/home/teams/:teamId/kpis/:kpiId/values', async ({ request }) => {
        posted = (await request.json()) as Record<string, unknown>
        const v: KpiValue = {
          id: 'v1',
          kpiId: 'k1',
          value: 7,
          asOf: HOME_FIXTURE_NOW,
          reportedBy: { kind: 'person', id: 'local', name: 'You' },
          executionId: null,
          taskId: null,
          sourceUrl: null,
          note: 'From the CRM',
          createdAt: HOME_FIXTURE_NOW,
        }
        stored.unshift(v)
        return HttpResponse.json({
          value: v,
          kpi: makeKpiTile(
            { id: 'k1', name: 'Calls', unit: 'calls' },
            { value: 7, asOf: HOME_FIXTURE_NOW, latest: v, freshness: 'ok' },
          ),
        })
      }),
    )
    const onChanged = vi.fn()
    const user = userEvent.setup()
    render(
      <KpiDetailDialog
        tile={makeKpiTile({ id: 'k1', name: 'Calls', unit: 'calls' })}
        onClose={() => {}}
        teamId="t1"
        now={HOME_FIXTURE_NOW}
        names={names}
        onEdit={() => {}}
        onChanged={onChanged}
        onOpenTask={() => {}}
      />,
    )
    const dialog = await screen.findByTestId('kpi-detail', {}, T)
    expect(await within(dialog).findByText('No value typed yet.', {}, T)).toBeInTheDocument()
    await user.type(within(dialog).getByTestId('kpi-value-input'), '7')
    await user.type(within(dialog).getByLabelText('Note'), 'From the CRM')
    await user.click(within(dialog).getByTestId('kpi-add-value-save'))
    await waitFor(
      () => expect(posted).toEqual({ value: 7, note: 'From the CRM', sourceUrl: null }),
      T,
    )
    expect(await within(dialog).findByTestId('kpi-history', {}, T)).toHaveTextContent(
      'Typed by you',
    )
    expect(within(dialog).getByTestId('kpi-detail-value')).toHaveTextContent('7 calls')
    expect(onChanged).toHaveBeenCalled()
  })

  it("links an agent's value to the run's task, and offers no typing", async () => {
    server.use(
      http.get('/api/home/teams/:teamId/kpis/:kpiId/values', () =>
        HttpResponse.json({
          values: [
            {
              id: 'v1',
              kpiId: 'k2',
              value: 142,
              asOf: HOME_FIXTURE_NOW,
              reportedBy: { kind: 'agent', id: 'a1', name: 'Iris' },
              executionId: 'e1',
              taskId: 'task-1',
              sourceUrl: 'https://example.com/waitlist',
              note: null,
              createdAt: HOME_FIXTURE_NOW,
            },
          ],
        }),
      ),
    )
    const onOpenTask = vi.fn()
    const user = userEvent.setup()
    render(
      <KpiDetailDialog
        tile={makeKpiTile({ id: 'k2', name: 'Signups', source: 'agent' })}
        onClose={() => {}}
        teamId="t1"
        now={HOME_FIXTURE_NOW}
        names={names}
        onEdit={() => {}}
        onChanged={() => {}}
        onOpenTask={onOpenTask}
      />,
    )
    const history = await screen.findByTestId('kpi-history', {}, T)
    expect(history).toHaveTextContent('Reported by Iris')
    expect(screen.queryByTestId('kpi-add-value')).toBeNull()
    await user.click(within(history).getByRole('button', { name: 'Open its run' }))
    expect(onOpenTask).toHaveBeenCalledWith('task-1')
    expect(within(history).getByRole('link', { name: /Source/ })).toHaveAttribute(
      'href',
      'https://example.com/waitlist',
    )
  })

  it('says a computed KPI is worked out on read, with nothing typed', async () => {
    render(
      <KpiDetailDialog
        tile={makeKpiTile(
          { id: 'k3', name: 'Tasks done', source: 'computed', metric: 'tasks_done' },
          { value: 3, asOf: HOME_FIXTURE_NOW },
        )}
        onClose={() => {}}
        teamId="t1"
        now={HOME_FIXTURE_NOW}
        names={names}
        onEdit={() => {}}
        onChanged={() => {}}
        onOpenTask={() => {}}
      />,
    )
    const dialog = await screen.findByTestId('kpi-detail', {}, T)
    expect(dialog).toHaveTextContent('computed from the board')
    expect(dialog).toHaveTextContent('No agent or person types this number.')
  })
})

describe('a KPI save in flight', () => {
  it('keeps the editor open on Escape until the save lands', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    server.use(
      http.post('/api/home/teams/:teamId/kpis', async () => {
        await gate
        return HttpResponse.json({ kpi: makeKpiTile({ id: 'k-new', source: 'computed' }) })
      }),
    )
    const onClose = vi.fn()
    const user = userEvent.setup()
    render(
      <KpiDialog
        mode={{ kind: 'new' }}
        onClose={onClose}
        teamId="t1"
        goals={[]}
        onSaved={() => {}}
      />,
    )
    const dialog = await screen.findByTestId('kpi-dialog', {}, T)
    await user.type(within(dialog).getByTestId('kpi-name'), 'Done this week')
    await user.click(within(dialog).getByTestId('kpi-save'))
    await user.keyboard('{Escape}')
    expect(onClose).not.toHaveBeenCalled()
    release()
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1), T)
  })
})

describe("a KPI's dialog over time", () => {
  const typed = (value: number): KpiValue => ({
    id: `v${value}`,
    kpiId: 'k1',
    value,
    asOf: HOME_FIXTURE_NOW,
    reportedBy: { kind: 'person', id: 'local', name: 'You' },
    executionId: null,
    taskId: null,
    sourceUrl: null,
    note: null,
    createdAt: HOME_FIXTURE_NOW,
  })

  it('keeps the history read after a new value when the first read lands late', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    let reads = 0
    server.use(
      http.get('/api/home/teams/:teamId/kpis/:kpiId/values', async () => {
        reads += 1
        if (reads === 1) {
          await gate
          return HttpResponse.json({ values: [] })
        }
        return HttpResponse.json({ values: [typed(7)] })
      }),
      http.post('/api/home/teams/:teamId/kpis/:kpiId/values', () =>
        HttpResponse.json({
          value: typed(7),
          kpi: makeKpiTile(
            { id: 'k1', name: 'Calls', unit: 'calls' },
            { value: 7, asOf: HOME_FIXTURE_NOW, latest: typed(7), freshness: 'ok' },
          ),
        }),
      ),
    )
    const user = userEvent.setup()
    render(
      <KpiDetailDialog
        tile={makeKpiTile({ id: 'k1', name: 'Calls', unit: 'calls' })}
        onClose={() => {}}
        teamId="t1"
        now={HOME_FIXTURE_NOW}
        names={names}
        onEdit={() => {}}
        onChanged={() => {}}
        onOpenTask={() => {}}
      />,
    )
    const dialog = await screen.findByTestId('kpi-detail', {}, T)
    await user.type(within(dialog).getByTestId('kpi-value-input'), '7')
    await user.click(within(dialog).getByTestId('kpi-add-value-save'))
    expect(await within(dialog).findByTestId('kpi-history', {}, T)).toHaveTextContent(
      'Typed by you',
    )
    await act(async () => {
      release()
      await new Promise((r) => setTimeout(r, 50))
    })
    expect(within(dialog).getByTestId('kpi-history')).toHaveTextContent('Typed by you')
    expect(within(dialog).queryByText('No value typed yet.')).toBeNull()
  })

  it('turns a value stale while the dialog is open', async () => {
    server.use(
      http.get('/api/home/teams/:teamId/kpis/:kpiId/values', () =>
        HttpResponse.json({ values: [typed(5)] }),
      ),
    )
    const tile = makeKpiTile(
      { id: 'k1', name: 'Calls', unit: 'calls', staleAfterHours: 1 },
      { value: 5, asOf: HOME_FIXTURE_NOW - 30 * 60_000, latest: typed(5), freshness: 'ok' },
    )
    const props = {
      tile,
      onClose: () => {},
      teamId: 't1',
      names,
      onEdit: () => {},
      onChanged: () => {},
      onOpenTask: () => {},
    }
    const { rerender } = render(<KpiDetailDialog {...props} now={HOME_FIXTURE_NOW} />)
    const dialog = await screen.findByTestId('kpi-detail', {}, T)
    expect(dialog).not.toHaveTextContent('Stale')
    rerender(<KpiDetailDialog {...props} now={HOME_FIXTURE_NOW + 2 * 60 * 60_000} />)
    expect(screen.getByTestId('kpi-detail')).toHaveTextContent('expected every hour')
  })
})

describe('a KPI whose source changed', () => {
  it('says it has no value from its current source while the history keeps the old ones', async () => {
    server.use(
      http.get('/api/home/teams/:teamId/kpis/:kpiId/values', () =>
        HttpResponse.json({
          values: [
            {
              id: 'v1',
              kpiId: 'k5',
              value: 142,
              asOf: HOME_FIXTURE_NOW,
              reportedBy: { kind: 'agent', id: 'a1', name: 'Iris' },
              executionId: 'e1',
              taskId: null,
              sourceUrl: null,
              note: null,
              createdAt: HOME_FIXTURE_NOW,
            },
          ],
        }),
      ),
    )
    render(
      <KpiDetailDialog
        // It was an agent's, and a person types it now.
        tile={makeKpiTile({ id: 'k5', name: 'Signups', source: 'person' })}
        onClose={() => {}}
        teamId="t1"
        now={HOME_FIXTURE_NOW}
        names={names}
        onEdit={() => {}}
        onChanged={() => {}}
        onOpenTask={() => {}}
      />,
    )
    expect(await screen.findByTestId('kpi-history', {}, T)).toHaveTextContent('Reported by Iris')
    expect(screen.getByTestId('kpi-detail-provenance')).toHaveTextContent(
      'No value from its current source yet. The history keeps the values from before.',
    )
    expect(screen.getByTestId('kpi-detail-value')).toHaveTextContent('No value')
  })

  it('still says no value typed yet when there is no history at all', async () => {
    render(
      <KpiDetailDialog
        tile={makeKpiTile({ id: 'k6', name: 'Calls', source: 'person' })}
        onClose={() => {}}
        teamId="t1"
        now={HOME_FIXTURE_NOW}
        names={names}
        onEdit={() => {}}
        onChanged={() => {}}
        onOpenTask={() => {}}
      />,
    )
    expect(await screen.findByText('No value typed yet.', {}, T)).toBeInTheDocument()
    expect(screen.getByTestId('kpi-detail-provenance')).toHaveTextContent('No value typed yet')
  })
})

describe('dismissing a suggestion from its dialog', () => {
  it('holds the dialog while the dismissal runs, then closes it', async () => {
    let release!: (done: boolean) => void
    const dismissal = new Promise<boolean>((r) => (release = r))
    const onClose = vi.fn()
    const user = userEvent.setup()
    render(
      <KpiDialog
        mode={{
          kind: 'accept',
          kpi: makeKpi({ id: 'k-sugg', name: 'Reply time', status: 'suggested' }),
        }}
        onClose={onClose}
        teamId="t1"
        goals={[]}
        onSaved={() => {}}
        onDismissSuggestion={() => dismissal}
      />,
    )
    const dialog = await screen.findByTestId('kpi-dialog', {}, T)
    await user.click(within(dialog).getByTestId('kpi-dismiss'))
    expect(within(dialog).getByTestId('kpi-dismiss')).toBeDisabled()
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled()
    expect(within(dialog).getByTestId('kpi-name')).toBeDisabled()
    await user.keyboard('{Escape}')
    expect(onClose).not.toHaveBeenCalled()
    await act(async () => release(true))
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1), T)
  })

  it('stays open when the dismissal fails', async () => {
    const onClose = vi.fn()
    const user = userEvent.setup()
    render(
      <KpiDialog
        mode={{
          kind: 'accept',
          kpi: makeKpi({ id: 'k-sugg', name: 'Reply time', status: 'suggested' }),
        }}
        onClose={onClose}
        teamId="t1"
        goals={[]}
        onSaved={() => {}}
        onDismissSuggestion={() => Promise.resolve(false)}
      />,
    )
    const dialog = await screen.findByTestId('kpi-dialog', {}, T)
    await user.click(within(dialog).getByTestId('kpi-dismiss'))
    await waitFor(() => expect(within(dialog).getByTestId('kpi-dismiss')).toBeEnabled(), T)
    expect(onClose).not.toHaveBeenCalled()
  })
})

describe('archiving a KPI that answers late', () => {
  it('does not close the dialog of a KPI opened meanwhile', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    server.use(
      http.delete('/api/home/teams/:teamId/kpis/:kpiId', async () => {
        await gate
        return HttpResponse.json({ kpi: makeKpi({ id: 'k1', status: 'archived' }) })
      }),
    )
    const onClose = vi.fn()
    const onChanged = vi.fn()
    const user = userEvent.setup()
    const props = {
      onClose,
      teamId: 't1',
      now: HOME_FIXTURE_NOW,
      names,
      onEdit: () => {},
      onChanged,
      onOpenTask: () => {},
    }
    const first = makeKpiTile({ id: 'k1', name: 'Calls', source: 'computed', metric: 'tasks_done' })
    const { rerender } = render(
      <>
        <KpiDetailDialog {...props} tile={first} />
        <ConfirmDialog />
      </>,
    )
    await user.click(await screen.findByTestId('kpi-archive', {}, T))
    await user.click(
      within(await screen.findByTestId('confirm-dialog', {}, T)).getByTestId('confirm-ok'),
    )
    // The person opens another KPI before the archive answers.
    const second = makeKpiTile({
      id: 'k2',
      name: 'Signups',
      source: 'computed',
      metric: 'tasks_done',
    })
    rerender(
      <>
        <KpiDetailDialog {...props} tile={second} />
        <ConfirmDialog />
      </>,
    )
    await act(async () => {
      release()
      await new Promise((r) => setTimeout(r, 50))
    })
    await waitFor(() => expect(onChanged).toHaveBeenCalled(), T)
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByTestId('kpi-detail')).toHaveTextContent('Signups')
  })
})
