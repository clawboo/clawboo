import { describe, expect, it } from 'vitest'

import { LOCAL_PERSON, isLocalPerson } from '../person'
import { personMoveAllowed } from '../state-machine'
import { parseWaitingOn, waitingOnJson, waitsOnOtherWork } from '../waitingOn'

describe('waiting_on: what a waiting task waits for', () => {
  it('round-trips every kind through its column value', () => {
    for (const w of [
      { kind: 'person', need: 'Pick the logo colour' },
      { kind: 'question', questionId: 'q1' },
      { kind: 'approval' },
      { kind: 'task', taskId: 't2' },
      { kind: 'subtasks' },
      { kind: 'failure' },
      { kind: 'verification', state: 'could_not_run' },
      { kind: 'budget' },
      { kind: 'breaker' },
      { kind: 'recovery' },
    ] as const) {
      expect(parseWaitingOn(waitingOnJson(w))).toEqual(w)
    }
  })

  it('keeps who a person reason is for', () => {
    const w = { kind: 'person', need: 'Check the deploy', personId: 'p1', by: 'agent' } as const
    expect(parseWaitingOn(waitingOnJson(w))).toEqual(w)
  })

  it('reads nothing it cannot trust', () => {
    expect(parseWaitingOn(null)).toBeNull()
    expect(parseWaitingOn('')).toBeNull()
    expect(parseWaitingOn('not json')).toBeNull()
    expect(parseWaitingOn('{"kind":"nonsense"}')).toBeNull()
    // A kind that names something must name it.
    expect(parseWaitingOn('{"kind":"task"}')).toBeNull()
    expect(parseWaitingOn('{"kind":"question"}')).toBeNull()
    expect(parseWaitingOn('{"kind":"person"}')).toBeNull()
    expect(parseWaitingOn('{"kind":"verification","state":"odd"}')).toBeNull()
    expect(waitingOnJson(null)).toBeNull()
  })

  it('accepts an already-parsed value', () => {
    expect(parseWaitingOn({ kind: 'subtasks' })).toEqual({ kind: 'subtasks' })
  })

  it('tells a wait on other work from a wait on a person', () => {
    expect(waitsOnOtherWork({ kind: 'task', taskId: 'x' })).toBe(true)
    expect(waitsOnOtherWork({ kind: 'subtasks' })).toBe(true)
    expect(waitsOnOtherWork({ kind: 'person', need: 'x' })).toBe(false)
    expect(waitsOnOtherWork({ kind: 'question', questionId: 'q' })).toBe(false)
    expect(waitsOnOtherWork(null)).toBe(false)
  })
})

describe('the built-in local person', () => {
  it('has a fixed id and reads as "You"', () => {
    expect(LOCAL_PERSON).toEqual({ id: 'local', name: 'You', role: null })
    expect(isLocalPerson('local')).toBe(true)
    expect(isLocalPerson('someone')).toBe(false)
    expect(isLocalPerson(null)).toBe(false)
  })
})

describe('person-only moves, kept out of the shared table', () => {
  it('lets a person reopen a finished task to To do, and nothing else', () => {
    expect(personMoveAllowed('done', 'todo', { reopen: true })).toBe(true)
    expect(personMoveAllowed('cancelled', 'todo', { reopen: true })).toBe(true)
    expect(personMoveAllowed('done', 'in_progress', { reopen: true })).toBe(false)
    expect(personMoveAllowed('done', 'todo', {})).toBe(false)
    expect(personMoveAllowed('todo', 'todo', { reopen: true })).toBe(false)
  })

  it('lets a person finish a task assigned to a person from any open status', () => {
    for (const from of ['backlog', 'todo', 'in_progress', 'blocked'] as const) {
      expect(personMoveAllowed(from, 'done', { personAssigned: true }), from).toBe(true)
      expect(personMoveAllowed(from, 'done', {}), from).toBe(false)
    }
    expect(personMoveAllowed('done', 'done', { personAssigned: true })).toBe(false)
    expect(personMoveAllowed('todo', 'cancelled', { personAssigned: true })).toBe(false)
  })
})
