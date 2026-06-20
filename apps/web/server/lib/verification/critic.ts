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

import type { RuntimeRunContext } from '../runtimes'

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
    const run = await adapter.start(
      { taskId: null, teamId: null },
      {
        agentId: 'critic',
        sessionKey: `review:${input.reviewSha.slice(0, 12)}`,
        message: 'Review the changes at this checkout.',
        model: input.reviewerModel ?? null,
        context: REVIEW_PROMPT,
      },
    )

    // Drain the reviewer's stream to text, then parse a typed verdict with a
    // way-out via the shared judge drive (@clawboo/obs) — the same extract +
    // parse the eval model-grader uses. empty ⇒ no findings (pass); valid JSON ⇒
    // findings; anything else ⇒ a single non-blocking soft-warn finding.
    const drain = async (): Promise<string> => {
      let text = ''
      for await (const ev of adapter.events(run)) {
        if (ev.kind === 'text-delta') {
          if (ev.channel !== 'reasoning') text += ev.text
        } else if (ev.kind === 'done') {
          if (ev.summary && ev.summary.length > text.length) text = ev.summary
          break
        } else if (ev.kind === 'error') {
          break
        }
      }
      return text
    }

    const judged = await driveStructuredJudge({ runText: drain, schema: criticOutputSchema })
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
    await removeReviewWorktree(input.repoPath, review).catch(() => {})
  }
}
