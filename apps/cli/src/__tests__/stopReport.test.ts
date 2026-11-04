// What `clawboo stop` and `clawboo restart` say when the wait for agent runs
// ends without a stop, and the note they add when a hold they placed may still
// be on the server. A hold the command could not release keeps the server from
// starting new work until it lapses, so every path that leaves one says so.

import { describe, expect, it } from 'vitest'

import type { StopAfterRunsResult } from '../lifecycle'
import { HOLD_LAPSES, holdNote, reportUnstopped } from '../stopReport'

const stopped: StopAfterRunsResult['stop'] = {
  status: 'stopped',
  port: 18790,
  pid: 4242,
  forced: false,
}

describe('reportUnstopped', () => {
  it('says nothing when the stop ran', () => {
    expect(
      reportUnstopped({ drain: { status: 'idle' }, stop: stopped, released: null }, 'stop'),
    ).toBeNull()
  })

  it('a server that would not be held: not stopped, exit 1, and the hold that may linger', () => {
    const report = reportUnstopped(
      { drain: { status: 'unreachable' }, stop: null, released: false },
      'stop',
    )
    expect(report).toEqual({
      tone: 'fail',
      text: 'The server did not answer the request to hold its agent runs, so it was not stopped.',
      notes: ['To stop it anyway: clawboo stop --force', HOLD_LAPSES],
      exitCode: 1,
    })
  })

  it('leaves the lapse note out when the hold was released', () => {
    const report = reportUnstopped(
      { drain: { status: 'unreachable' }, stop: null, released: true },
      'restart',
    )
    expect(report?.notes).toEqual(['To stop it anyway: clawboo restart --force'])
  })

  it('a server that stopped answering with runs going: not stopped, exit 1', () => {
    const report = reportUnstopped(
      { drain: { status: 'lost', running: 2 }, stop: null, released: false },
      'stop',
    )
    expect(report).toEqual({
      tone: 'fail',
      text: 'The server stopped answering while 2 agent runs were going, so it was not stopped.',
      notes: ['To stop it anyway: clawboo stop --force', HOLD_LAPSES],
      exitCode: 1,
    })
    expect(
      reportUnstopped({ drain: { status: 'lost', running: 1 }, stop: null, released: true }, 'stop')
        ?.text,
    ).toBe('The server stopped answering while 1 agent run was going, so it was not stopped.')
  })

  it('a cancelled wait: exit 130, saying when work starts again', () => {
    expect(
      reportUnstopped(
        { drain: { status: 'cancelled', running: 1 }, stop: null, released: true },
        'stop',
      ),
    ).toEqual({
      tone: 'info',
      text: 'Cancelled. Clawboo keeps running and starts new work again.',
      notes: [],
      exitCode: 130,
    })
    expect(
      reportUnstopped(
        { drain: { status: 'cancelled', running: 1 }, stop: null, released: false },
        'stop',
      )?.text,
    ).toBe(`Cancelled. Clawboo keeps running. ${HOLD_LAPSES}`)
  })
})

describe('holdNote', () => {
  it('names the lapse after a stop that failed with the hold still placed', () => {
    expect(holdNote({ status: 'still-alive', port: 18790, pid: 4242 }, false)).toBe(HOLD_LAPSES)
  })

  it('names it for a server the stop could not find, in case it is still up', () => {
    expect(holdNote({ status: 'not-running', port: 18790 }, false)).toBe(
      'If it is still running, it starts new work again within a minute, when its hold lapses.',
    )
  })

  it('says nothing when the hold was released or there was none', () => {
    expect(holdNote({ status: 'not-running', port: 18790 }, true)).toBeNull()
    expect(holdNote({ status: 'not-running', port: 18790 }, null)).toBeNull()
  })
})
