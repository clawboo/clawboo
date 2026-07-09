// The native runtime's team-delegation SIGNAL tool — the shared/coordination
// plane's counterpart to the private-plane file tools. Unlike `sessions_send`
// (OpenClaw's Gateway tool), a native agent has no built-in way to hand work to
// a teammate; this tool IS that way, and it is deliberately signal-ONLY: it does
// NOT touch the board. The server team orchestrator observes the emitted
// `tool-call` event (serverDeliver drains every event into the engine's
// `onEvent`) and its `extractSignals` turns it into a durable board task —
// create → claim → deliver → report-up → `[Task Update]`. The engine OWNS every
// board write; this tool only triggers it (the trust-first contract, mirroring
// how the engine already observes a `sessions_send` tool-call). It is wired into
// the native tool universe ONLY for team runs (gated by `isTeamSessionKey` in
// nativeDriver), so it never appears — and never silently no-ops — in a 1:1 run.

import type { NativeLocalTool, NativeToolOutcome } from './fileTools'

const err = (message: string): NativeToolOutcome => ({ output: message, isError: true })

/**
 * The `delegate` signal tool. The model calls it to hand a self-contained task
 * to a teammate BY NAME; the engine resolves the name against the live roster,
 * spawns the board task, and delivers it. The `run` handler only acknowledges —
 * the real work is done by the orchestrator observing the tool-call.
 */
export function buildDelegateTool(): NativeLocalTool {
  return {
    name: 'delegate',
    description:
      'Hand a self-contained piece of work to a teammate by name. They pick it up, do the work, ' +
      'and report back to you when done — you do NOT do it yourself. Use one call per task; call it ' +
      'again for each additional teammate or task.',
    inputSchema: {
      type: 'object',
      properties: {
        assignee: {
          type: 'string',
          description: "The teammate's name to hand the task to (e.g. \"Coder\").",
        },
        task: {
          type: 'string',
          description: 'A clear, self-contained description of the work for the teammate to do.',
        },
      },
      required: ['assignee', 'task'],
    },
    async run(args): Promise<NativeToolOutcome> {
      const assignee = typeof args['assignee'] === 'string' ? args['assignee'].trim() : ''
      const task = typeof args['task'] === 'string' ? args['task'].trim() : ''
      if (!assignee || !task) return err('delegate requires both an assignee (teammate name) and a task')
      // Signal-only: acknowledge and return. The orchestrator observes this
      // tool-call and creates + delivers the board task.
      return {
        output: `Delegated to ${assignee}: ${task}. They'll pick it up and report back when done.`,
        isError: false,
      }
    },
  }
}
