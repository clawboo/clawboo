// The cross-runtime handoff bridge. `AGENT_HANDOFF.json` is STRUCTURED DATA, not
// prose: the next runtime parses it rather than interpreting English, so a task
// can pass cleanly from one runtime to a different one (e.g. Claude Code →
// Codex) — or to a human. `reconstructState` is the clock-in read: it rebuilds
// "what's done / what's broken / what's next" purely from the worktree's
// system-of-record, with no access to chat history or the board UI.

import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { z } from 'zod'

import { SOR_FILES } from './scaffold'
import type { ResumeState } from './types'

/**
 * The handoff schema. Role-neutral by design: `runtime` is any executor id and
 * may be `'human'`, so a human teammate can pick up (or hand off) a task from
 * the same artifact a Claude Code or Codex agent would.
 */
export const agentHandoffSchema = z.object({
  /** Display name / id of who is handing off (an agent name, or a person). */
  handoffFrom: z.string().min(1),
  /** The runtime that produced this handoff (role-neutral; may be `human`). */
  runtime: z.string().min(1),
  /** ISO-8601 timestamp of the handoff. */
  timestamp: z.string().min(1),
  /** What works now (completed, verified subtasks). */
  completedSubtasks: z.array(z.string()).default([]),
  /** What is broken or unverified — the next runtime's risk list. */
  brokenOrUnverified: z.array(z.string()).default([]),
  /** The single next best step. */
  nextBestStep: z.string().default(''),
  /** Why the task is blocked, if it is. */
  whyBlocked: z.string().nullable().optional(),
  /** Runtime-agnostic commands to re-enter the work. */
  commands: z
    .object({
      init: z.string().default('./init.sh'),
      verify: z.string().default(''),
      start: z.string().default(''),
    })
    .default({ init: './init.sh', verify: '', start: '' }),
  /** Evidence captured for the completion gate. */
  evidence: z
    .object({
      testResults: z.string().nullable().optional(),
      lintResults: z.string().nullable().optional(),
    })
    .default({}),
  /** Free-form warnings for the next runtime. */
  warnings: z.array(z.string()).default([]),
  /**
   * Native session id of the producing runtime (same-runtime resume handle,
   * e.g. a Hermes/Claude session id). Consumed only when `runtime` matches the
   * next dispatch's runtime — a cross-runtime pickup ignores it and resumes
   * from the structured handoff alone.
   */
  nativeSessionId: z.string().nullable().optional(),
  /**
   * Team-chat room cursor — the room + last post `seq` this runtime had
   * already seen when it clocked out. Lets a one-shot LEADER resume mid-room
   * between heartbeat turns (read only the new posts since `lastSeenSeq`).
   * Additive + optional: absent for ordinary code-task handoffs. A worktree-less
   * chat turn keeps the same state in SQLite (see the server leaderState store);
   * this field carries it when a leader turn is worktree-backed.
   */
  roomCursor: z
    .object({ roomId: z.string(), lastSeenSeq: z.number().int().nonnegative() })
    .nullable()
    .optional(),
})

export type AgentHandoff = z.infer<typeof agentHandoffSchema>

/** Input to `writeHandoff` — `timestamp` defaults to now if omitted. */
export type AgentHandoffInput = Omit<AgentHandoff, 'timestamp'> & { timestamp?: string }

/** Write `AGENT_HANDOFF.json` at the worktree root (the clock-out artifact). */
export async function writeHandoff(
  worktreePath: string,
  input: AgentHandoffInput,
): Promise<AgentHandoff> {
  const handoff = agentHandoffSchema.parse({
    ...input,
    timestamp: input.timestamp ?? new Date().toISOString(),
  })
  await writeFile(
    path.join(worktreePath, SOR_FILES.handoff),
    JSON.stringify(handoff, null, 2) + '\n',
    'utf8',
  )
  return handoff
}

/** Read + validate `AGENT_HANDOFF.json`; null if absent or malformed. */
export async function readHandoff(worktreePath: string): Promise<AgentHandoff | null> {
  let raw: string
  try {
    raw = await readFile(path.join(worktreePath, SOR_FILES.handoff), 'utf8')
  } catch {
    return null // no handoff written yet (first pickup)
  }
  try {
    return agentHandoffSchema.parse(JSON.parse(raw))
  } catch {
    return null // malformed — treat as no handoff (caller falls back to progress)
  }
}

/** Extract `INSTALL_CMD`/`VERIFY_CMD`/`START_CMD` from a worktree's init.sh. */
async function readInitCommands(
  worktreePath: string,
): Promise<{ init: string; verify: string; start: string }> {
  const commands = { init: `./${SOR_FILES.init}`, verify: '', start: '' }
  let body: string
  try {
    body = await readFile(path.join(worktreePath, SOR_FILES.init), 'utf8')
  } catch {
    return commands
  }
  const grab = (name: string): string => {
    const m = body.match(new RegExp(`^${name}='((?:[^']|'\\\\'')*)'`, 'm'))
    return m ? m[1].replace(/'\\''/g, `'`) : ''
  }
  commands.verify = grab('VERIFY_CMD')
  commands.start = grab('START_CMD')
  return commands
}

/** Pull bullet items out of a named `## Section` of a markdown doc. */
function bulletsUnder(markdown: string, heading: string): string[] {
  const lines = markdown.split('\n')
  const out: string[] = []
  let inSection = false
  for (const line of lines) {
    const h = line.match(/^##\s+(.*)$/)
    if (h) {
      inSection = h[1].trim().toLowerCase() === heading.toLowerCase()
      continue
    }
    if (!inSection) continue
    const b = line.match(/^\s*-\s+(.*)$/)
    if (b) {
      const item = b[1].trim()
      // Skip the template placeholders (italicised "_…_").
      if (item && !/^_.*_$/.test(item)) out.push(item)
    }
  }
  return out
}

/**
 * Reconstruct the resume state for a fresh runtime at clock-in — reading ONLY
 * the worktree's system-of-record (`AGENT_HANDOFF.json`, falling back to
 * `task-progress.md`, plus `init.sh` for commands). No chat, no board. This is
 * the proof that the handoff is runtime-agnostic.
 */
export async function reconstructState(worktreePath: string): Promise<ResumeState> {
  const initCommands = await readInitCommands(worktreePath)
  const handoff = await readHandoff(worktreePath)

  if (handoff) {
    return {
      hasHandoff: true,
      done: handoff.completedSubtasks,
      broken: handoff.brokenOrUnverified,
      next: handoff.nextBestStep || null,
      whyBlocked: handoff.whyBlocked ?? null,
      commands: {
        init: handoff.commands.init || initCommands.init,
        verify: handoff.commands.verify || initCommands.verify,
        start: handoff.commands.start || initCommands.start,
      },
      warnings: handoff.warnings,
      lastRuntime: handoff.runtime,
      nativeSessionId: handoff.nativeSessionId ?? null,
    }
  }

  // No handoff yet (first pickup) — fall back to the progress log so resume
  // still works from the repo alone.
  let progress = ''
  try {
    progress = await readFile(path.join(worktreePath, SOR_FILES.progress), 'utf8')
  } catch {
    // no progress file either — return an empty-but-valid resume state
  }
  return {
    hasHandoff: false,
    done: bulletsUnder(progress, 'Done'),
    broken: bulletsUnder(progress, 'Blocked'),
    next: null,
    whyBlocked: null,
    commands: initCommands,
    warnings: [],
    lastRuntime: null,
    nativeSessionId: null,
  }
}
