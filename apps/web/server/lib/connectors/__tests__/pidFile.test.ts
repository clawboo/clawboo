// The durable pid record exists for the case the in-memory registry cannot
// cover: a hard stop that runs no shutdown hook.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  connectorPidFilePath,
  forgetConnectorPid,
  reapOrphanedConnectors,
  recordConnectorPid,
} from '../pidFile'

describe('connector pid file', () => {
  let home: string
  let prevHome: string | undefined
  let prevClawbooHome: string | undefined

  beforeEach(() => {
    home = mkdtempSync(path.join(os.tmpdir(), 'clawboo-pidfile-'))
    prevHome = process.env['HOME']
    prevClawbooHome = process.env['CLAWBOO_HOME']
    process.env['HOME'] = home
    process.env['CLAWBOO_HOME'] = home
  })
  afterEach(() => {
    if (prevHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = prevHome
    if (prevClawbooHome === undefined) delete process.env['CLAWBOO_HOME']
    else process.env['CLAWBOO_HOME'] = prevClawbooHome
    rmSync(home, { recursive: true, force: true })
  })

  it('records and forgets a pid', () => {
    recordConnectorPid({ pid: 111, slug: 'memory', startedAt: Date.now() })
    recordConnectorPid({ pid: 222, slug: 'context7', startedAt: Date.now() })
    expect(JSON.parse(readFileSync(connectorPidFilePath(), 'utf8'))).toHaveLength(2)

    forgetConnectorPid(111)
    const left = JSON.parse(readFileSync(connectorPidFilePath(), 'utf8')) as { pid: number }[]
    expect(left.map((e) => e.pid)).toEqual([222])
  })

  it('replaces rather than duplicates a record for the same pid', () => {
    // A recycled pid must not end up with two records disagreeing about which
    // connector it belongs to.
    recordConnectorPid({ pid: 111, slug: 'memory', startedAt: 1 })
    recordConnectorPid({ pid: 111, slug: 'context7', startedAt: 2 })
    const all = JSON.parse(readFileSync(connectorPidFilePath(), 'utf8')) as { slug: string }[]
    expect(all).toHaveLength(1)
    expect(all[0]!.slug).toBe('context7')
  })

  it('kills a LIVE recorded pid from THIS boot and clears the file', () => {
    const killed: number[] = []
    recordConnectorPid({ pid: process.pid, slug: 'memory', startedAt: Date.now() })
    const report = reapOrphanedConnectors((pid) => killed.push(pid))
    expect(killed).toEqual([process.pid])
    expect(report.killed).toBe(1)
    // Cleared, so a later boot does not try again against a pid the OS may
    // since have handed to something else.
    expect(JSON.parse(readFileSync(connectorPidFilePath(), 'utf8'))).toEqual([])
  })

  it('NEVER signals a pid recorded under a different boot', () => {
    // The hazard this whole file has to avoid. After a reboot the kernel hands
    // the same low numbers out again, so an entry from before it names whatever
    // process holds that number now -- and the killer is a whole-tree SIGKILL.
    // A liveness probe cannot tell the difference: a recycled pid is alive.
    const killed: number[] = []
    writeFileSync(
      connectorPidFilePath(),
      JSON.stringify([{ pid: process.pid, slug: 'memory', startedAt: Date.now(), bootAt: 1 }]),
      'utf8',
    )
    const report = reapOrphanedConnectors((pid) => killed.push(pid))
    expect(killed).toEqual([])
    expect(report.expired).toBe(1)
  })

  it('does NOT signal a pid whose process started AFTER the record', () => {
    // Within one boot a pid can still be recycled. A recycled pid necessarily
    // started after we recorded the original; ours started just before.
    const killed: number[] = []
    const longAgo = Date.now() - 24 * 60 * 60_000
    writeFileSync(
      connectorPidFilePath(),
      JSON.stringify([
        // Same boot and inside the age window, but claiming to predate this
        // process by an hour.
        {
          pid: process.pid,
          slug: 'memory',
          startedAt: Date.now() - 60 * 60_000,
          bootAt: Math.round((Date.now() - os.uptime() * 1000) / 10_000) * 10_000,
        },
      ]),
      'utf8',
    )
    void longAgo
    const report = reapOrphanedConnectors((pid) => killed.push(pid))
    expect(killed).toEqual([])
    expect(report.expired).toBe(1)
  })

  it('does NOT signal a pid that is already gone', () => {
    const killed: number[] = []
    // 2^22 is above every platform's default pid_max, so it cannot be live.
    recordConnectorPid({ pid: 4_194_304, slug: 'memory', startedAt: Date.now() })
    reapOrphanedConnectors((pid) => killed.push(pid))
    expect(killed).toEqual([])
  })

  it('EXPIRES an old record without signalling it', () => {
    // Killing a pid the kernel has since recycled is far worse than leaving one
    // connector running, and a bare number cannot tell the two apart.
    const killed: number[] = []
    recordConnectorPid({
      pid: process.pid,
      slug: 'memory',
      startedAt: Date.now() - 8 * 24 * 3600_000,
    })
    const report = reapOrphanedConnectors((pid) => killed.push(pid))
    expect(killed).toEqual([])
    expect(report.expired).toBe(1)
  })

  it('refuses to signal a live pid whose process started AFTER our record', () => {
    // The identity probe used to exist only for POSIX, so on Windows every
    // recorded pid was signalled with nothing corroborating that it was still
    // ours, and the signal is a whole-tree SIGKILL.
    //
    // What it must NOT do is treat "this host cannot answer" as "do not signal".
    // That is not caution, it is disabling orphan reaping on a whole platform
    // while still claiming to do it, which is what the kill test above pins.
    const killed: number[] = []
    writeFileSync(
      connectorPidFilePath(),
      JSON.stringify([
        {
          pid: process.pid,
          slug: 'memory',
          // Same boot, inside the age window, but claiming to predate this
          // process. Whatever the host reports, the answer must not be "kill".
          startedAt: Date.now() - 6 * 60 * 60_000,
          bootAt: Math.round((Date.now() - os.uptime() * 1000) / 10_000) * 10_000,
        },
      ]),
      'utf8',
    )
    const report = reapOrphanedConnectors((pid) => killed.push(pid))
    expect(killed).toEqual([])
    expect(report.expired).toBe(1)
  })

  it('one dead record does not cost a live one its corroboration', () => {
    // `ps -p` exits non-zero and prints NOTHING when ANY id in the list is
    // invalid, so batching the probe made a single stale entry downgrade every
    // other entry to boot-and-liveness. The probe list is filtered to live pids
    // for exactly this reason.
    const killed: number[] = []
    const bootAt = Math.round((Date.now() - os.uptime() * 1000) / 10_000) * 10_000
    writeFileSync(
      connectorPidFilePath(),
      JSON.stringify([
        // Above every platform's pid_max, so it cannot be live.
        { pid: 4_194_304, slug: 'context7', startedAt: Date.now(), bootAt },
        { pid: process.pid, slug: 'memory', startedAt: Date.now(), bootAt },
      ]),
      'utf8',
    )
    const report = reapOrphanedConnectors((pid) => killed.push(pid))
    expect(killed).toEqual([process.pid])
    // Corroborated, not waved through: the live entry still had its start time
    // checked, so nothing was signalled on weaker evidence.
    expect(report.unverified).toBe(0)
  })

  it('treats a corrupt file as empty rather than throwing', () => {
    // A read-only state directory or a truncated write must degrade to "we
    // cannot reap old children", never to "the server will not start".
    writeFileSync(connectorPidFilePath(), '{not json', 'utf8')
    expect(() => reapOrphanedConnectors(() => {})).not.toThrow()
  })
})
