import { describe, expect, it, vi } from 'vitest'

import { stopDashboard, type StopDeps } from '../lifecycle'

const PORT = 18790
const PID = 4242

/**
 * Every side effect is injected, so the SIGTERM → poll → SIGKILL escalation is
 * exercised without spawning anything. `sleep` is a no-op, which makes the two
 * poll loops instant.
 */
function deps(overrides: Partial<StopDeps> = {}): Required<StopDeps> {
  return {
    isClawboo: async () => true,
    findListenerPid: () => PID,
    kill: () => {},
    probe: async () => false,
    readPortFile: () => PORT,
    unlinkPortFile: () => {},
    sleep: async () => {},
    ...overrides,
  }
}

/** A port that answers for `aliveTicks` polls, then goes quiet. */
function probeAliveFor(aliveTicks: number): () => Promise<boolean> {
  let calls = 0
  return async () => calls++ < aliveTicks
}

function errno(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code })
}

describe('stopDashboard', () => {
  it('SIGTERMs the listener and reports it stopped', async () => {
    const kill = vi.fn()
    const unlinkPortFile = vi.fn()
    const outcome = await stopDashboard(PORT, deps({ kill, unlinkPortFile }))

    expect(outcome).toEqual({ status: 'stopped', port: PORT, pid: PID, forced: false })
    expect(kill).toHaveBeenCalledTimes(1)
    expect(kill).toHaveBeenCalledWith(PID, 'SIGTERM')
    expect(unlinkPortFile).toHaveBeenCalledTimes(1)
  })

  // The load-bearing guard: the 18790-18809 fallback window overlaps the
  // OpenClaw Gateway's aux ports and Chrome's --remote-debugging-port.
  it('never signals a port that is not Clawboo', async () => {
    const kill = vi.fn()
    const findListenerPid = vi.fn(() => PID)
    const outcome = await stopDashboard(
      PORT,
      deps({ isClawboo: async () => false, kill, findListenerPid }),
    )

    expect(outcome).toEqual({ status: 'not-running', port: PORT })
    expect(findListenerPid).not.toHaveBeenCalled()
    expect(kill).not.toHaveBeenCalled()
  })

  it('clears a stale port file when nothing Clawboo-shaped answers', async () => {
    const unlinkPortFile = vi.fn()
    await stopDashboard(PORT, deps({ isClawboo: async () => false, unlinkPortFile }))
    expect(unlinkPortFile).toHaveBeenCalledTimes(1)
  })

  it('reports could-not-identify when no listener is found', async () => {
    const kill = vi.fn()
    const outcome = await stopDashboard(PORT, deps({ findListenerPid: () => null, kill }))

    expect(outcome).toEqual({ status: 'could-not-identify', port: PORT, reason: 'no-listener' })
    expect(kill).not.toHaveBeenCalled()
  })

  it('surfaces EPERM rather than pretending it stopped', async () => {
    const outcome = await stopDashboard(
      PORT,
      deps({
        kill: () => {
          throw errno('EPERM')
        },
      }),
    )
    expect(outcome).toEqual({
      status: 'could-not-identify',
      port: PORT,
      reason: 'permission-denied',
    })
  })

  it('treats ESRCH plus a quiet port as stopped (it raced us to death)', async () => {
    const outcome = await stopDashboard(
      PORT,
      deps({
        kill: () => {
          throw errno('ESRCH')
        },
      }),
    )
    expect(outcome).toEqual({ status: 'stopped', port: PORT, pid: PID, forced: false })
  })

  it('escalates to SIGKILL when SIGTERM is ignored', async () => {
    const kill = vi.fn()
    // Alive through the whole 4s SIGTERM window, then dies after SIGKILL.
    const outcome = await stopDashboard(PORT, deps({ kill, probe: probeAliveFor(40) }))

    expect(outcome).toEqual({ status: 'stopped', port: PORT, pid: PID, forced: true })
    expect(kill.mock.calls).toEqual([
      [PID, 'SIGTERM'],
      [PID, 'SIGKILL'],
    ])
  })

  // The recycled-PID guard. If the port is now owned by someone else, the PID we
  // signaled is not ours to force-kill.
  it('does not SIGKILL when the listener PID changed under us', async () => {
    const kill = vi.fn()
    const findListenerPid = vi.fn<() => number | null>()
    findListenerPid.mockReturnValueOnce(PID).mockReturnValueOnce(9999)

    const outcome = await stopDashboard(
      PORT,
      deps({ kill, findListenerPid, probe: probeAliveFor(40) }),
    )

    expect(outcome).toEqual({ status: 'still-alive', port: PORT, pid: PID })
    expect(kill.mock.calls).toEqual([[PID, 'SIGTERM']])
  })

  it('reports still-alive when even SIGKILL does not free the port', async () => {
    const unlinkPortFile = vi.fn()
    const outcome = await stopDashboard(PORT, deps({ probe: async () => true, unlinkPortFile }))

    expect(outcome).toEqual({ status: 'still-alive', port: PORT, pid: PID })
    expect(unlinkPortFile).not.toHaveBeenCalled()
  })

  it('leaves a port file that names a different port alone', async () => {
    const unlinkPortFile = vi.fn()
    const outcome = await stopDashboard(PORT, deps({ readPortFile: () => 18795, unlinkPortFile }))

    expect(outcome.status).toBe('stopped')
    expect(unlinkPortFile).not.toHaveBeenCalled()
  })

  it.each([
    ['init', 1],
    ['ourselves', process.pid],
    ['our parent', process.ppid],
    ['a mis-parsed zero', 0],
    ['a negative PID', -5],
  ])('refuses to signal %s', async (_label, pid) => {
    const kill = vi.fn()
    const outcome = await stopDashboard(PORT, deps({ findListenerPid: () => pid, kill }))

    expect(outcome).toEqual({ status: 'could-not-identify', port: PORT, reason: 'no-listener' })
    expect(kill).not.toHaveBeenCalled()
  })
})
