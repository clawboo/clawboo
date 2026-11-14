// The read-only critic (builder ≠ judge). On a risky/large diff it provisions a
// DETACHED review worktree at the work's commit (no branch ⇒ the reviewer cannot
// push — a structural read-only guarantee), drives an independent reviewer adapter
// with a structured-output instruction, and parses a TYPED verdict. A malformed or
// failed critic is a soft warn (a single non-blocking `other` finding), never a
// crash — the deterministic gate is the hard gate.
//
// Every verdict that ran records its `outcome`, so a crashed, silent or
// unreadable review is never shown as a clean one.

import {
  criticOutputSchema,
  shouldRunCritic,
  type CriticOutcome,
  type CriticVerdict,
  type DiffStat,
  type Finding,
} from '@clawboo/governance'
import type { RuntimeAdapter } from '@clawboo/executor'
import { driveStructuredJudge } from '@clawboo/obs'
import { isCommitId, provisionReviewWorktree, removeReviewWorktree } from '@clawboo/worktrees'

import { isAgentUserMode } from '../agentUser/config'
import { installAgentWorktreeIo, isInAgentSpace } from '../agentUser/worktreeIo'
import { isLocalModel } from '../costUtils'
import type { RuntimeRunContext } from '../runtimes'
import { estimateRunCostUsdFromUsage } from '../runtimes/estimateCost'

const REVIEW_PROMPT = [
  'You are an INDEPENDENT code reviewer (builder ≠ judge). Review ONLY the changes at this checkout.',
  'Output ONLY a single JSON object, no prose, of the form:',
  '{"findings":[{"severity":"...","title":"...","body":"...","filePath":"...","startLine":123,"confidence":0.0}]}',
  'severity ∈ security | crash | data_loss | wrong_algorithm | missing_ac | style | perf | other.',
  'Report only real defects. An empty findings array is a valid, good result.',
].join('\n')

const NOT_RUN: CriticVerdict = {
  ran: false,
  findings: [],
  reviewerRuntime: null,
  reviewerModel: null,
  reviewedSha: null,
}

export interface CriticInput {
  /** The repository the review checkout is made from: with agents on their own
   *  OS user, the agent's mirror, where the commit to review is. */
  repoPath: string
  /** The committed SHA to review (a detached read-only checkout is made at it). */
  reviewSha: string
  diffStat: DiffStat
  hasParent: boolean
  makeReviewerAdapter: (ctx: RuntimeRunContext) => RuntimeAdapter
  reviewerModel?: string | null
  mcpBaseUrl?: string | null
  riskFlag?: boolean
  /** Where the detached review worktree is checked out (OUTSIDE the user repo). */
  reviewRootDir: string
  /** Told what the reviewer's run cost once it has run, so the caller can charge it. */
  onSpend?: (spend: ReviewerSpend) => void
  /** True while a pause covers the task: the reviewer does not start. */
  paused?: () => boolean
  /** Asked last before the reviewer starts: a budget's say, and a run slot where the
   *  caller is not already in one. */
  gate?: ReviewerGate
}

/** Why a reviewer may not run, in a person's words, or what to give back when it ends. */
export type ReviewerGate = () =>
  | { refused: string }
  | { release: () => void }
  | Promise<{ refused: string } | { release: () => void }>

/** What a reviewer run cost, as its runtime reported it. */
export interface ReviewerSpend {
  runtime: string
  model: string | null
  /** Reported (or priced from reported token usage) USD; null when the run
   *  reported nothing, so the caller prices it like any other unreported run. */
  usd: number | null
  inputTokens: number
  outputTokens: number
  /** The prompt and reply lengths, for pricing a run that reported nothing. */
  inputChars: number
  outputChars: number
  sessionKey: string
}

const unparseable = (text: string): Finding[] => [
  {
    severity: 'other',
    title: 'critic output unparseable',
    body: text.slice(0, 500),
    filePath: null,
    startLine: null,
    confidence: 0,
  },
]

/** The verdict of a review that should have happened and did not complete. Its
 *  one finding is non-blocking, so the gate still decides. */
export function criticErrored(input: {
  why: string
  reviewerRuntime?: string | null
  reviewerModel?: string | null
  reviewedSha?: string | null
}): CriticVerdict {
  return {
    ran: true,
    outcome: 'errored',
    findings: [
      {
        severity: 'other',
        title: 'review did not complete',
        body: input.why.slice(0, 500),
        filePath: null,
        startLine: null,
        confidence: 0,
      },
    ],
    reviewerRuntime: input.reviewerRuntime ?? null,
    reviewerModel: input.reviewerModel ?? null,
    reviewedSha: input.reviewedSha ?? null,
  }
}

export async function runCritic(input: CriticInput): Promise<CriticVerdict> {
  if (
    !shouldRunCritic({
      diffStat: input.diffStat,
      hasParent: input.hasParent,
      riskFlag: input.riskFlag,
    })
  ) {
    return NOT_RUN
  }

  const errored = (reviewerRuntime: string | null, why: string): CriticVerdict =>
    criticErrored({
      why,
      reviewerRuntime,
      reviewerModel: input.reviewerModel ?? null,
      reviewedSha: input.reviewSha,
    })

  // The commit to review was read from git in a checkout an agent controls, and
  // goes back to git as an argument: nothing but a commit id will do.
  if (!isCommitId(input.reviewSha)) {
    return errored(null, `The commit to review is not a commit id: ${input.reviewSha.slice(0, 80)}`)
  }
  // With agents on their own OS user the review checkout is the agent user's,
  // made from the agent's mirror by the agent host. A repository outside the
  // work folder is the server's, and git there must not make a checkout an
  // agent can write.
  if (isAgentUserMode()) {
    installAgentWorktreeIo()
    if (!isInAgentSpace(input.repoPath)) {
      return errored(
        null,
        `A review checkout is made only from the agents' copy of a repository while agents run as a separate user, and ${input.repoPath} is not one.`,
      )
    }
  }
  let review: Awaited<ReturnType<typeof provisionReviewWorktree>>
  try {
    review = await provisionReviewWorktree({
      repoPath: input.repoPath,
      sha: input.reviewSha,
      rootDir: input.reviewRootDir,
    })
  } catch (err) {
    return errored(null, err instanceof Error ? err.message : String(err))
  }
  let reviewerRuntime: string | null = null
  let leaveGate: (() => void) | null = null
  try {
    const ctx: RuntimeRunContext = {
      cwd: review.worktreePath,
      model: input.reviewerModel ?? null,
      mcpBaseUrl: input.mcpBaseUrl ?? null,
    }
    // A reviewer is a paid run, and nothing starts under a pause. The gate before it
    // may have run for a long time, so this is read as late as it can be.
    if (input.paused?.()) {
      return errored(null, 'This task is paused, so the reviewer did not run.')
    }
    const admitted = await input.gate?.()
    if (admitted && 'refused' in admitted) return errored(null, admitted.refused)
    leaveGate = admitted?.release ?? null
    const adapter = input.makeReviewerAdapter(ctx)
    const sessionKey = `review:${input.reviewSha.slice(0, 12)}`
    const message = 'Review the changes at this checkout.'
    reviewerRuntime = adapter.id
    const run = await adapter.start(
      { taskId: null, teamId: null },
      {
        agentId: 'critic',
        sessionKey,
        message,
        model: input.reviewerModel ?? null,
        context: REVIEW_PROMPT,
      },
    )
    // The reviewer is a paid run like any other, so its cost is counted the way
    // the task runner counts a pass: every `cost` event (a local model is free,
    // usage without a price is priced from the tokens), else the `done` total.
    let costUsd: number | null = null
    let doneCostUsd: number | null = null
    let inputTokens = 0
    let outputTokens = 0
    let model: string | null = input.reviewerModel ?? null
    let outputChars = 0

    // Drain the reviewer's stream to text, then parse a typed verdict with a
    // way-out via the shared judge drive (@clawboo/obs) — the same extract +
    // parse the eval model-grader uses. A non-fatal error (a tool call that
    // failed, a policy denial) is part of a working review, so only a fatal one
    // or a failed terminal ends the drain as a failure.
    let failure = null as string | null
    const drain = async (): Promise<string> => {
      let text = ''
      for await (const ev of adapter.events(run)) {
        if (ev.kind === 'text-delta') {
          if (ev.channel !== 'reasoning') text += ev.text
        } else if (ev.kind === 'cost') {
          // A cost event without a model ran on the model the review was started
          // with, so price it (and tell a free local model) by that one.
          const costModel = ev.model ?? input.reviewerModel ?? null
          const local = ev.local === true || (ev.costUsd == null && isLocalModel(costModel))
          const usd = local
            ? 0
            : ev.costUsd != null
              ? ev.costUsd
              : ev.usage
                ? estimateRunCostUsdFromUsage({
                    model: costModel,
                    inputTokens: ev.usage.inputTokens,
                    outputTokens: ev.usage.outputTokens,
                  })
                : 0
          costUsd = (costUsd ?? 0) + usd
          if (ev.model) model = ev.model
          if (ev.usage) {
            inputTokens += ev.usage.inputTokens
            outputTokens += ev.usage.outputTokens
          }
        } else if (ev.kind === 'done') {
          if (ev.summary && ev.summary.length > text.length) text = ev.summary
          if (ev.costUsd != null) doneCostUsd = ev.costUsd
          if (ev.usage && inputTokens + outputTokens === 0) {
            inputTokens = ev.usage.inputTokens
            outputTokens = ev.usage.outputTokens
          }
          if (ev.reason === 'error' || ev.reason === 'aborted')
            failure ??= `the reviewer run ended: ${ev.reason}`
          break
        } else if (ev.kind === 'error' && ev.fatal) {
          failure = ev.message || 'the reviewer run failed'
          break
        }
      }
      outputChars = text.length
      return text
    }

    const judged = await driveStructuredJudge({ runText: drain, schema: criticOutputSchema })
      // Reported whether or not the verdict parses: the run was paid for either way.
      // A failed charge must not turn into a failed review.
      .finally(() => {
        try {
          input.onSpend?.({
            runtime: adapter.id,
            model,
            usd: costUsd ?? doneCostUsd,
            inputTokens,
            outputTokens,
            inputChars: REVIEW_PROMPT.length + message.length,
            outputChars,
            sessionKey,
          })
        } catch {
          /* best effort */
        }
      })
    // A parsed verdict is the positive evidence a review needs, even from a run
    // that failed afterwards. Without one, a failure is the outcome.
    if (judged.status !== 'parsed' && failure) return errored(adapter.id, failure)
    const outcome: CriticOutcome =
      judged.status === 'parsed' ? 'reviewed' : judged.status === 'empty' ? 'empty' : 'errored'
    const findings =
      judged.status === 'parsed' && judged.value
        ? judged.value.findings
        : judged.status === 'empty'
          ? []
          : unparseable(judged.raw)
    return {
      ran: true,
      outcome,
      findings,
      reviewerRuntime: adapter.id,
      reviewerModel: input.reviewerModel ?? null,
      reviewedSha: input.reviewSha,
    }
  } catch (err) {
    return errored(reviewerRuntime, err instanceof Error ? err.message : String(err))
  } finally {
    leaveGate?.()
    await removeReviewWorktree(input.repoPath, review, input.reviewRootDir).catch(() => {})
  }
}
