import { describe, expect, it } from 'vitest'

import type { ScheduleRecord } from '@clawboo/scheduler'

import {
  agentsForTeam,
  buildRoutineCreateSpec,
  buildRoutinePatch,
  cronError,
  deriveRoutineName,
  emptyRoutineForm,
  formatDuration,
  formatScheduleLabel,
  humanCron,
  NO_TEAM,
  nextRunPreview,
  routineFormFromRecord,
  routineFormProblem,
  runNowBlocker,
  runPill,
  runtimeDisplayName,
  statusPill,
  targetSummary,
  toggleBlocker,
  type RoutineFormValues,
} from '../routineHelpers'

const RECORD: ScheduleRecord = {
  id: 'clawboo-routine:r1',
  sourceScheduleId: 'r1',
  runtime: 'clawboo-native',
  owner: 'clawboo',
  source: 'clawboo-routine',
  agentId: 'a1',
  target: 'agent',
  teamId: 't1',
  teamName: 'Research',
  agentName: 'Ada',
  label: 'Inbox sweep',
  description: 'Draft replies to anything urgent.',
  cronSpec: '0 9 * * *',
  nextRunAt: 4_000_000_000_000,
  status: 'idle',
  manageability: 'managed',
  domain: 'team-task',
  tenantId: null,
}

const TEAM_FORM: RoutineFormValues = {
  kind: 'team',
  teamId: 't1',
  agentId: '',
  name: 'Standup',
  instructions: 'Post the standup.',
  cron: '0 9 * * 1-5',
}

describe('formatScheduleLabel', () => {
  it('renders a routine one-shot (once@<iso>) as a friendly label, not the raw spec', () => {
    expect(formatScheduleLabel('once@2026-07-01T09:00:00.000Z')).toBe(
      'once · 2026-07-01T09:00:00.000Z',
    )
  })

  it('falls back to the raw spec for a malformed once@ timestamp', () => {
    expect(formatScheduleLabel('once@not-a-date')).toBe('once@not-a-date')
  })

  it('keeps the Gateway dialects working', () => {
    expect(formatScheduleLabel('every:3600000')).toBe('every 1h')
    expect(formatScheduleLabel('every:300000')).toBe('every 5m')
    expect(formatScheduleLabel('at:2026-07-01T09:00:00.000Z')).toBe(
      'once · 2026-07-01T09:00:00.000Z',
    )
    expect(formatScheduleLabel('*/15 * * * *')).toBe('*/15 * * * *')
  })

  it('names a preset, and falls back to the spec otherwise', () => {
    expect(humanCron('0 * * * *')).toBe('Every hour')
    expect(humanCron('0 9 * * 1-5')).toBe('Weekdays · 9am')
    expect(humanCron('7 7 * * *')).toBe('7 7 * * *')
  })
})

describe('cron validation', () => {
  it('accepts a cron expression and previews its next run', () => {
    expect(cronError('30 8 * * 1-5')).toBeNull()
    expect(nextRunPreview('0 * * * *', Date.UTC(2026, 0, 1, 10, 30))).toBeGreaterThan(
      Date.UTC(2026, 0, 1, 10, 30),
    )
  })

  it('explains an empty, unreadable, or spent schedule', () => {
    expect(cronError('  ')).toMatch(/Enter a cron expression/)
    expect(cronError('every tuesday')).toMatch(/not a cron expression/)
    expect(cronError('once@2001-01-01T00:00:00.000Z')).toMatch(/never runs again/)
    expect(nextRunPreview('nonsense')).toBeNull()
  })
})

describe('statusPill', () => {
  it('reads an armed routine as on and a spent one-shot as finished', () => {
    expect(statusPill(RECORD)).toEqual({ tone: 'success', label: 'on' })
    expect(statusPill({ ...RECORD, nextRunAt: null })).toEqual({
      tone: 'done',
      label: 'finished',
    })
  })

  it('reads a failed routine as failed and a disabled Gateway job as disabled', () => {
    expect(statusPill({ ...RECORD, status: 'error' })).toEqual({ tone: 'error', label: 'failed' })
    expect(statusPill({ ...RECORD, status: 'paused' }).label).toBe('paused')
    expect(statusPill({ ...RECORD, status: 'paused', manageability: 'external-write' }).label).toBe(
      'disabled',
    )
    expect(statusPill({ ...RECORD, status: 'running' }).tone).toBe('working')
  })
})

describe('targetSummary', () => {
  it('names the team chat and its lead for a team routine', () => {
    expect(
      targetSummary({ target: 'team', teamName: 'Research', agentName: 'Boo Zero', agentId: '' }),
    ).toBe('Research team chat · Boo Zero leads')
    expect(targetSummary({ target: 'team', teamName: 'Research', agentId: '' })).toBe(
      'Research team chat',
    )
  })

  it('names the agent and its team for an agent routine, and a routine with no target is one', () => {
    expect(targetSummary(RECORD)).toBe('Ada · Research')
    expect(targetSummary({ agentName: 'Solo', agentId: 's1' })).toBe('Solo')
  })

  it('says so when the team or agent can no longer be found, instead of an id', () => {
    expect(targetSummary({ target: 'team', agentId: '' })).toBe('Team not found')
    expect(targetSummary({ agentId: 'raw-id', teamName: 'Research' })).toBe(
      'Agent not found · Research',
    )
  })
})

describe('what a routine can do right now', () => {
  it('pauses or resumes a routine at rest, but not one whose fire is in flight', () => {
    expect(toggleBlocker(RECORD)).toBeNull()
    expect(toggleBlocker({ ...RECORD, status: 'queued' })).toBeNull()
    expect(toggleBlocker({ ...RECORD, status: 'error' })).toBeNull()
    expect(toggleBlocker({ ...RECORD, status: 'claimed' })).toBe('it is running now')
    expect(toggleBlocker({ ...RECORD, status: 'running' })).toBe('it is running now')
  })

  it('runs now only from rest, and says why not otherwise', () => {
    expect(runNowBlocker(RECORD)).toBeNull()
    expect(runNowBlocker({ ...RECORD, status: 'paused' })).toBe('resume it first')
    expect(runNowBlocker({ ...RECORD, status: 'error' })).toBe('resume it first')
    expect(runNowBlocker({ ...RECORD, status: 'queued' })).toBe('it is about to run')
    expect(runNowBlocker({ ...RECORD, status: 'running' })).toBe('it is running now')
  })

  it('leaves a Gateway job to the Gateway: it can always be toggled or run', () => {
    const job = { ...RECORD, manageability: 'external-write' as const }
    expect(toggleBlocker({ ...job, status: 'running' })).toBeNull()
    expect(runNowBlocker({ ...job, status: 'paused' })).toBeNull()
  })
})

describe('deriveRoutineName', () => {
  it('uses the first non-empty line, shortened', () => {
    expect(deriveRoutineName('\n  Post the standup.\nThen more.')).toBe('Post the standup.')
    const long = 'x'.repeat(80)
    expect(deriveRoutineName(long)).toHaveLength(60)
    expect(deriveRoutineName(long).endsWith('...')).toBe(true)
    expect(deriveRoutineName('   ')).toBe('')
  })
})

describe('the form', () => {
  const agents = [
    { id: 'b', name: 'Bea', runtime: 'codex', teamId: 't1' },
    { id: 'a', name: 'Ada', runtime: 'clawboo-native', teamId: 't1' },
    { id: 's', name: 'Solo', runtime: 'openclaw', teamId: null },
  ]

  it('lists a team by name, and the standalone agents under NO_TEAM', () => {
    expect(agentsForTeam(agents, 't1').map((a) => a.id)).toEqual(['a', 'b'])
    expect(agentsForTeam(agents, NO_TEAM).map((a) => a.id)).toEqual(['s'])
    expect(agentsForTeam(agents, 'other')).toEqual([])
  })

  it('starts a new routine on the team being looked at, when it is one of the teams', () => {
    const teams = [
      { id: 't2', name: 'Zeta', icon: '' },
      { id: 't1', name: 'Alpha', icon: '' },
    ]
    expect(emptyRoutineForm(teams, 't2').teamId).toBe('t2')
    expect(emptyRoutineForm(teams, 'gone').teamId).toBe('t1')
    expect(emptyRoutineForm(teams, null).teamId).toBe('t1')
  })

  it('starts a new routine as a team routine on the first team by name', () => {
    expect(
      emptyRoutineForm([
        { id: 't2', name: 'Zeta', icon: '' },
        { id: 't1', name: 'Alpha', icon: '' },
      ]),
    ).toMatchObject({ kind: 'team', teamId: 't1', cron: '0 * * * *' })
  })

  it('reads an existing routine back into the form', () => {
    expect(routineFormFromRecord(RECORD)).toEqual({
      kind: 'agent',
      teamId: 't1',
      agentId: 'a1',
      name: 'Inbox sweep',
      instructions: 'Draft replies to anything urgent.',
      cron: '0 9 * * *',
    })
    expect(routineFormFromRecord({ ...RECORD, teamId: null })).toMatchObject({ teamId: NO_TEAM })
    expect(
      routineFormFromRecord({ ...RECORD, target: 'team', agentId: '', description: undefined }),
    ).toMatchObject({ kind: 'team', agentId: '', instructions: '' })
  })

  it('names what is missing before it can be saved', () => {
    expect(routineFormProblem(TEAM_FORM, { checkSchedule: true })).toBeNull()
    expect(routineFormProblem({ ...TEAM_FORM, teamId: '' }, { checkSchedule: true })).toBe(
      'Choose a team.',
    )
    expect(
      routineFormProblem({ ...TEAM_FORM, kind: 'agent', agentId: '' }, { checkSchedule: true }),
    ).toBe('Choose an agent.')
    expect(
      routineFormProblem({ ...TEAM_FORM, name: '', instructions: ' ' }, { checkSchedule: true }),
    ).toBe('Say what the routine should do.')
    expect(routineFormProblem({ ...TEAM_FORM, cron: 'bad' }, { checkSchedule: true })).toMatch(
      /cron/,
    )
    // An untouched schedule is not re-checked: editing the name of a spent
    // one-shot must still be possible.
    expect(
      routineFormProblem(
        { ...TEAM_FORM, cron: 'once@2001-01-01T00:00:00.000Z' },
        {
          checkSchedule: false,
        },
      ),
    ).toBeNull()
  })

  it('builds a team routine by team, and an agent routine by agent', () => {
    expect(buildRoutineCreateSpec(TEAM_FORM)).toEqual({
      source: 'clawboo-routine',
      domain: 'team-task',
      target: 'team',
      teamId: 't1',
      cronSpec: '0 9 * * 1-5',
      label: 'Standup',
      taskTemplate: { description: 'Post the standup.' },
    })
    expect(
      buildRoutineCreateSpec({
        ...TEAM_FORM,
        kind: 'agent',
        agentId: 's',
        teamId: NO_TEAM,
        name: '',
      }),
    ).toEqual({
      source: 'clawboo-routine',
      domain: 'team-task',
      target: 'agent',
      agentId: 's',
      teamId: null,
      cronSpec: '0 9 * * 1-5',
      label: 'Post the standup.',
      taskTemplate: { description: 'Post the standup.' },
    })
  })

  it('an edit sends only what changed, and nothing when nothing did', () => {
    expect(buildRoutinePatch(TEAM_FORM, { ...TEAM_FORM })).toBeNull()
    expect(buildRoutinePatch(TEAM_FORM, { ...TEAM_FORM, cron: '0 8 * * *' })).toEqual({
      cronSpec: '0 8 * * *',
    })
    expect(
      buildRoutinePatch(TEAM_FORM, { ...TEAM_FORM, name: 'Daily', instructions: 'New words.' }),
    ).toEqual({ label: 'Daily', taskTemplate: { description: 'New words.' } })
    expect(buildRoutinePatch(TEAM_FORM, { ...TEAM_FORM, kind: 'agent', agentId: 'a' })).toEqual({
      target: 'agent',
      teamId: 't1',
      agentId: 'a',
    })
    expect(
      buildRoutinePatch({ ...TEAM_FORM, kind: 'agent', agentId: 'a' }, { ...TEAM_FORM }),
    ).toEqual({ target: 'team', teamId: 't1', agentId: null })
  })
})

describe('run history display', () => {
  it('reads a team fire as posted and an agent fire as done', () => {
    expect(runPill('succeeded', 'team').label).toBe('posted')
    expect(runPill('succeeded', 'agent').label).toBe('done')
    expect(runPill('interrupted', 'agent').tone).toBe('warning')
    expect(runPill('failed', 'team').tone).toBe('error')
  })

  it('formats durations', () => {
    expect(formatDuration(4_200)).toBe('4s')
    expect(formatDuration(125_000)).toBe('2m 5s')
    expect(formatDuration(3_780_000)).toBe('1h 3m')
  })

  it('names runtimes, and leaves an unknown one as it is', () => {
    expect(runtimeDisplayName('openclaw')).toBe('OpenClaw')
    expect(runtimeDisplayName('mystery')).toBe('mystery')
  })
})
