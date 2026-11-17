// The KPI editor and a KPI's own dialog: a computed KPI picks from the closed
// metric list (its unit follows the metric), an agent KPI names who may report
// it, accepting a suggestion sends the person's edits, and a person types a
// value into a KPI whose source is a person, then sees it in the history.

import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { KpiValue } from '@clawboo/control-client'

import { HOME_FIXTURE_NOW, makeGoalSummary, makeKpi, makeKpiTile } from '@/__vitest__/homeFixtures'
import { server } from '@/__vitest__/mswServer'
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
