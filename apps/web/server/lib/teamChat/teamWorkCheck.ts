// The team chat's work check: the task runner's own verification gate
// (../verification), run on the team folder a team-chat task worked in.
//
// A team folder is not a git checkout, so what a task changed is measured
// against a history clawboo keeps OUTSIDE it: one bare repository per team under
// `<clawboo home>/team-folder-history/`, with the folder as its work tree. The
// agents never see it, and a `.git` an agent makes in the folder stays its own.
// `begin` commits the folder as a task's run starts and pins that commit as the
// task's starting point; `prepare` commits it again when the run ends and
// compares the two. The folder is shared by every teammate, so a check sees the
// whole folder, including what a teammate working at the same time changed.
//
// A check waits its turn: while another run of the team is working in the folder,
// or another check of the team is running, it holds (see `holdCheck` and
// ../runtimes/teamFolderActivity), so a teammate's half-written change cannot fail
// it. What a teammate changed during the task's own run is still in what it measures.
//
// Checked only when the team has a verify command (its Work check). Without one
// a change is left unchecked rather than failed: much team-chat work writes
// documents, not code, and a gate with no command can only fail.

import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { resolveClawbooDir } from '@clawboo/config'
import {
  addComment,
  agents,
  getAncestors,
  getTask,
  getTaskVerification,
  listExecutions,
  recordSpend,
  setTaskCheckHeld,
  startTaskHeartbeat,
  updateStatus,
  type ClawbooDb,
} from '@clawboo/db'
import type { RuntimeAdapter } from '@clawboo/executor'
import { usdToFractionalCents, type CheckHold } from '@clawboo/governance'
import { createLogger } from '@clawboo/logger'
import {
  WORK_CHECK_HOLD_LIMIT_MS,
  type BoardChange,
  type PreparedWorkCheck,
  type WorkCheck,
  type WorkCheckResult,
} from '@clawboo/team-orchestration'
import { assertSafeTaskId, execGit, KeyedMutex, type DiffStat } from '@clawboo/worktrees'
import { eq } from 'drizzle-orm'

import { isLocalModel } from '../costUtils'
import { emitEvent } from '../obs'
import { adapterFactoryFor, type RuntimeRunContext } from '../runtimes'
import { isOrchestratableRuntimeId } from '../runtimes/descriptor'
import { estimateRunCostUsd, estimateTokensFromChars } from '../runtimes/estimateCost'
import { sanitizeAgentId } from '../runtimes/identityHome'
import {
  enterFolderCheckLine,
  folderRunners,
  type FolderCheckTurn,
} from '../runtimes/teamFolderActivity'
import { ensureTeamWorkdir, teamWorkdirFor, teamWorkdirPath } from '../runtimes/teamWorkdir'
import { recordRunTokens } from '../runTokenLog'
import { verifyMaxAttempts, verifyTask, type ReviewerSpend } from '../verification'
import { readTeamVerifyCommand } from '../verification/teamVerifyCommand'
import { parseCodingModelConfig } from './serverDeliver'

const log = createLogger('team-work-check')

/** Dependency folders a check never commits or reviews. */
const HISTORY_EXCLUDES = [
  'node_modules/',
  '.venv/',
  'venv/',
  '__pycache__/',
  '.next/',
  '.turbo/',
  'target/',
]

/** One git operation at a time per team history (the index is shared). */
const historyMutex = new KeyedMutex()

/**
 * `<clawboo home>/team-folder-history/<team>.git`. Pinned under that root with
 * the same single startsWith test as `teamWorkdirPath`, so no team id can name a
 * folder anywhere else.
 */
export function teamFolderHistoryDir(teamId: string): string {
  const root = path.resolve(resolveClawbooDir(), 'team-folder-history')
  const prefix = root.endsWith(path.sep) ? root : root + path.sep
  const dir = path.resolve(root, `${sanitizeAgentId(teamId)}.git`)
  if (!dir.startsWith(prefix)) {
    throw new Error(`team folder history escapes ${root}: ${dir}`)
  }
  return dir
}

/** Forget where a task's work began: a person marked it Done or cancelled it, so
 *  it is not checked again. Best-effort; a team with no history has nothing to drop. */
export async function dropTeamFolderBase(teamId: string, taskId: string): Promise<void> {
  const gitDir = teamFolderHistoryDir(teamId)
  if (!existsSync(path.join(gitDir, 'HEAD'))) return
  const folder = teamWorkdirPath(teamId)
  await historyMutex
    .run(gitDir, () => historyGit(gitDir, folder, ['update-ref', '-d', baseRef(taskId)]))
    .catch(() => undefined)
}

const baseRef = (taskId: string): string => `refs/clawboo/base/${assertSafeTaskId(taskId)}`

function historyGit(gitDir: string, folder: string, args: string[]): Promise<string> {
  return execGit(folder, ['--git-dir', gitDir, '--work-tree', folder, ...args])
}

async function ensureHistory(gitDir: string): Promise<void> {
  if (existsSync(path.join(gitDir, 'HEAD'))) return
  await mkdir(gitDir, { recursive: true, mode: 0o700 })
  await execGit(gitDir, ['init', '--bare', '-q'])
  await mkdir(path.join(gitDir, 'info'), { recursive: true })
  await writeFile(path.join(gitDir, 'info', 'exclude'), `${HISTORY_EXCLUDES.join('\n')}\n`)
}

/** How many times a snapshot tries `git add` before it gives up. */
const STAGE_TRIES = 3

/** Stage the folder. A teammate can delete a file while git reads the folder, which
 *  fails the whole add; the next pass no longer sees that file. */
async function stageFolder(gitDir: string, folder: string): Promise<void> {
  for (let tries = 1; ; tries++) {
    try {
      await historyGit(gitDir, folder, ['add', '-A'])
      return
    } catch (err) {
      if (tries >= STAGE_TRIES) throw err
    }
  }
}

/** Commit the folder as it is now, less what git leaves out: the dependency
 *  folders above, and whatever a `.gitignore` in the folder ignores. Returns the
 *  commit. Ignored files stay out on purpose: forcing them in would also take
 *  `.env` files and the like into the history and the reviewer's checkout.
 *
 *  `orOlder` is for a task's starting point: if the folder cannot be staged, it
 *  commits what the last snapshot staged. An older start can only add to what the
 *  task is measured on, while no start at all would leave its work unchecked. An
 *  end point never does this: it could hide the very change it is measuring. */
async function snapshot(
  gitDir: string,
  folder: string,
  message: string,
  opts: { orOlder?: boolean } = {},
): Promise<string> {
  await stageFolder(gitDir, folder).catch((err: unknown) => {
    if (!opts.orOlder) throw err
    log.warn({ err, folder }, 'could not stage the team folder; starting from its last snapshot')
  })
  await historyGit(gitDir, folder, [
    '-c',
    'user.name=clawboo',
    '-c',
    'user.email=clawboo@localhost',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '--no-verify',
    '--allow-empty',
    '-q',
    '-m',
    message,
  ])
  return (await historyGit(gitDir, folder, ['rev-parse', 'HEAD'])).trim()
}

async function diffBetween(
  gitDir: string,
  folder: string,
  base: string,
  head: string,
): Promise<DiffStat> {
  const numstat = await historyGit(gitDir, folder, ['diff', '--numstat', base, head])
  let filesChanged = 0
  let insertions = 0
  let deletions = 0
  for (const line of numstat.split('\n')) {
    if (!line.trim()) continue
    const [add, del] = line.split('\t')
    filesChanged += 1
    insertions += add === '-' ? 0 : Number(add) || 0
    deletions += del === '-' ? 0 : Number(del) || 0
  }
  return { filesChanged, insertions, deletions, dirty: filesChanged > 0 }
}

/** How one check has waited for the team folder. `since` is null until it has. */
interface CheckWait {
  turn: FolderCheckTurn | null
  since: number | null
  waitedMs: number
  limitReached: boolean
}

export interface TeamWorkCheckOpts {
  db: ClawbooDb
  teamId: string
  mcpBaseUrl: string | null
  /** The reviewer for an agent's runtime (tests). Defaults to that runtime's adapter. */
  makeReviewerAdapter?: (runtime: string) => ((ctx: RuntimeRunContext) => RuntimeAdapter) | null
  /** Tell open chats a check began or stopped waiting, so their cards say so. */
  onBoardChange?: (change: BoardChange) => void
}

/** The engine's `workCheck` for one team (see WorkCheck in @clawboo/team-orchestration). */
export function createTeamWorkCheck(opts: TeamWorkCheckOpts): WorkCheck {
  const { db, teamId } = opts
  const gitDir = teamFolderHistoryDir(teamId)

  /** What a check of this agent's work needs, or null when there is none to make. */
  const targetFor = (
    agentId: string,
  ): { folder: string; command: string; runtime: string; model: string | null } | null => {
    const command = readTeamVerifyCommand(db, teamId)
    if (!command) return null
    const row = db.select().from(agents).where(eq(agents.id, agentId)).get() as
      { runtime?: string | null; execConfig?: string | null } | undefined
    const runtime = row?.runtime ?? null
    const folder = teamWorkdirFor(runtime, teamId)
    if (!runtime || !folder) return null
    const model = parseCodingModelConfig(row?.execConfig ?? null)?.model ?? null
    return { folder, command, runtime, model }
  }

  const dropBase = async (folder: string, taskId: string): Promise<void> => {
    await historyMutex
      .run(gitDir, () => historyGit(gitDir, folder, ['update-ref', '-d', baseRef(taskId)]))
      .catch(() => undefined)
  }

  const reviewerFor = (runtime: string): ((ctx: RuntimeRunContext) => RuntimeAdapter) | null => {
    if (opts.makeReviewerAdapter) return opts.makeReviewerAdapter(runtime)
    return isOrchestratableRuntimeId(runtime) ? adapterFactoryFor(runtime) : null
  }

  /** The task's starting point, or '' when it has none. */
  const baseOf = async (folder: string, taskId: string): Promise<string> =>
    existsSync(path.join(gitDir, 'HEAD'))
      ? (
          await historyGit(gitDir, folder, [
            'rev-parse',
            '--verify',
            '-q',
            `${baseRef(taskId)}^{commit}`,
          ]).catch(() => '')
        ).trim()
      : ''

  const note = (taskId: string, text: string): void => {
    try {
      addComment(db, taskId, text, 'system')
    } catch (err) {
      log.error({ err, teamId, taskId }, 'could not comment on the task')
    }
  }

  /** The folder's commit now and what changed since the task's start, or null when
   *  the task has no starting point. */
  const measure = (
    folder: string,
    taskId: string,
  ): Promise<{ b: string; h: string; d: DiffStat } | null> =>
    historyMutex.run(gitDir, async () => {
      const b = await baseOf(folder, taskId)
      if (!b) return null
      const h = await snapshot(gitDir, folder, `clawboo: task ${taskId}`)
      return { b, h, d: await diffBetween(gitDir, folder, b, h) }
    })

  /** What the team folder is busy with, in words. */
  const folderBusyWith = (folder: string): string => {
    const names = folderRunners(folder).map((id) => {
      const row = db.select().from(agents).where(eq(agents.id, id)).get() as
        { name?: string | null } | undefined
      return row?.name || id
    })
    if (names.length === 0) return "another task's check is running in the team folder"
    const who =
      names.length === 1 ? names[0]! : `${names.slice(0, -1).join(', ')} and ${names.at(-1)!}`
    return `${who} ${names.length === 1 ? 'is' : 'are'} still working in the team folder`
  }

  /** The wait is over: the card stops saying so, and a wait that ran out says that.
   *  Reads the mark rather than `wait`, so a mark some other write left behind can
   *  never read as waiting during a real check. */
  const endWait = (taskId: string, folder: string, wait: CheckWait): void => {
    if (getTask(db, taskId)?.checkHeldSince != null) {
      setTaskCheckHeld(db, taskId, null)
      opts.onBoardChange?.({
        id: taskId,
        status: 'in_review',
        checkHeldSince: null,
        updatedAt: Date.now(),
      })
    }
    if (wait.limitReached)
      note(
        taskId,
        `Stopped waiting after ${Math.round(WORK_CHECK_HOLD_LIMIT_MS / 60_000)} minutes: ${folderBusyWith(folder)}. The check runs now, so it may include unfinished work that is not this task's.`,
      )
  }

  /**
   * Wait for the check's turn on the team folder (see PreparedWorkCheck.hold). A
   * clear folder changes nothing. Otherwise the card goes In review now, as for a
   * running check: the board's stale sweep leaves it, and a restart hands it to a
   * person. It takes no run slot and no budget.
   */
  async function holdCheck(
    taskId: string,
    folder: string,
    wait: CheckWait,
    signal: AbortSignal,
  ): Promise<() => void> {
    const turn = enterFolderCheckLine(folder)
    wait.turn = turn
    if (turn.clear) return turn.leave
    try {
      // A task that cannot enter review was moved by a person: nothing to wait for.
      if (
        !updateStatus(db, taskId, 'in_review', {
          waitingOn: { kind: 'verification', state: 'running' },
        }).ok
      )
        return turn.leave
      const since = Date.now()
      wait.since = since
      setTaskCheckHeld(db, taskId, since)
      // On the event log too: this move does not go through the board client.
      emitEvent(db, {
        kind: 'status_changed',
        taskId,
        teamId,
        data: { to: 'in_review', reason: 'check_waiting' },
      })
      opts.onBoardChange?.({
        id: taskId,
        status: 'in_review',
        checkHeldSince: since,
        updatedAt: since,
      })
      note(
        taskId,
        `Waiting to check this work: ${folderBusyWith(folder)}. The check runs once the folder is clear, or after ${Math.round(WORK_CHECK_HOLD_LIMIT_MS / 60_000)} minutes at most.`,
      )
      await turn.wait(signal)
      wait.waitedMs = Date.now() - since
      wait.limitReached = signal.aborted
      return turn.leave
    } catch (err) {
      turn.leave()
      throw err
    }
  }

  /**
   * After an attempt failed the check, a later attempt that cannot be checked
   * cannot pass either (and the board would refuse `done` over the failed
   * verdict): the task goes to a person with the reason.
   */
  const unableToCheck =
    (taskId: string, reason: string): (() => Promise<WorkCheckResult>) =>
    async () => {
      const status = getTask(db, taskId)?.status
      if (status !== 'in_progress' && status !== 'in_review') return { verdict: 'decided' }
      note(taskId, reason)
      updateStatus(db, taskId, 'blocked', {
        waitingOn: { kind: 'verification', state: 'could_not_run' },
      })
      return { verdict: 'failed', reason }
    }

  return {
    async begin(taskId, agentId) {
      const target = targetFor(agentId)
      if (!target) return
      // The task is claimed and nothing beats it until its run starts, so a slow
      // snapshot (a big folder, another task's snapshot ahead in the queue) must
      // not read as a dead claim to the board's stale sweep.
      const stopBeat = startTaskHeartbeat(db, taskId, {
        assigneeAgentId: agentId,
        execId: getTask(db, taskId)?.runExecutionId ?? null,
      })
      try {
        await ensureTeamWorkdir(target.folder)
        await historyMutex.run(gitDir, async () => {
          await ensureHistory(gitDir)
          // A task that already has a starting point keeps it: a Retry after a
          // failed check is measured from where the task first began, so a Retry
          // that changes nothing is still checked.
          if (await baseOf(target.folder, taskId)) return
          const sha = await snapshot(gitDir, target.folder, `clawboo: before task ${taskId}`, {
            orOlder: true,
          })
          await historyGit(gitDir, target.folder, ['update-ref', baseRef(taskId), sha])
        })
      } catch (err) {
        log.error({ err, teamId, taskId }, 'could not record the team folder before the run')
        const why = err instanceof Error ? err.message : String(err)
        note(
          taskId,
          `Clawboo could not record the team folder before this run, so its work will not be checked: ${why}`,
        )
      } finally {
        stopBeat()
      }
    },

    async prepare(taskId, agentId) {
      if (getTask(db, taskId)?.status !== 'in_progress') return null
      const tried = (getTaskVerification(db, taskId)?.attempts.length ?? 0) > 0
      const target = targetFor(agentId)
      if (!target)
        return tried
          ? unableToCheck(
              taskId,
              "An earlier attempt failed the team's check, and the team no longer has a check this attempt can run, so the task waits for a person.",
            )
          : null
      const noStart =
        "An earlier attempt failed the team's check, and the record of where this task began is gone, so the task waits for a person."
      let measured: { b: string; h: string; d: DiffStat } | null = null
      let measureFailed = false
      try {
        measured = await measure(target.folder, taskId)
      } catch (err) {
        log.warn({ err, teamId, taskId }, 'could not measure what the task changed')
        measureFailed = true
      }
      if (!measureFailed) {
        if (!measured) return tried ? unableToCheck(taskId, noStart) : null
        // After a failed attempt the check runs even on an unchanged folder: the
        // work it failed may still be there, and an undo has to pass it too.
        if (!measured.d.dirty && !tried) {
          await dropBase(target.folder, taskId)
          return null
        }
      }
      // The run this check is for: the task's latest execution now, as the run
      // that just ended. A newer one means the task is being run again.
      const runId = latestRun(taskId)
      const wait: CheckWait = { turn: null, since: null, waitedMs: 0, limitReached: false }
      const prepared: PreparedWorkCheck = async () => {
        if (measured)
          return check(taskId, agentId, target, measured.b, measured.h, measured.d, runId, wait)
        // A folder a teammate is changing can fail a measure, which must not leave the
        // work unchecked: the wait came first, and this is one more try. Only now
        // does it give up, the way a measure that fails on a quiet folder does.
        if (wait.since !== null && getTask(db, taskId)?.status !== 'in_review')
          return { verdict: 'decided' }
        let found: { b: string; h: string; d: DiffStat } | null
        try {
          found = await measure(target.folder, taskId)
        } catch (err) {
          log.error({ err, teamId, taskId }, 'could not measure what the task changed')
          const why = err instanceof Error ? err.message : String(err)
          endWait(taskId, target.folder, wait)
          if (tried)
            return unableToCheck(
              taskId,
              `An earlier attempt failed the team's check, and this one could not be measured, so the task waits for a person: ${why}`,
            )()
          note(
            taskId,
            `Clawboo could not see what this run changed, so its work is not checked: ${why}`,
          )
          return { verdict: 'unchecked' }
        }
        if (!found || (!found.d.dirty && !tried)) {
          endWait(taskId, target.folder, wait)
          if (!found && tried) return unableToCheck(taskId, noStart)()
          if (found) await dropBase(target.folder, taskId)
          return { verdict: 'unchecked' }
        }
        return check(taskId, agentId, target, found.b, found.h, found.d, runId, wait)
      }
      prepared.hold = (signal) => holdCheck(taskId, target.folder, wait, signal)
      return prepared
    },
  }

  function latestRun(taskId: string): string | null {
    return listExecutions(db, taskId).at(-1)?.id ?? null
  }

  async function check(
    taskId: string,
    agentId: string,
    target: { folder: string; command: string; runtime: string; model: string | null },
    base: string,
    measuredHead: string,
    measuredDiff: DiffStat,
    runId: string | null,
    wait: CheckWait,
  ): Promise<WorkCheckResult> {
    // This check still speaks for the task: still in review, and not run again
    // since (a person's Retry, or the engine giving up on this check, ends it).
    // Asked before the verdict is written and before every card move.
    const stillMine = (): boolean =>
      getTask(db, taskId)?.status === 'in_review' && latestRun(taskId) === runId
    // Superseded: a person moved the card (to Done, Cancelled or Blocked), or the
    // task is being run again. That stands, nothing here moves the card, and no
    // verdict was written. Only Done and Cancelled end the task's history; a
    // Blocked task can be retried and is then measured from its start.
    const superseded = async (): Promise<WorkCheckResult> => {
      const now = getTask(db, taskId)?.status
      if (now === 'done' || now === 'cancelled') await dropBase(target.folder, taskId)
      return { verdict: 'decided' }
    }
    // A wait left the card in review, so anything else is a person's move. Asked
    // before the move below, which would otherwise pull the card back.
    if (latestRun(taskId) !== runId || (wait.since !== null && !stillMine())) return superseded()
    // In review while it is checked, as on the task runner: the board shows the
    // check running, and the stale sweep (which watches `in_progress`) leaves it.
    // A task that cannot enter review was moved by a person meanwhile.
    if (
      !updateStatus(db, taskId, 'in_review', {
        waitingOn: { kind: 'verification', state: 'running' },
      }).ok
    )
      return { verdict: 'decided' }
    endWait(taskId, target.folder, wait)
    // After a wait, what is checked and reviewed is the folder as it is now. The
    // snapshot from the run's end stands in if this one cannot be taken.
    let head = measuredHead
    let diff = measuredDiff
    if (wait.since !== null) {
      try {
        const now = await measure(target.folder, taskId)
        if (now) {
          head = now.h
          diff = now.d
        }
      } catch (err) {
        log.warn({ err, teamId, taskId }, 'could not measure the folder again after the wait')
      }
    }
    /** Something else was in the folder during this check (see CheckHold). */
    const hadCompany = (): boolean => wait.limitReached || (wait.turn?.sawRun() ?? false)
    const reviewerModel = process.env['CLAWBOO_REVIEWER_MODEL'] || target.model
    const reviewer = reviewerFor(target.runtime)
    const verdict = await verifyTask({
      db,
      taskId,
      repoPath: gitDir,
      worktree: {
        taskId,
        worktreePath: target.folder,
        branch: '',
        baseCommit: base,
        detached: false,
      },
      diffStat: diff,
      reviewRootDir: path.join(resolveClawbooDir(), 'reviews', `team-${sanitizeAgentId(teamId)}`),
      verifyCommand: target.command,
      reviewSha: head,
      evidence: false,
      ...(reviewer ? { makeReviewerAdapter: reviewer } : {}),
      reviewerModel,
      mcpBaseUrl: opts.mcpBaseUrl,
      onReviewerSpend: (spend) => chargeReview(taskId, agentId, reviewerModel, spend),
      shouldRecord: stillMine,
      hold: (): CheckHold | null => {
        const runBeside = wait.turn?.sawRun() ?? false
        if (wait.since === null && !runBeside) return null
        return { waitedMs: wait.waitedMs, limitReached: wait.limitReached, runBeside }
      },
    })

    if (!stillMine()) return superseded()
    const last = verdict.attempts[verdict.attempts.length - 1]
    const err = last?.structuredError
    if (verdict.status === 'pass') {
      await dropBase(target.folder, taskId)
      return { verdict: 'pass' }
    }
    const reason = err?.what ?? 'The check failed.'
    if (
      verdict.status === 'completed_with_debt' ||
      verdict.attempts.length >= verifyMaxAttempts()
    ) {
      // The last attempt failed too: a person decides, as on the task runner. The
      // starting point stays, so a person's Retry is measured from it.
      updateStatus(db, taskId, 'blocked', { waitingOn: { kind: 'verification', state: 'failed' } })
      note(
        taskId,
        `Verification failed ${verdict.attempts.length} times and the fix loop is exhausted, so the task waits for a person. See the verification comments above for what failed.`,
      )
      return { verdict: 'failed', reason }
    }
    updateStatus(db, taskId, 'in_progress')
    const fixNote = err
      ? `What: ${err.what}\nWhy: ${err.why}\nHow to fix: ${err.howToFix}`
      : 'The check failed.'
    return {
      verdict: 'retry',
      fixNote: hadCompany()
        ? `${fixNote}\n\nSomething else was working in the team folder during this check, so this failure may come from its unfinished work rather than yours.`
        : fixNote,
    }
  }

  /** The reviewer's run is paid work for this task: charged like the task runner's. */
  function chargeReview(
    taskId: string,
    agentId: string,
    reviewerModel: string | null,
    spend: ReviewerSpend,
  ): void {
    try {
      const model = spend.model || reviewerModel || null
      const usd =
        spend.usd ??
        (isLocalModel(model)
          ? 0
          : estimateRunCostUsd({
              model,
              inputChars: spend.inputChars,
              outputChars: spend.outputChars,
            }))
      if (usd > 0) {
        const cents = usdToFractionalCents(usd)
        recordSpend(db, 'agent', agentId, cents)
        recordSpend(db, 'team', teamId, cents)
        const ancestors = getAncestors(db, taskId)
        const mission = ancestors.find((a) => a.parent_task_id == null)?.id ?? taskId
        recordSpend(db, 'mission', mission, cents)
      }
      recordRunTokens(db, {
        agentId,
        runtime: spend.runtime,
        model,
        inputTokens:
          spend.usd == null ? estimateTokensFromChars(spend.inputChars) : spend.inputTokens,
        outputTokens:
          spend.usd == null ? estimateTokensFromChars(spend.outputChars) : spend.outputTokens,
        costUsd: usd,
        runId: null,
        sessionKey: spend.sessionKey,
      })
    } catch (err) {
      log.error({ err, teamId, taskId }, 'could not charge the review')
    }
  }
}
