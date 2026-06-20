// Process-tree teardown for the spawned runtimes. The driver spawns its CLI as a
// process-GROUP leader (detached), so an abort kills the whole tree — codex/hermes
// grandchildren don't get orphaned. We also assert the close handler captures the
// kill SIGNAL (so a deliberate abort surfaces as a clean `aborted` terminal, not a
// spurious error). POSIX-only — Windows tree-kill (taskkill /T) is a separate path.

import { describe, expect, it } from 'vitest'

import { killProcessTree } from '../killTree'
import { createSpawnDriver } from '../subprocess'

const isWin = process.platform === 'win32'

// A parent that spawns a grandchild sleeper (NOT detached, so it joins the
// parent's process group) and prints the grandchild pid. The literal is built so
// the test's own source carries no spawn call.
const PARENT_SCRIPT = [
  'const cp = require("child_" + "process")',
  'const c = cp.spawn(process.execPath, ["-e", "setInterval(()=>{}, 1e9)"], { stdio: "ignore" })',
  'process.stdout.write("GPID " + c.pid + "\\n")',
  'setInterval(() => {}, 1e9)',
].join('\n')

type Ev = { type: 'gpid'; pid: number } | { type: 'done'; aborted: boolean }

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function gpidOf(line: string): number | null {
  const m = line.trim().match(/^GPID (\d+)/)
  return m ? Number(m[1]) : null
}

describe.skipIf(isWin)('killProcessTree (spawned runtime abort)', () => {
  it('abort() kills the whole process tree — a grandchild is reaped, not orphaned', async () => {
    const events: Ev[] = []
    const driver = createSpawnDriver<Ev>({
      resolve: async () => ({ command: process.execPath, args: ['-e', PARENT_SCRIPT] }),
      parseLine: (line) => {
        const pid = gpidOf(line)
        return pid != null ? [{ type: 'gpid', pid }] : []
      },
      onClose: (_code, signal) => [
        { type: 'done', aborted: signal === 'SIGTERM' || signal === 'SIGKILL' },
      ],
    })
    driver.onEvent((e) => events.push(e))
    await driver.start()

    const deadline = Date.now() + 5000
    while (Date.now() < deadline && !events.some((e) => e.type === 'gpid')) {
      await new Promise((r) => setTimeout(r, 25))
    }
    const gpidEv = events.find((e): e is { type: 'gpid'; pid: number } => e.type === 'gpid')
    expect(gpidEv).toBeDefined()
    const gpid = gpidEv!.pid
    expect(pidAlive(gpid)).toBe(true)

    await driver.abort()

    const killDeadline = Date.now() + 5000
    while (Date.now() < killDeadline && pidAlive(gpid)) {
      await new Promise((r) => setTimeout(r, 25))
    }
    expect(pidAlive(gpid)).toBe(false) // grandchild reaped, not orphaned
  })

  it('the close handler captures the kill signal → surfaces a `done:aborted`', async () => {
    const events: Ev[] = []
    const driver = createSpawnDriver<Ev>({
      resolve: async () => ({
        command: process.execPath,
        args: ['-e', 'setInterval(()=>{}, 1e9)'],
      }),
      parseLine: () => [],
      // The fix: `signal` is the 2nd onClose arg (was dropped before) → a SIGTERM
      // abort is mapped to `aborted`, not a spurious error.
      onClose: (_code, signal) => [
        { type: 'done', aborted: signal === 'SIGTERM' || signal === 'SIGKILL' },
      ],
    })
    driver.onEvent((e) => events.push(e))
    await driver.start()
    await new Promise((r) => setTimeout(r, 100))
    await driver.abort()

    const deadline = Date.now() + 5000
    while (Date.now() < deadline && !events.some((e) => e.type === 'done')) {
      await new Promise((r) => setTimeout(r, 25))
    }
    const done = events.find((e): e is { type: 'done'; aborted: boolean } => e.type === 'done')
    expect(done?.aborted).toBe(true)
  })

  it('escalates to SIGKILL through the liveness guard when the group ignores SIGTERM', async () => {
    // The escalation re-verifies the group is alive (`kill(-pid, 0)`) before the
    // SIGKILL, so a recycled-pid over-kill is skipped — but a group that is still
    // alive (ignores SIGTERM) MUST still be force-killed. A swallowed-SIGTERM
    // child proves the guard preserves the escalation rather than blocking it.
    const IGNORE_SIGTERM = ['process.on("SIGTERM", () => {})', 'setInterval(() => {}, 1e9)'].join(
      '\n',
    )
    const { spawn } = await import('node:child_process')
    const child = spawn(process.execPath, ['-e', IGNORE_SIGTERM], {
      detached: true,
      stdio: 'ignore',
    })
    const pid = child.pid!
    expect(pidAlive(pid)).toBe(true)

    killProcessTree(child, { graceMs: 150 })

    const deadline = Date.now() + 5000
    while (Date.now() < deadline && pidAlive(pid)) {
      await new Promise((r) => setTimeout(r, 25))
    }
    expect(pidAlive(pid)).toBe(false) // SIGTERM swallowed → SIGKILL escalation reaped it
  })

  it('reaps a SIGTERM-trapping grandchild when the group LEADER dies on SIGTERM (escalation survives the leader exit)', async () => {
    // The exact case the prior 'exit' early-clear broke (the deterministicGate verify
    // subtree): a shell LEADER that dies on the group SIGTERM (no trap) whose grandchild
    // (the real test runner) TRAPS SIGTERM and INHERITS the leader's stdio pipe. When
    // killProcessTree SIGTERMs the group, the leader's death fires 'exit' DURING the
    // grace window — but the GROUP is not empty (the grandchild lives + holds the pipe).
    // Only the SIGKILL escalation, kept armed by clearing on 'close' (not 'exit'), reaps
    // the grandchild. Pre-fix, the leader's 'exit' cancelled the timer → orphan.
    const { spawn } = await import('node:child_process')
    // Leader: spawn a SIGTERM-TRAPPING grandchild that inherits the leader's stdio (so
    // 'close' only fires once the grandchild dies), then loop (NO trap → dies on the
    // group SIGTERM while killProcessTree is mid-grace). The grandchild announces its
    // OWN pid AFTER installing the trap, so the test never SIGTERMs it before it's armed.
    // Built so the test's own source carries no spawn call.
    const LEADER_SCRIPT = [
      'const cp = require("child_" + "process")',
      'const gc = \'process.on("SIGTERM", () => {}); process.stdout.write("GPID " + process.pid + "\\\\n"); setInterval(() => {}, 1e9)\'',
      'cp.spawn(process.execPath, ["-e", gc], { stdio: "inherit" })',
      'setInterval(() => {}, 1e9)',
    ].join('\n')
    const child = spawn(process.execPath, ['-e', LEADER_SCRIPT], {
      detached: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    })

    let buf = ''
    child.stdout!.on('data', (d: Buffer) => {
      buf += d.toString()
    })
    // Wait until the grandchild has installed its SIGTERM trap AND announced its pid;
    // the leader is still alive here (it loops), which is what makes its 'exit' fire
    // DURING the grace window — the precondition the bug needs.
    const readDeadline = Date.now() + 5000
    while (Date.now() < readDeadline && gpidOf(buf) == null) {
      await new Promise((r) => setTimeout(r, 25))
    }
    const gpid = gpidOf(buf)
    expect(gpid).not.toBeNull()
    expect(pidAlive(gpid!)).toBe(true)

    killProcessTree(child, { graceMs: 200 })

    const killDeadline = Date.now() + 5000
    while (Date.now() < killDeadline && pidAlive(gpid!)) {
      await new Promise((r) => setTimeout(r, 25))
    }
    expect(pidAlive(gpid!)).toBe(false) // leader died on SIGTERM, grandchild trapped it → SIGKILL still reaped it
  })
})
