// The runs this process is driving for board tasks, by task, so a person's
// comment on a task can reach the run working on it RIGHT NOW. Every path that
// runs a task registers here: the team engine's deliveries (`serverDeliver`), the
// executor runner (a routine fire on a native or coding agent, a direct runtime
// run) and the OpenClaw routine dispatcher. The sibling of `runStops`, which does
// the same for a person moving the card.
//
// Each entry wraps the run's adapter and handle. Whether the message goes in live
// or by stopping and resuming the run is the adapter's business (its
// `capabilities().steering`); an adapter that declares neither is never asked.

import {
  steeringOf,
  type RunHandle,
  type RuntimeAdapter,
  type SteerResult,
} from '@clawboo/executor'

/** The slice of an adapter a steer needs. A run whose adapter declares no
 *  steering (or has no `capabilities`) is never asked. */
export type SteerTarget = Partial<Pick<RuntimeAdapter, 'capabilities' | 'steer'>>

interface Entry {
  adapter: SteerTarget
  run: RunHandle
}

const byTask = new Map<string, Set<Entry>>()

export interface RunSteerHandle {
  /** The run is over: forget it. */
  release(): void
}

/** Register a run working on `taskId`. Release it when the run ends. */
export function registerRunSteer(
  taskId: string,
  adapter: SteerTarget,
  run: RunHandle,
): RunSteerHandle {
  const entry: Entry = { adapter, run }
  const set = byTask.get(taskId) ?? new Set<Entry>()
  set.add(entry)
  byTask.set(taskId, set)
  return {
    release() {
      set.delete(entry)
      if (set.size === 0 && byTask.get(taskId) === set) byTask.delete(taskId)
    },
  }
}

/** True when some run working on `taskId` is registered. */
export function hasRunForTask(taskId: string): boolean {
  return (byTask.get(taskId)?.size ?? 0) > 0
}

/**
 * Put `text` in front of the run working on `taskId`. The first run that takes
 * it wins (a task has one run at a time; the set only covers the hand-over
 * between a run and its rotated successor). Never throws.
 */
export async function steerTaskRun(taskId: string, text: string): Promise<SteerResult> {
  const set = byTask.get(taskId)
  if (!set || set.size === 0) return { delivered: false, reason: 'no-run' }
  let last: SteerResult = { delivered: false, reason: 'unsupported' }
  for (const { adapter, run } of [...set]) {
    if (!adapter.capabilities || !adapter.steer) continue
    if (steeringOf(adapter.capabilities()) === 'none') continue
    try {
      const result = await adapter.steer(run, text)
      if (result.delivered) return result
      last = result
    } catch (err) {
      last = {
        delivered: false,
        reason: 'rejected',
        detail: err instanceof Error ? err.message : String(err),
      }
    }
  }
  return last
}

/** Test helper: forget every registration. */
export function resetRunSteers(): void {
  byTask.clear()
}
