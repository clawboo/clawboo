import { describe, expect, it } from 'vitest'

import {
  acceptedPlanSteps,
  answerForAgent,
  answerWords,
  delegationTargetOf,
  encodeHumanAssignment,
  encodePlanHolder,
  isHumanAssignment,
  isPlanHolder,
  normalizeAnswer,
  parseQuestionPayload,
  planStepsMatch,
  planWaitsForPerson,
  renderPlanBody,
  type QuestionPayload,
  type SuggestedTask,
} from '../index'

const proposed: SuggestedTask[] = [
  {
    title: 'Run the tests',
    description: 'Run the tests and say what fails',
    agentId: 'a2',
    agentName: 'Bug Boo',
  },
  { title: 'Fix what fails', agentId: 'a3', agentName: 'Design Boo' },
]

describe('a plan as a question', () => {
  it('keeps who each step goes to and which revision it asks about', () => {
    const raw = JSON.stringify({
      prompt: 'Lead proposes a plan.',
      tasks: proposed,
      plan: { revision: 3, parentTaskId: 'p1', holder: true },
    })
    const payload = parseQuestionPayload(raw) as QuestionPayload
    expect(payload.tasks?.[0]?.agentId).toBe('a2')
    expect(payload.tasks?.[0]?.agentName).toBe('Bug Boo')
    expect(payload.plan).toEqual({ revision: 3, parentTaskId: 'p1', holder: true })
    expect(planWaitsForPerson(payload)).toBe(true)
  })

  it('keeps that a batch of hand-offs starts together', () => {
    const payload = parseQuestionPayload({
      prompt: 'Lead hands out two.',
      tasks: proposed,
      plan: { revision: 1, parentTaskId: null, holder: true, parallel: true },
    })
    expect(payload?.plan?.parallel).toBe(true)
  })

  it('a suggestion with no plan part stays what it was', () => {
    const payload = parseQuestionPayload({ prompt: 'Split it?', tasks: [{ title: 'One' }] })
    expect(payload?.plan).toBeUndefined()
    expect(planWaitsForPerson(payload!)).toBe(false)
  })

  it('reads a broken plan part as no plan, never as revision 0', () => {
    const payload = parseQuestionPayload({
      prompt: 'Split it?',
      tasks: [{ title: 'One' }],
      plan: { revision: 'x' },
    })
    expect(payload?.plan).toBeUndefined()
  })

  it('compares steps by their words and their target, ignoring case and spacing', () => {
    expect(
      planStepsMatch(
        proposed,
        proposed.map((s) => ({ ...s, agentName: 'Renamed' })),
      ),
    ).toBe(true)
    expect(
      planStepsMatch(
        [{ title: 'Fix  the BUG', agentId: 'a2' }],
        [{ title: 'fix the bug', agentId: 'a2' }],
      ),
    ).toBe(true)
    expect(
      planStepsMatch([{ title: 'Fix', agentId: 'a2' }], [{ title: 'Fix', agentId: 'a3' }]),
    ).toBe(false)
    expect(planStepsMatch(proposed, proposed.slice(0, 1))).toBe(false)
  })

  it('renders the steps as a numbered list a person can read', () => {
    const body = renderPlanBody(proposed)
    expect(body).toBe(
      '1. Run the tests (Bug Boo)\n   Run the tests and say what fails\n2. Fix what fails (Design Boo)',
    )
  })
})

describe('what an accepted plan creates', () => {
  it('keeps the steps as proposed when the person changed nothing', () => {
    expect(acceptedPlanSteps(proposed, proposed, 'lead')).toEqual([
      { title: 'Run the tests', description: 'Run the tests and say what fails', agentId: 'a2' },
      { title: 'Fix what fails', agentId: 'a3' },
    ])
  })

  it('gives a step with no target to the agent that proposed it', () => {
    expect(acceptedPlanSteps([{ title: 'One' }], [{ title: 'One' }], 'lead')).toEqual([
      { title: 'One', agentId: 'lead' },
    ])
  })

  it('never takes a target the plan did not name', () => {
    const got = acceptedPlanSteps(proposed, [{ title: 'Sneak', agentId: 'stranger' }], 'lead')
    expect(got).toEqual([{ title: 'Sneak', agentId: 'lead' }])
  })

  it('runs the words the person left, and nothing they took out', () => {
    const long = `${'a'.repeat(200)} and then delete the database`
    const original = { title: long.slice(0, 200), description: long, agentId: 'a2' }
    const edited = 'Only the login tests'
    const [step] = acceptedPlanSteps([original], [{ title: edited, agentId: 'a2' }], 'lead')
    expect(step).toEqual({ title: edited, agentId: 'a2' })
    expect(JSON.stringify(step)).not.toContain('delete the database')
  })

  it('keeps all of a long step, with the title the start of it', () => {
    const long = `${'b'.repeat(250)} the end`
    const [step] = acceptedPlanSteps([], [{ title: long }], 'lead')
    expect(step?.title).toBe(long.slice(0, 200))
    expect(step?.description).toBe(long)
  })

  it('a long step the person did not touch runs whole', () => {
    const long = `${'c'.repeat(250)} the end`
    const step = { title: long.slice(0, 200), description: long, agentId: 'a2' }
    expect(acceptedPlanSteps([step], [step], 'lead')).toEqual([step])
  })
})

describe('a card that only holds a plan', () => {
  it('is told apart by its id, and still reads as a person’s assignment', () => {
    const sdid = encodePlanHolder('lead', 'n1')
    expect(isPlanHolder(sdid)).toBe(true)
    expect(isHumanAssignment(sdid)).toBe(true)
    expect(delegationTargetOf(sdid)).toBe('lead')
    expect(isPlanHolder(encodeHumanAssignment('lead', 'n1'))).toBe(false)
    expect(isPlanHolder(null)).toBe(false)
  })
})

describe('the words an answer leaves', () => {
  const answer = normalizeAnswer(
    'suggest_tasks',
    { prompt: 'Plan', tasks: proposed },
    { accepted: true, note: 'Go' },
  )!

  it('an accepted plan says its tasks exist, so no agent makes them again', () => {
    const words = answerWords(answer, { planCreated: true })
    expect(words).toMatch(/^Accepted the plan/)
    expect(words).toContain('- Run the tests')
    expect(words).toContain('Note: Go')
    expect(words).not.toMatch(/Create these tasks/)
    expect(answerForAgent('Plan', answer, { planCreated: true })).toMatch(/^Accepted the plan/)
  })

  it('a suggestion that is not a plan still asks the agent to make them', () => {
    expect(answerWords(answer)).toMatch(/^Accepted\.[\s\S]*Create these tasks/)
  })

  it('a person’s note comes first, so a long list cannot cut it off', () => {
    const long = normalizeAnswer(
      'suggest_tasks',
      {
        prompt: 'Plan',
        tasks: [
          { title: 'One', description: 'x'.repeat(4_000) },
          { title: 'Two', description: 'y'.repeat(4_000) },
        ],
      },
      { accepted: true, note: 'Do the risky one last' },
    )!
    for (const words of [answerWords(long), answerWords(long, { planCreated: true })])
      expect(words.indexOf('Do the risky one last')).toBeLessThan(100)
  })

  it('an accepted plan lists titles, because each task holds its own words', () => {
    const long = normalizeAnswer(
      'suggest_tasks',
      { prompt: 'Plan', tasks: [{ title: 'One', description: 'One and '.padEnd(4_000, 'z') }] },
      { accepted: true },
    )!
    expect(answerWords(long, { planCreated: true }).length).toBeLessThan(200)
  })

  it('a person cannot be read as creating tasks by turning a plan down', () => {
    const no = normalizeAnswer(
      'suggest_tasks',
      { prompt: 'Plan', tasks: proposed },
      { accepted: false, note: 'Too much at once' },
    )!
    expect(answerWords(no, { planCreated: true })).toBe(
      'Turned these tasks down.\nNote: Too much at once',
    )
  })
})
