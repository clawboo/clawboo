import { describe, expect, it } from 'vitest'

import {
  CREATABLE_SCOPES,
  MAX_MISSION_OPTIONS,
  agentOptions,
  budgetTargetName,
  missionOptions,
  teamOptions,
  type BudgetDirectory,
  type BudgetTask,
  type BudgetTeam,
} from '../budgetTargets'

const TEAMS: BudgetTeam[] = [
  { id: 't-mkt', name: 'Marketing', icon: '📣', isArchived: false },
  { id: 't-eng', name: 'Engineering', icon: '🛠️', isArchived: false },
  { id: 't-old', name: 'Old team', icon: '📦', isArchived: true },
]

const DIR: BudgetDirectory = {
  teams: TEAMS,
  agents: [
    { id: 'a1', name: 'Researcher', teamId: 't-mkt' },
    { id: 'a2', name: 'researcher', teamId: 't-eng' },
    { id: 'a3', name: 'Archivist', teamId: 't-old' },
    { id: 'a4', name: 'Solo', teamId: null },
    { id: 'a5', name: 'Drifter', teamId: 't-gone' },
  ],
  tasks: [
    { id: 'root', title: 'Plan the launch', teamId: 't-mkt', parentTaskId: null, updatedAt: 2 },
    { id: 'child', title: 'Draft the post', teamId: 't-mkt', parentTaskId: 'root', updatedAt: 9 },
    { id: 'blank', title: '  ', teamId: null, parentTaskId: null, updatedAt: 4 },
  ],
}

describe('CREATABLE_SCOPES', () => {
  it('leaves out tenant, which nothing charges', () => {
    expect(CREATABLE_SCOPES).toEqual(['agent', 'team', 'mission'])
  })
})

describe('agentOptions', () => {
  it('labels every agent with its team and sorts by label, ignoring case', () => {
    expect(agentOptions(DIR.agents, TEAMS)).toEqual([
      { value: 'a3', label: 'Archivist · Old team' },
      { value: 'a5', label: 'Drifter · no team' },
      { value: 'a2', label: 'researcher · Engineering' },
      { value: 'a1', label: 'Researcher · Marketing' },
      { value: 'a4', label: 'Solo · no team' },
    ])
  })
})

describe('teamOptions', () => {
  it('lists teams that are not archived', () => {
    expect(teamOptions(TEAMS)).toEqual([
      { value: 't-eng', label: '🛠️ Engineering' },
      { value: 't-mkt', label: '📣 Marketing' },
    ])
  })
})

describe('missionOptions', () => {
  it('lists top-level tasks only, newest first', () => {
    expect(missionOptions(DIR.tasks, TEAMS)).toEqual([
      { value: 'blank', label: 'Untitled task' },
      { value: 'root', label: 'Plan the launch · Marketing' },
    ])
  })

  it('stops at the newest MAX_MISSION_OPTIONS tasks', () => {
    const many: BudgetTask[] = Array.from({ length: MAX_MISSION_OPTIONS + 5 }, (_, i) => ({
      id: `t${i}`,
      title: `Task ${i}`,
      parentTaskId: null,
      updatedAt: i,
    }))
    const options = missionOptions(many, TEAMS)
    expect(options).toHaveLength(MAX_MISSION_OPTIONS)
    expect(options[0]?.value).toBe(`t${MAX_MISSION_OPTIONS + 4}`)
  })

  it('does not reorder the list it was given', () => {
    const tasks = [...DIR.tasks]
    missionOptions(tasks, TEAMS)
    expect(tasks.map((t) => t.id)).toEqual(['root', 'child', 'blank'])
  })
})

describe('budgetTargetName', () => {
  it('names an agent with its team', () => {
    expect(budgetTargetName({ scope: 'agent', scopeId: 'a1' }, DIR)).toEqual({
      name: 'Researcher',
      detail: 'Marketing',
    })
    expect(budgetTargetName({ scope: 'agent', scopeId: 'a4' }, DIR)).toEqual({
      name: 'Solo',
      detail: 'no team',
    })
  })

  it('names a team and marks an archived one', () => {
    expect(budgetTargetName({ scope: 'team', scopeId: 't-mkt' }, DIR)).toEqual({
      name: '📣 Marketing',
      detail: null,
    })
    expect(budgetTargetName({ scope: 'team', scopeId: 't-old' }, DIR)).toEqual({
      name: '📦 Old team',
      detail: 'archived',
    })
  })

  it('names a mission by its task title and team', () => {
    expect(budgetTargetName({ scope: 'mission', scopeId: 'root' }, DIR)).toEqual({
      name: 'Plan the launch',
      detail: 'Marketing',
    })
    expect(budgetTargetName({ scope: 'mission', scopeId: 'blank' }, DIR)).toEqual({
      name: 'Untitled task',
      detail: null,
    })
  })

  it('has no name for a gone agent, team or task, or for a tenant', () => {
    for (const scope of ['agent', 'team', 'mission'] as const) {
      expect(budgetTargetName({ scope, scopeId: 'gone' }, DIR)).toEqual({
        name: null,
        detail: null,
      })
    }
    expect(budgetTargetName({ scope: 'tenant', scopeId: 'acme' }, DIR)).toEqual({
      name: null,
      detail: null,
    })
  })
})
