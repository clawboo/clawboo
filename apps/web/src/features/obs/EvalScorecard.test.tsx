// Component test for the eval scorecard (the eval-from-UI surface). Uses the
// canonical component-test pattern: msw for the POST /api/eval/smoke round-trip,
// userEvent for the click, jest-dom matchers. Asserts the live SuiteReport shape
// + the CI-only ablation SHAPE (variant + contribution rows, em-dash placeholders,
// never run on demand).

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it } from 'vitest'

import { server } from '../../__vitest__/mswServer'
import { EvalScorecard } from './EvalScorecard'

const CANNED_REPORT = {
  tasks: [
    {
      taskId: 'reg-claim-409-no-retry',
      suite: 'regression',
      kind: 'coding',
      passAt1: 1,
      passPowK: 1,
      meanScore: 1,
    },
    {
      taskId: 'cap-delegation-fanout',
      suite: 'capability',
      kind: 'coordination',
      passAt1: 1,
      passPowK: 1,
      meanScore: 1,
    },
  ],
  passAt1: 1,
  passPowK: 1,
  k: 1,
}

afterEach(() => cleanup())

describe('EvalScorecard', () => {
  it('runs the smoke suite and renders the live SuiteReport', async () => {
    server.use(http.post('/api/eval/smoke', () => HttpResponse.json(CANNED_REPORT)))
    const user = userEvent.setup()
    render(<EvalScorecard />)

    expect(screen.queryByTestId('eval-suite-report')).not.toBeInTheDocument()
    await user.click(screen.getByTestId('obs-run-smoke-evals'))

    const report = await screen.findByTestId('eval-suite-report')
    expect(report).toBeInTheDocument()
    expect(screen.getAllByTestId('eval-task-row')).toHaveLength(2)
    expect(report).toHaveTextContent('100%')
    expect(report).toHaveTextContent('reg-claim-409-no-retry')
  })

  it('renders the real ablation scorecard SHAPE (variant + contribution rows) without a run', () => {
    render(<EvalScorecard />)
    // The ablation renders as a CI-only StatusPill + the real scorecard SHAPE:
    // 4 variant rows + 2 contribution rows (numbers are em-dash placeholders).
    expect(screen.getByText('CI only')).toBeInTheDocument()
    expect(screen.getByTestId('ablation-scorecard')).toBeInTheDocument()
    expect(screen.getAllByTestId('ablation-variant-row')).toHaveLength(4)
    expect(screen.getAllByTestId('ablation-contribution-row')).toHaveLength(2)
    // The variant labels (full / −verifier / −structured / none) render.
    expect(screen.getByText('full')).toBeInTheDocument()
    expect(screen.getByText('−verifier')).toBeInTheDocument()
    expect(screen.getByText('−structured')).toBeInTheDocument()
    expect(screen.getByText('none')).toBeInTheDocument()
    // The contribution subsystems render.
    expect(screen.getByText('verifier')).toBeInTheDocument()
    expect(screen.getByText('structured-state')).toBeInTheDocument()
    expect(screen.queryByTestId('eval-suite-report')).not.toBeInTheDocument()
  })
})
