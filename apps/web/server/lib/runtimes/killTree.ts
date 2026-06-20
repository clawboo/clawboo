// Kill a spawned child AND its descendants. `child.kill()` signals only the
// direct PID, so a codex/hermes grandchild (or a shelled verify command's
// test-runner subtree) is orphaned. On POSIX the child is spawned as a
// process-GROUP leader (`detached: true` → setsid), so `process.kill(-pid, …)`
// signals the whole group; we SIGTERM then escalate to SIGKILL after a grace
// window. On Windows there are no POSIX process groups — `taskkill /T /F` walks
// and force-kills the tree. Best-effort throughout: a dead/exited pid is a no-op.
//
// SAFETY: the negative-pid signal targets the group whose id == the child pid,
// which (for a detached spawn) is exactly that child's own group — never the
// server's. If the child was NOT spawned detached, `-pid` resolves to a
// non-existent group (ESRCH) and we fall back to a direct `child.kill`, so this
// can never signal the parent's process group.

import { spawn, type ChildProcess } from 'node:child_process'

import { isWindows } from '../platform'

const DEFAULT_GRACE_MS = 3_000

export function killProcessTree(child: ChildProcess | null, opts: { graceMs?: number } = {}): void {
  const pid = child?.pid
  if (!pid) return

  if (isWindows) {
    try {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    } catch {
      /* best-effort — already gone */
    }
    return
  }

  try {
    process.kill(-pid, 'SIGTERM')
  } catch {
    // ESRCH (group gone) — fall back to the direct child (non-detached safety),
    // which also covers an already-exited process. Never targets another group.
    try {
      child?.kill('SIGTERM')
    } catch {
      /* gone */
    }
    return
  }

  // Escalate to SIGKILL if the group hasn't exited within the grace window.
  const timer = setTimeout(() => {
    try {
      // Re-verify the group is still alive before escalating. During the grace
      // window Node's 'close' can lag the process exit+reap, and the freed leader
      // pid could be recycled by an unrelated process group — `kill(-pid, 0)` is a
      // liveness probe that throws ESRCH if the original group is already gone, so
      // we skip the SIGKILL rather than risk over-killing a recycled pid.
      process.kill(-pid, 0)
      process.kill(-pid, 'SIGKILL')
    } catch {
      /* group already exited (ESRCH) — nothing to escalate */
    }
  }, opts.graceMs ?? DEFAULT_GRACE_MS)
  timer.unref()
  // Clear ONLY on 'close' (all stdio drained), NOT on 'exit'. Node fires 'exit'
  // when the group LEADER's own process exits — but a surviving grandchild can
  // still hold the leader's stdio pipes open, so the GROUP is not yet empty.
  // Clearing on 'exit' (the prior behavior) cancelled the SIGKILL escalation while
  // a SIGTERM-trapping grandchild lived on, orphaning it. 'close' fires only once
  // the whole subtree's pipes drain, so the timer survives until the group is
  // genuinely done; the kill(-pid, 0) liveness probe makes a late timer-fire on an
  // already-empty group a harmless no-op.
  const clear = (): void => clearTimeout(timer)
  child?.once('close', clear)
}
