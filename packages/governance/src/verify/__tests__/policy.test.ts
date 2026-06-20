import { describe, expect, it } from 'vitest'

import {
  classifySeverity,
  isBlocking,
  isVerdictPromotable,
  nextCycleDecision,
  verificationStatusFor,
  type CriticVerdict,
  type DeterministicResult,
  type Severity,
  type VerificationResult,
} from '../index'

const det = (passed: boolean): DeterministicResult => ({
  command: 'pnpm test',
  exitCode: passed ? 0 : 1,
  passed,
  stdoutTail: '',
  stderrTail: '',
  durationMs: 10,
  timedOut: false,
})

const critic = (over: Partial<CriticVerdict>): CriticVerdict => ({
  ran: true,
  findings: [],
  reviewerRuntime: 'openclaw',
  reviewerModel: null,
  reviewedSha: 'abc',
  ...over,
})

const verdict = (status: VerificationResult['status'], detPassed: boolean): VerificationResult => ({
  status,
  attempts: [
    {
      attempt: 1,
      at: 0,
      deterministic: det(detPassed),
      critic: critic({}),
      status: status === 'completed_with_debt' ? 'completed_with_debt' : status,
      structuredError: null,
    },
  ],
  debtNotes: [],
  updatedAt: 0,
})

describe('isVerdictPromotable', () => {
  it('pass is promotable', () => {
    expect(isVerdictPromotable(verdict('pass', true))).toBe(true)
  })
  it('fail is never promotable', () => {
    expect(isVerdictPromotable(verdict('fail', false))).toBe(false)
  })
  it('completed_with_debt over a GREEN deterministic gate is promotable', () => {
    expect(isVerdictPromotable(verdict('completed_with_debt', true))).toBe(true)
  })
  it('completed_with_debt over a RED deterministic gate is NOT promotable', () => {
    expect(isVerdictPromotable(verdict('completed_with_debt', false))).toBe(false)
  })
  it('null / missing fields default to NOT promotable', () => {
    expect(isVerdictPromotable(null)).toBe(false)
    expect(isVerdictPromotable({ status: 'completed_with_debt' })).toBe(false)
    expect(isVerdictPromotable({})).toBe(false)
  })
})

describe('classifySeverity', () => {
  it('blocks only security/crash/data_loss/wrong_algorithm/missing_ac', () => {
    const blocking: Severity[] = ['security', 'crash', 'data_loss', 'wrong_algorithm', 'missing_ac']
    const warning: Severity[] = ['style', 'perf', 'other']
    for (const s of blocking)
      expect(
        classifySeverity({
          severity: s,
          title: 't',
          body: '',
          filePath: null,
          startLine: null,
          confidence: 1,
        }),
      ).toBe('block')
    for (const s of warning)
      expect(
        classifySeverity({
          severity: s,
          title: 't',
          body: '',
          filePath: null,
          startLine: null,
          confidence: 1,
        }),
      ).toBe('warn')
  })
})

describe('isBlocking', () => {
  it('true when any blocking finding present', () => {
    expect(
      isBlocking(
        critic({
          findings: [
            {
              severity: 'security',
              title: 'leak',
              body: '',
              filePath: null,
              startLine: null,
              confidence: 0.9,
            },
          ],
        }),
      ),
    ).toBe(true)
  })
  it('false for only non-blocking findings or no findings', () => {
    expect(
      isBlocking(
        critic({
          findings: [
            {
              severity: 'style',
              title: 'nit',
              body: '',
              filePath: null,
              startLine: null,
              confidence: 0.5,
            },
          ],
        }),
      ),
    ).toBe(false)
    expect(isBlocking(critic({ ran: false, findings: [] }))).toBe(false)
  })
})

describe('verificationStatusFor', () => {
  it('red deterministic gate is always fail', () => {
    expect(verificationStatusFor(det(false), critic({ ran: false }))).toBe('fail')
  })
  it('green gate + blocking critic finding is fail', () => {
    expect(
      verificationStatusFor(
        det(true),
        critic({
          findings: [
            {
              severity: 'crash',
              title: 'npe',
              body: '',
              filePath: null,
              startLine: null,
              confidence: 0.8,
            },
          ],
        }),
      ),
    ).toBe('fail')
  })
  it('green gate + only non-blocking findings is pass', () => {
    expect(
      verificationStatusFor(
        det(true),
        critic({
          findings: [
            {
              severity: 'perf',
              title: 'slow',
              body: '',
              filePath: null,
              startLine: null,
              confidence: 0.3,
            },
          ],
        }),
      ),
    ).toBe('pass')
  })
  it('green gate + critic not run is pass', () => {
    expect(verificationStatusFor(det(true), critic({ ran: false }))).toBe('pass')
  })
})

describe('nextCycleDecision', () => {
  it('retries under the cap and marks debt at/after exhaustion', () => {
    expect(nextCycleDecision({ attempt: 1, maxCycles: 3 })).toBe('retry')
    expect(nextCycleDecision({ attempt: 2, maxCycles: 3 })).toBe('retry')
    expect(nextCycleDecision({ attempt: 3, maxCycles: 3 })).toBe('mark_debt')
    expect(nextCycleDecision({ attempt: 9, maxCycles: 3 })).toBe('mark_debt')
  })
})
