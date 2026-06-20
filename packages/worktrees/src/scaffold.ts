// The per-task system-of-record scaffold: the durable, on-disk world any
// runtime reads to start cold. The repository (here, the task's worktree) — not
// chat, not the board UI — is the agent's knowable universe; if a fact isn't in
// these files, it does not exist for the next runtime. Written into the worktree
// root on provision and committed as the baseline.

import { chmod, writeFile } from 'node:fs/promises'
import path from 'node:path'

import type { TaskScaffoldInput } from './types'

/** Canonical system-of-record filenames at the worktree root. */
export const SOR_FILES = {
  task: 'TASK.md',
  progress: 'task-progress.md',
  decisions: 'DECISIONS.json',
  init: 'init.sh',
  verification: 'VERIFICATION.md',
  /** Written at clock-out by `writeHandoff`, not by the initial scaffold. */
  handoff: 'AGENT_HANDOFF.json',
} as const

/** Default startup commands when the caller supplies none (placeholders). */
const PLACEHOLDER = {
  install: 'echo "[init] configure INSTALL_CMD in init.sh"',
  verify: 'echo "[init] configure VERIFY_CMD in init.sh"',
  start: 'echo "[init] configure START_CMD in init.sh"',
} as const

function resolveCommands(input: TaskScaffoldInput): {
  install: string
  verify: string
  start: string
} {
  return {
    install: input.commands?.install?.trim() || PLACEHOLDER.install,
    verify: input.commands?.verify?.trim() || PLACEHOLDER.verify,
    start: input.commands?.start?.trim() || PLACEHOLDER.start,
  }
}

/** `TASK.md` — task-local instructions: what, why, acceptance, gotchas. */
export function renderTaskMd(input: TaskScaffoldInput): string {
  const lines: string[] = []
  lines.push(`# Task: ${input.title}`, '')
  lines.push(`- **Task ID:** \`${input.taskId}\``)
  if (input.teamName) lines.push(`- **Team:** ${input.teamName}`)
  lines.push('')
  lines.push('## What & why', '')
  lines.push(input.description?.trim() || '_No description provided._', '')
  lines.push('## Acceptance criteria', '')
  if (input.acceptanceCriteria?.length) {
    for (const c of input.acceptanceCriteria) lines.push(`- [ ] ${c}`)
  } else {
    lines.push('- [ ] _Define what "done" means for this task._')
  }
  lines.push('')
  lines.push('## Known gotchas', '')
  if (input.knownGotchas?.length) {
    for (const g of input.knownGotchas) lines.push(`- ${g}`)
  } else {
    lines.push('- _None recorded yet. Add constraints the next runtime should not rediscover._')
  }
  lines.push('')
  lines.push('## How to work this task', '')
  lines.push('1. Run `./init.sh` to install deps and confirm the baseline verifies.')
  lines.push(
    '2. Read `AGENT_HANDOFF.json` (if present) and `task-progress.md` to see where the last runtime left off.',
  )
  lines.push("3. Do the work. Keep changes within this task's scope.")
  lines.push('4. Record decisions in `DECISIONS.json` and evidence in `VERIFICATION.md`.')
  lines.push(
    '5. Before stopping, update `task-progress.md` and write `AGENT_HANDOFF.json` (clock-out).',
  )
  lines.push('')
  return lines.join('\n')
}

/** `task-progress.md` — the running state log + clock-in/clock-out ritual. */
export function renderProgressMd(input: TaskScaffoldInput): string {
  const cmds = resolveCommands(input)
  return [
    `# Progress — ${input.title}`,
    '',
    '## Current verified state',
    '',
    `- Task: \`${input.taskId}\``,
    `- Startup: \`./init.sh\``,
    `- Verify: \`${cmds.verify}\``,
    '- Current blocker: _none_',
    '',
    '## Done',
    '',
    '- _Nothing yet._',
    '',
    '## In progress',
    '',
    '- _Not started._',
    '',
    '## Blocked',
    '',
    '- _None._',
    '',
    '## Clock-in / clock-out',
    '',
    '**At entry (clock-in):** acquire the task, run `./init.sh`, read `AGENT_HANDOFF.json` + this file, run the baseline verify.',
    '',
    '**Before exit (clock-out):** run verify, update this file, write `AGENT_HANDOFF.json`, commit if the tree is clean.',
    '',
  ].join('\n')
}

/** `DECISIONS.json` — structured "why" decisions (the rationale compaction loses). */
export function renderDecisionsJson(): string {
  return (
    JSON.stringify(
      {
        $schema: 'clawboo/decisions@1',
        note: 'Append one entry per non-obvious decision: what was chosen, why, the rejected alternative, and the constraint. The "why" is what the next runtime needs and what summaries drop.',
        decisions: [] as Array<{
          date: string
          decision: string
          why: string
          rejectedAlternative?: string
          constraint?: string
        }>,
      },
      null,
      2,
    ) + '\n'
  )
}

/**
 * `init.sh` — the runtime-agnostic startup script. Shell + git work for every
 * runtime, so a Claude Code task and a Codex task boot the same way. Fails loud
 * (`set -euo pipefail`) so a broken baseline surfaces immediately instead of
 * leaking into later work. Edit the three `*_CMD` variables for the project.
 */
export function renderInitSh(input: TaskScaffoldInput): string {
  const cmds = resolveCommands(input)
  return [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    '',
    'ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"',
    'cd "$ROOT_DIR"',
    '',
    '# Project-specific commands — edit these for the repo under work.',
    `INSTALL_CMD=${shellQuote(cmds.install)}`,
    `VERIFY_CMD=${shellQuote(cmds.verify)}`,
    `START_CMD=${shellQuote(cmds.start)}`,
    '',
    'echo "==> Working directory: $PWD"',
    'echo "==> Syncing dependencies"',
    'eval "$INSTALL_CMD"',
    '',
    'echo "==> Running baseline verification"',
    'eval "$VERIFY_CMD"',
    '',
    'echo "==> Startup command: $START_CMD"',
    'if [ "${RUN_START_COMMAND:-0}" = "1" ]; then',
    '  echo "==> Starting"',
    '  eval "$START_CMD"',
    'fi',
    '',
    'echo "Set RUN_START_COMMAND=1 to launch the app directly."',
    '',
  ].join('\n')
}

/** `VERIFICATION.md` — evidence for the completion gate (test/lint output). */
export function renderVerificationMd(input: TaskScaffoldInput): string {
  const cmds = resolveCommands(input)
  return [
    `# Verification — ${input.title}`,
    '',
    'Record the evidence that this task is actually done — not "the code looks fine"',
    'but the output of a real check. The completion gate reads this file.',
    '',
    '## Commands',
    '',
    `- Verify: \`${cmds.verify}\``,
    '',
    '## Evidence',
    '',
    '- _Paste test / lint output here once it passes._',
    '',
  ].join('\n')
}

/** Single-quote a string for safe `eval` in bash (handles embedded quotes). */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/**
 * Write the full system-of-record scaffold into a worktree root. `init.sh` is
 * made executable. Does NOT write `AGENT_HANDOFF.json` — that is the clock-out
 * artifact, created by `writeHandoff` when a runtime first hands off.
 */
export async function writeScaffold(worktreePath: string, input: TaskScaffoldInput): Promise<void> {
  const at = (leaf: string) => path.join(worktreePath, leaf)
  await writeFile(at(SOR_FILES.task), renderTaskMd(input), 'utf8')
  await writeFile(at(SOR_FILES.progress), renderProgressMd(input), 'utf8')
  await writeFile(at(SOR_FILES.decisions), renderDecisionsJson(), 'utf8')
  await writeFile(at(SOR_FILES.init), renderInitSh(input), 'utf8')
  await writeFile(at(SOR_FILES.verification), renderVerificationMd(input), 'utf8')
  await chmod(at(SOR_FILES.init), 0o755)
}
