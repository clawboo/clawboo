// Whether an agent already holds what a loose node stands for.
//
// Read off the canvas the same way the thread picker leaves held rows out, so a
// drop onto an agent that already has the thing says so instead of writing it
// a second time.

import { describe, expect, it } from 'vitest'

import { agentAlreadyHas } from '../attachLoose'

const nodes = [
  { id: 'skill-a1-web', type: 'skill', data: { name: 'Web Search' } },
  { id: 'resource-a1-gmail', type: 'resource', data: { connectorId: 'conn:connector:x:gmail' } },
  {
    id: 'resource-a1-sheets',
    type: 'resource',
    data: { connectorId: 'conn:connector:x:composio:app:googlesheets' },
  },
  { id: 'skill-a2-csv', type: 'skill', data: { name: 'CSV Analyzer' } },
]

describe('agentAlreadyHas', () => {
  it('finds a skill by name on that agent', () => {
    expect(
      agentAlreadyHas(nodes, 'a1', { kind: 'skill', ref: 'web-search', name: 'Web Search' }),
    ).toBe(true)
  })

  it('finds a connector by its slug, and an app by its toolkit', () => {
    expect(agentAlreadyHas(nodes, 'a1', { kind: 'connector', ref: 'gmail', name: 'Gmail' })).toBe(
      true,
    )
    expect(
      agentAlreadyHas(nodes, 'a1', { kind: 'app', ref: 'googlesheets', name: 'Google Sheets' }),
    ).toBe(true)
  })

  it("does not count another agent's tiles", () => {
    expect(
      agentAlreadyHas(nodes, 'a1', { kind: 'skill', ref: 'csv-analyzer', name: 'CSV Analyzer' }),
    ).toBe(false)
    expect(agentAlreadyHas(nodes, 'a2', { kind: 'connector', ref: 'gmail', name: 'Gmail' })).toBe(
      false,
    )
  })
})
