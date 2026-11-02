// The read-only critic (builder ≠ judge). On a risky/large diff it provisions a
// DETACHED review worktree at the work's commit (no branch ⇒ the reviewer cannot
// push — a structural read-only guarantee), drives an independent reviewer adapter
// with a structured-output instruction, and parses a TYPED verdict. A malformed or
// failed critic is a soft warn (a single non-blocking `other` finding), never a
// crash — the deterministic gate is the hard gate.

import {
  criticOutputSchema,
  shouldRunCritic,
  type CriticVerdict,
  type DiffStat,
  type Finding,
} from '@clawboo/governance'
import type { RuntimeAdapter } from '@clawboo/executor'
import { driveStructuredJudge } from '@clawboo/obs'
import { provisionReviewWorktree, removeReviewWorktree } from '@clawboo/worktrees'

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
}

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

  const review = await provisionReviewWorktree({
    repoPath: input.repoPath,
    sha: input.reviewSha,
    rootDir: input.reviewRootDir,
  })
  try {
    const ctx: RuntimeRunContext = {
      cwd: review.worktreePath,
      model: input.reviewerModel ?? null,
      mcpBaseUrl: input.mcpBaseUrl ?? null,
    }
    const adapter = input.makeReviewerAdapter(ctx)
    const sessionKey = `review:${input.reviewSha.slice(0, 12)}`
    const message = 'Review the changes at this checkout.'
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
    // parse the eval model-grader uses. empty ⇒ no findings (pass); valid JSON ⇒
    // findings; anything else ⇒ a single non-blocking soft-warn finding.
    const drain = async (): Promise<string> => {
      let text = ''
      for await (const ev of adapter.events(run)) {
        if (ev.kind === 'text-delta') {
          if (ev.channel !== 'reasoning') text += ev.text
        } else if (ev.kind === 'cost') {
          const local = ev.local === true || (ev.costUsd == null && isLocalModel(ev.model))
          const usd = local
            ? 0
            : ev.costUsd != null
              ? ev.costUsd
              : ev.usage
                ? estimateRunCostUsdFromUsage({
                    model: ev.model,
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
          break
        } else if (ev.kind === 'error') {
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
    const findings =
      judged.status === 'parsed' && judged.value
        ? judged.value.findings
        : judged.status === 'empty'
          ? []
          : unparseable(judged.raw)
    return {
      ran: true,
      findings,
      reviewerRuntime: adapter.id,
      reviewerModel: input.reviewerModel ?? null,
      reviewedSha: input.reviewSha,
    }
  } finally {
    await removeReviewWorktree(input.repoPath, review, input.reviewRootDir).catch(() => {})
  }
}
