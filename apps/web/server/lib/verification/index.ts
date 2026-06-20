// verifyTask — composes the two-layer verification gate (builder ≠ judge) and
// records a TYPED verdict on the task. Deterministic gate FIRST (the hard signal);
// the read-only critic runs only on a green gate for a risky/large diff (no point
// reviewing broken code, and no model spend otherwise). A failing verdict carries
// a STRUCTURED {what,why,howToFix} so the leader routes a real fix back — not just
// "FAIL". The fix loop is bounded across re-completions (the attempts array IS the
// loop history); on exhaustion the task is marked `completed_with_debt` and the
// open issues are recorded — never a deadlock. The independent evaluator is permanent.

import {
  addComment,
  appendAudit,
  getTask,
  getTaskVerification,
  setTaskVerification,
  type ClawbooDb,
} from '@clawboo/db'
import {
  blockingFindings,
  DEFAULT_MAX_FIX_CYCLES,
  nextCycleDecision,
  verificationStatusFor,
  type CriticVerdict,
  type DebtNote,
  type DeterministicResult,
  type StructuredError,
  type VerificationAttempt,
  type VerificationResult,
} from '@clawboo/governance'
import type { RuntimeAdapter } from '@clawboo/executor'
import type { DiffStat, Worktree } from '@clawboo/worktrees'
import { commitWorktreeWork } from '@clawboo/worktrees'

import type { RuntimeRunContext } from '../runtimes'
import { runCritic } from './critic'
import { runDeterministicGate } from './deterministicGate'

export { runDeterministicGate } from './deterministicGate'
export { runCritic } from './critic'

const CRITIC_NOT_RUN: CriticVerdict = {
  ran: false,
  findings: [],
  reviewerRuntime: null,
  reviewerModel: null,
  reviewedSha: null,
}

export interface VerifyTaskInput {
  db: ClawbooDb
  taskId: string
  repoPath: string
  worktree: Worktree
  diffStat: DiffStat
  reviewRootDir: string
  /** Verify command override (else parsed from the worktree's init.sh). */
  verifyCommand?: string | null
  /** When provided + the gate is green + the diff is risky/large, run the critic. */
  makeReviewerAdapter?: (ctx: RuntimeRunContext) => RuntimeAdapter
  reviewerModel?: string | null
  mcpBaseUrl?: string | null
  maxFixCycles?: number
  verifyTimeoutMs?: number
  riskFlag?: boolean
}

function structuredErrorFor(det: DeterministicResult, critic: CriticVerdict): StructuredError {
  if (!det.passed) {
    return {
      what: `The deterministic gate failed: \`${det.command}\` ${det.timedOut ? 'timed out' : `exited ${det.exitCode ?? 'null'}`}.`,
      why: 'A task cannot reach "done" until its build/test/lint gate is green.',
      howToFix: (
        det.stderrTail ||
        det.stdoutTail ||
        'Fix the failing checks, then re-submit for verification.'
      ).slice(0, 1500),
    }
  }
  const blocking = blockingFindings(critic)
  return {
    what: `The reviewer found ${blocking.length} blocking issue(s).`,
    why: 'Blocking findings (security / crash / data-loss / wrong-algorithm / missing-AC) must be resolved before "done".',
    howToFix:
      blocking
        .map(
          (f) =>
            `[${f.severity}] ${f.title}${f.filePath ? ` (${f.filePath}${f.startLine ? `:${f.startLine}` : ''})` : ''}`,
        )
        .join('\n') || 'Address the reviewer findings.',
  }
}

/**
 * Run the gate + critic for a task currently in `in_review`, persist the typed
 * verdict, and return it. Does NOT change the task status — the caller
 * (`actOnTaskWorkspace`) maps `pass → done`, `fail → in_progress`,
 * `completed_with_debt → done` (debt bypasses the gate by policy).
 */
export async function verifyTask(input: VerifyTaskInput): Promise<VerificationResult> {
  const { db, taskId } = input
  const task = getTask(db, taskId)
  const prior = getTaskVerification(db, taskId)
  const priorAttempts = prior?.attempts ?? []
  const maxCycles = input.maxFixCycles ?? DEFAULT_MAX_FIX_CYCLES

  const det = await runDeterministicGate({
    worktreePath: input.worktree.worktreePath,
    verifyCommand: input.verifyCommand,
    timeoutMs: input.verifyTimeoutMs,
  })

  let critic: CriticVerdict = CRITIC_NOT_RUN
  if (det.passed && input.makeReviewerAdapter) {
    try {
      const { head } = await commitWorktreeWork(input.repoPath, input.worktree)
      critic = await runCritic({
        repoPath: input.repoPath,
        reviewSha: head,
        diffStat: input.diffStat,
        hasParent: Boolean(task?.parentTaskId),
        makeReviewerAdapter: input.makeReviewerAdapter,
        reviewerModel: input.reviewerModel,
        mcpBaseUrl: input.mcpBaseUrl,
        riskFlag: input.riskFlag,
        reviewRootDir: input.reviewRootDir,
      })
    } catch {
      // A critic failure must never block (or crash) the deterministic verdict.
      critic = CRITIC_NOT_RUN
    }
  }

  const attemptStatus = verificationStatusFor(det, critic) // 'pass' | 'fail'
  const attemptNumber = priorAttempts.length + 1
  let status: VerificationResult['status'] = attemptStatus
  let structuredError: StructuredError | null = null
  const debtNotes: DebtNote[] = [...(prior?.debtNotes ?? [])]

  if (attemptStatus === 'fail') {
    structuredError = structuredErrorFor(det, critic)
    if (nextCycleDecision({ attempt: attemptNumber, maxCycles }) === 'mark_debt') {
      status = 'completed_with_debt'
      for (const f of blockingFindings(critic)) {
        debtNotes.push({
          criterion: f.title,
          severity: f.severity,
          justification: f.body || 'unresolved at cycle exhaustion',
        })
      }
      if (!det.passed)
        debtNotes.push({
          criterion: 'deterministic gate',
          severity: 'crash',
          justification: structuredError.what,
        })
    }
  }

  const attempt: VerificationAttempt = {
    attempt: attemptNumber,
    at: Date.now(),
    deterministic: det,
    critic,
    status,
    structuredError,
  }
  const result: VerificationResult = {
    status,
    attempts: [...priorAttempts, attempt],
    debtNotes,
    updatedAt: Date.now(),
  }
  setTaskVerification(db, taskId, result)
  appendAudit(db, {
    eventType: 'verification',
    taskId,
    teamId: task?.teamId ?? null,
    summary: {
      status,
      attempt: attemptNumber,
      command: det.command,
      detPassed: det.passed,
      criticRan: critic.ran,
      criticFindings: critic.findings.length,
      blocking: blockingFindings(critic).length,
    },
  })
  // Drop a one-line note on the task so the failure/debt is visible in the chat timeline.
  if (status === 'fail' && structuredError) {
    addComment(
      db,
      taskId,
      `Verification failed (attempt ${attemptNumber}).\nWhat: ${structuredError.what}\nWhy: ${structuredError.why}\nHow to fix: ${structuredError.howToFix}`,
      'system',
    )
  } else if (status === 'completed_with_debt') {
    addComment(
      db,
      taskId,
      `Completed with debt after ${attemptNumber} verification cycle(s); ${debtNotes.length} open item(s) recorded.`,
      'system',
    )
  }
  return result
}
