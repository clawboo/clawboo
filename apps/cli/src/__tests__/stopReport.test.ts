// What `clawboo stop` and `clawboo restart` say when the wait for agent runs
// ends without a stop, and the note they add when a hold they placed may still
// be on the server. A hold the command could not release keeps the server from
// starting new work until it lapses, so every path that leaves one says so.

import { describe, expect, it } from 'vitest'

import type { StopAfterRunsResult } from '../lifecycle'
import { HOLD_LAPSES, holdNote, reportNoServer, reportUnstopped } from '../stopReport'

const stopped: StopAfterRunsResult['stop'] = {
  status: 'stopped',
  port: 18790,
  pid: 4242,
  forced: false,
}

describe('reportUnstopped', () => {
  it('says nothing when the stop ran', () => {
    expect(reportUnstopped({ drain: { status: 'idle' }, stop: stopped, released: null })).toBeNull()
  })

  it('a server that would not be held: not stopped, exit 1, and the hold that may linger', () => {
    const report = reportUnstopped({
      drain: { status: 'unreachable' },
      stop: null,
      released: false,
    })
    // Not `--force`: it finds the server through the same requests that went
    // unanswered, so it would see none. The process can be stopped by hand.
    expect(report).toEqual({
      tone: 'fail',
      text: 'The server did not answer the request to hold its agent runs, so it was not stopped.',
      notes: [HOLD_LAPSES],
      manualStop: true,
      exitCode: 1,
    })
  })

  it('leaves the lapse note out when the hold was released', () => {
    const report = reportUnstopped({ drain: { status: 'unreachable' }, stop: null, released: true })
    expect(report?.notes).toEqual([])
    expect(report?.manualStop).toBe(true)
  })

  it('a server that stopped answering with runs going: not stopped, exit 1', () => {
    const report = reportUnstopped({
      drain: { status: 'lost', running: 2 },
      stop: null,
      released: false,
    })
    expect(report).toEqual({
      tone: 'fail',
      text: 'The server stopped answering while 2 agent runs were going, so it was not stopped.',
      notes: [HOLD_LAPSES],
      manualStop: true,
      exitCode: 1,
    })
    expect(
      reportUnstopped({ drain: { status: 'lost', running: 1 }, stop: null, released: true })?.text,
    ).toBe('The server stopped answering while 1 agent run was going, so it was not stopped.')
  })

  it('a cancelled wait: exit 130, saying when work starts again', () => {
    expect(
      reportUnstopped({ drain: { status: 'cancelled', running: 1 }, stop: null, released: true }),
    ).toEqual({
      tone: 'info',
      text: 'Cancelled. Clawboo keeps running and starts new work again.',
      notes: [],
      manualStop: false,
      exitCode: 130,
    })
    expect(
      reportUnstopped({ drain: { status: 'cancelled', running: 1 }, stop: null, released: false })
        ?.text,
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

describe('reportNoServer', () => {
  const SILENT = { port: 18790, state: 'silent' as const }
  const LIVE = { port: 18791, state: 'live' as const }

  it('stop: a stale record is cleared, and there is nothing to stop', () => {
    expect(reportNoServer({ port: 18790, state: 'none' }, 'stop')).toEqual({
      tone: 'info',
      text: 'No Clawboo server is running.',
      clearRecord: true,
      manualStopPort: null,
      start: false,
      exitCode: 0,
    })
    expect(reportNoServer({ port: null, state: 'none' }, 'stop').clearRecord).toBe(false)
  })

  it('stop: a silent server keeps its record, is not called stopped, and gets the manual command', () => {
    expect(reportNoServer(SILENT, 'stop')).toEqual({
      tone: 'fail',
      text:
        'A server on port 18790, the port Clawboo recorded, takes connections but does not ' +
        'answer. It may be busy, so it was not stopped.',
      clearRecord: false,
      manualStopPort: 18790,
      start: false,
      exitCode: 1,
    })
  })

  it('stop: a live server on the recorded port keeps its record and is named', () => {
    const report = reportNoServer(LIVE, 'stop')
    expect(report.clearRecord).toBe(false)
    expect(report.text).toBe(
      'No Clawboo server answered on the port asked. One answers on port 18791, the port ' +
        'Clawboo recorded: CLAWBOO_API_PORT=18791 clawboo stop stops it.',
    )
  })

  it('restart: starts a server only when nothing holds the recorded port', () => {
    expect(reportNoServer({ port: null, state: 'none' }, 'restart')).toMatchObject({
      start: true,
      exitCode: 0,
      text: 'No Clawboo server is running; starting one.',
    })
    expect(reportNoServer(SILENT, 'restart')).toMatchObject({
      tone: 'fail',
      start: false,
      clearRecord: false,
      manualStopPort: 18790,
      exitCode: 1,
    })
    expect(reportNoServer(LIVE, 'restart')).toMatchObject({
      tone: 'fail',
      start: false,
      clearRecord: false,
      exitCode: 1,
    })
  })
})
