// The durable pid record exists for the case the in-memory registry cannot
// cover: a hard stop that runs no shutdown hook.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { currentBootIdentity, type BootIdentity } from '../../processIdentity'
import {
  connectorPidFilePath,
  forgetConnectorPid,
  reapOrphanedConnectors,
  recordConnectorPid,
} from '../pidFile'

/** A Linux host's identity, whatever this test runs on. */
const linuxHost = (): BootIdentity => ({
  bootAt: currentBootIdentity().bootAt,
  pidNamespace: 'pid:[4026531836]',
  initStart: 4_000,
})

function writeEntries(entries: unknown[]): void {
  writeFileSync(connectorPidFilePath(), JSON.stringify(entries), 'utf8')
}

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
    writeFileSync(
      connectorPidFilePath(),
      JSON.stringify([
        // Same boot and inside the age window, but claiming to predate this
        // process by an hour.
        {
          pid: process.pid,
          slug: 'memory',
          startedAt: Date.now() - 60 * 60_000,
          ...currentBootIdentity(),
        },
      ]),
      'utf8',
    )
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
          ...currentBootIdentity(),
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
    // invalid, so batching the probe made a single stale entry cost every other
    // entry its start time, and with it the signal. The probe list is filtered
    // to live pids for exactly this reason.
    const killed: number[] = []
    const boot = currentBootIdentity()
    writeFileSync(
      connectorPidFilePath(),
      JSON.stringify([
        // Above every platform's pid_max, so it cannot be live.
        { pid: 4_194_304, slug: 'context7', startedAt: Date.now(), ...boot },
        { pid: process.pid, slug: 'memory', startedAt: Date.now(), ...boot },
      ]),
      'utf8',
    )
    const report = reapOrphanedConnectors((pid) => killed.push(pid))
    expect(killed).toEqual([process.pid])
    expect(report.unverified).toBe(0)
  })

  it('records the PID namespace and when its pid 1 started with each pid', () => {
    // Inside a container the kernel's boot is the HOST's, so a restarted
    // container keeps it. The namespace and its pid 1 are what change.
    recordConnectorPid({ pid: 111, slug: 'memory', startedAt: Date.now() })
    const [entry] = JSON.parse(readFileSync(connectorPidFilePath(), 'utf8')) as object[]
    const boot = currentBootIdentity()
    expect(entry).toHaveProperty('bootAt', boot.bootAt)
    expect(entry).toHaveProperty('pidNamespace', boot.pidNamespace)
    expect(entry).toHaveProperty('initStart', boot.initStart)
  })

  it('NEVER signals a pid recorded in another PID namespace', () => {
    // Two containers can share one state directory through a volume. The other
    // one's pid names a process in ITS namespace; the same number here belongs
    // to somebody else, even one that started before the record.
    const killed: number[] = []
    const here = linuxHost()
    writeEntries([
      {
        pid: process.pid,
        slug: 'memory',
        startedAt: Date.now(),
        ...here,
        pidNamespace: 'pid:[4026532999]',
      },
    ])
    const report = reapOrphanedConnectors((pid) => killed.push(pid), { boot: here })
    expect(killed).toEqual([])
    expect(report.expired).toBe(1)
  })

  it('NEVER signals a pid recorded before this PID namespace started again', () => {
    // A restarted container keeps the host's boot time, and the kernel can hand
    // it the namespace id its previous run had. Its pid 1 is new, though.
    const killed: number[] = []
    const here = linuxHost()
    writeEntries([
      { pid: process.pid, slug: 'memory', startedAt: Date.now(), ...here, initStart: 3_000 },
    ])
    const report = reapOrphanedConnectors((pid) => killed.push(pid), { boot: here })
    expect(killed).toEqual([])
    expect(report.expired).toBe(1)
  })

  it('leaves a record from an older version alone where this host has a PID namespace', () => {
    // An entry written before the namespace was recorded cannot say which run
    // of the container wrote it, so on Linux it is dropped unsignalled.
    const killed: number[] = []
    const here = linuxHost()
    writeEntries([{ pid: process.pid, slug: 'memory', startedAt: Date.now(), bootAt: here.bootAt }])
    const report = reapOrphanedConnectors((pid) => killed.push(pid), { boot: here })
    expect(killed).toEqual([])
    expect(report.expired).toBe(1)
    expect(JSON.parse(readFileSync(connectorPidFilePath(), 'utf8'))).toEqual([])
  })

  it('still reaps a record from an older version on a host with no PID namespaces', () => {
    // macOS and Windows have none to record, so an older entry there carries
    // everything a new one would, and is judged as it always was.
    const killed: number[] = []
    const here: BootIdentity = { ...linuxHost(), pidNamespace: null, initStart: null }
    writeEntries([{ pid: process.pid, slug: 'memory', startedAt: Date.now(), bootAt: here.bootAt }])
    const report = reapOrphanedConnectors((pid) => killed.push(pid), { boot: here })
    expect(killed).toEqual([process.pid])
    expect(report.killed).toBe(1)
  })

  it('NEVER signals a pid whose start time could not be checked, and says why', () => {
    // Without a start time, boot, age and liveness cannot tell our connector
    // from a process that was handed its number later. On a host without `ps`
    // the reap used to signal it anyway.
    const killed: number[] = []
    recordConnectorPid({ pid: process.pid, slug: 'memory', startedAt: Date.now() })
    const empty = mkdtempSync(path.join(os.tmpdir(), 'clawboo-no-ps-'))
    const savedPath = process.env['PATH']
    process.env['PATH'] = empty
    try {
      const report = reapOrphanedConnectors((pid) => killed.push(pid))
      expect(killed).toEqual([])
      expect(report.killed).toBe(0)
      expect(report.unverified).toBe(1)
      expect(report.unverifiedReason).toMatch(/ENOENT/)
    } finally {
      process.env['PATH'] = savedPath
      rmSync(empty, { recursive: true, force: true })
    }
    // Cleared all the same: a later start must not try again against a pid the
    // OS may since have handed to something else.
    expect(JSON.parse(readFileSync(connectorPidFilePath(), 'utf8'))).toEqual([])
  })

  it('treats a corrupt file as empty rather than throwing', () => {
    // A read-only state directory or a truncated write must degrade to "we
    // cannot reap old children", never to "the server will not start".
    writeFileSync(connectorPidFilePath(), '{not json', 'utf8')
    expect(() => reapOrphanedConnectors(() => {})).not.toThrow()
  })
})
