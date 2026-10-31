// What a budget points at, in words a person recognises. The budget form picks an
// agent, team or board task by name and submits its id; a budget row turns its
// stored id back into that name, and shows the bare id once the thing is gone.

import type { SelectOption } from '@/features/shared/Select'
import type { BoardTask } from '@/lib/boardClient'
import type { Budget, BudgetScope } from '@/lib/governanceClient'
import type { AgentState } from '@/stores/fleet'
import type { Team } from '@/stores/team'

/** The scopes the create form offers. The API also takes `tenant`, but nothing
 *  charges a tenant budget, so the form leaves it out (old tenant rows still show). */
export const CREATABLE_SCOPES = [
  'agent',
  'team',
  'mission',
] as const satisfies readonly BudgetScope[]
export type CreatableScope = (typeof CREATABLE_SCOPES)[number]

export type BudgetAgent = Pick<AgentState, 'id' | 'name' | 'teamId'>
export type BudgetTeam = Pick<Team, 'id' | 'name' | 'icon' | 'isArchived'>
export type BudgetTask = Pick<BoardTask, 'id' | 'title' | 'teamId' | 'parentTaskId' | 'updatedAt'>

export interface BudgetDirectory {
  agents: BudgetAgent[]
  teams: BudgetTeam[]
  tasks: BudgetTask[]
}

const NO_TEAM = 'no team'
const UNTITLED = 'Untitled task'

function teamNameOf(teams: BudgetTeam[], teamId: string | null | undefined): string | null {
  if (!teamId) return null
  return teams.find((t) => t.id === teamId)?.name ?? null
}

function byText(a: string, b: string): number {
  return a.localeCompare(b, undefined, { sensitivity: 'base' })
}

/** Every agent, labelled with its team so two agents with the same name stay apart. */
export function agentOptions(agents: BudgetAgent[], teams: BudgetTeam[]): SelectOption[] {
  return agents
    .map((a) => ({
      value: a.id,
      label: `${a.name || a.id} · ${teamNameOf(teams, a.teamId) ?? NO_TEAM}`,
    }))
    .sort((a, b) => byText(a.label, b.label))
}

/** Teams that are not archived, by name (the label leads with the team's emoji). */
export function teamOptions(teams: BudgetTeam[]): SelectOption[] {
  return teams
    .filter((t) => !t.isArchived)
    .sort((a, b) => byText(a.name, b.name))
    .map((t) => ({ value: t.id, label: `${t.icon} ${t.name}`.trim() }))
}

/** Top-level board tasks, newest first. Spend from a subtask is charged to the task
 *  at the top of its tree, so a budget on a subtask would never fill. */
export function missionOptions(tasks: BudgetTask[], teams: BudgetTeam[]): SelectOption[] {
  return tasks
    .filter((t) => !t.parentTaskId)
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    .map((t) => {
      const team = teamNameOf(teams, t.teamId)
      const title = t.title?.trim() || UNTITLED
      return { value: t.id, label: team ? `${title} · ${team}` : title }
    })
}

export function targetOptions(scope: CreatableScope, dir: BudgetDirectory): SelectOption[] {
  if (scope === 'agent') return agentOptions(dir.agents, dir.teams)
  if (scope === 'team') return teamOptions(dir.teams)
  return missionOptions(dir.tasks, dir.teams)
}

export interface BudgetTargetName {
  /** The agent, team or task name; null when it can't be found (show the id). */
  name: string | null
  /** A short muted note after the name: the agent's or task's team, or "archived". */
  detail: string | null
}

/** The name a budget row shows for its scope id. */
export function budgetTargetName(
  b: Pick<Budget, 'scope' | 'scopeId'>,
  dir: BudgetDirectory,
): BudgetTargetName {
  if (b.scope === 'agent') {
    const agent = dir.agents.find((a) => a.id === b.scopeId)
    if (!agent?.name) return { name: null, detail: null }
    return { name: agent.name, detail: teamNameOf(dir.teams, agent.teamId) ?? NO_TEAM }
  }
  if (b.scope === 'team') {
    const team = dir.teams.find((t) => t.id === b.scopeId)
    if (!team?.name) return { name: null, detail: null }
    return { name: `${team.icon} ${team.name}`.trim(), detail: team.isArchived ? 'archived' : null }
  }
  if (b.scope === 'mission') {
    const task = dir.tasks.find((t) => t.id === b.scopeId)
    if (!task) return { name: null, detail: null }
    return { name: task.title?.trim() || UNTITLED, detail: teamNameOf(dir.teams, task.teamId) }
  }
  return { name: null, detail: null }
}
