import { describe, it, expect } from 'vitest'

import {
  findDelegationBlocks,
  parseStructuredDelegations,
  stripDelegationBlocks,
  findPlanBlocks,
  stripPlanBlocks,
  resolveSessionsSendTarget,
  detectDelegationIntent,
} from '../delegationTags'

const agents = [
  { id: 'a1', name: 'Code Reviewer Boo' },
  { id: 'a2', name: 'SEO Analyst Boo' },
  { id: 'a3', name: 'Bug Fixer Boo' },
  { id: 'a4', name: 'Bug Fixer' },
  { id: 'a5', name: 'Doc Writer Boo' },
]

// ─── Structured `<delegate>` protocol ────────────────────────────────────────

describe('findDelegationBlocks — raw block extractor', () => {
  it('finds a single delegation block with offsets', () => {
    const text = 'Hello\n<delegate to="@Bug Fixer Boo">fix the parser</delegate>\nthanks'
    const blocks = findDelegationBlocks(text)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.targetName).toBe('@Bug Fixer Boo')
    expect(blocks[0]!.task).toBe('fix the parser')
    expect(text.slice(blocks[0]!.blockStart, blocks[0]!.blockEnd)).toBe(
      '<delegate to="@Bug Fixer Boo">fix the parser</delegate>',
    )
  })

  it('finds multiple delegation blocks in source order', () => {
    const text = '<delegate to="@A">first</delegate> middle <delegate to="@B">second</delegate>'
    const blocks = findDelegationBlocks(text)
    expect(blocks).toHaveLength(2)
    expect(blocks[0]!.targetName).toBe('@A')
    expect(blocks[1]!.targetName).toBe('@B')
    expect(blocks[0]!.blockStart).toBeLessThan(blocks[1]!.blockStart)
  })

  it('handles multi-line task bodies (newlines in task)', () => {
    const text = `<delegate to="@Bug Fixer Boo">
Investigate the null pointer in auth.ts:42.
Check JWT signing for null safety.
</delegate>`
    const blocks = findDelegationBlocks(text)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.task).toContain('Investigate the null pointer')
    expect(blocks[0]!.task).toContain('Check JWT signing')
  })

  it('returns empty array when no delegation tags are present', () => {
    expect(findDelegationBlocks('plain text with @Bug Fixer Boo mentioned')).toEqual([])
  })

  it('is case-insensitive for the delegate tag itself', () => {
    const text = '<DELEGATE to="@A">x</DELEGATE> <Delegate to="@B">y</Delegate>'
    expect(findDelegationBlocks(text)).toHaveLength(2)
  })

  it('recovers a delegation whose opening "<" was dropped (weak-model drift)', () => {
    const text = 'delegate to="@Bug Fixer Boo">fix the parser</delegate>'
    const blocks = findDelegationBlocks(text)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.targetName).toBe('@Bug Fixer Boo')
    expect(blocks[0]!.task).toBe('fix the parser')
  })

  it('recovers a delegation whose entire opening "<delegate" was dropped', () => {
    const text = 'to="@Bug Fixer Boo">fix the parser</delegate>'
    const blocks = findDelegationBlocks(text)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.targetName).toBe('@Bug Fixer Boo')
    expect(blocks[0]!.task).toBe('fix the parser')
    // The whole malformed block is stripped — no fragment leaks into prose.
    expect(stripDelegationBlocks('lead-in ' + text + ' tail')).toBe('lead-in  tail'.trim())
  })
})

describe('parseStructuredDelegations', () => {
  it('parses a single structured delegation with @ prefix', () => {
    const text = '<delegate to="@Bug Fixer Boo">fix the parser bug</delegate>'
    const result = parseStructuredDelegations(text, 'src', agents)
    expect(result).toHaveLength(1)
    expect(result[0]!.targetAgentId).toBe('a3')
    expect(result[0]!.taskDescription).toBe('fix the parser bug')
  })

  it('tolerates `to="Name"` without the leading @', () => {
    const text = '<delegate to="Bug Fixer Boo">fix the parser bug</delegate>'
    const result = parseStructuredDelegations(text, 'src', agents)
    expect(result).toHaveLength(1)
    expect(result[0]!.targetAgentId).toBe('a3')
  })

  it('derives an intent from a delegation missing its opening "<" (weak-model drift)', () => {
    const text = 'delegate to="@Bug Fixer Boo">fix the parser bug</delegate>'
    const result = parseStructuredDelegations(text, 'src', agents)
    expect(result).toHaveLength(1)
    expect(result[0]!.targetAgentId).toBe('a3')
    expect(result[0]!.taskDescription).toBe('fix the parser bug')
  })

  it('parses multiple structured delegations in one message', () => {
    const text = `I'll coordinate the team:
<delegate to="@Bug Fixer Boo">fix the auth bug</delegate>
<delegate to="@SEO Analyst Boo">audit the keywords</delegate>
<delegate to="@Doc Writer Boo">update the README</delegate>`
    const result = parseStructuredDelegations(text, 'src', agents)
    expect(result.map((d) => d.targetAgentId).sort()).toEqual(['a2', 'a3', 'a5'])
    expect(result.find((d) => d.targetAgentId === 'a3')?.taskDescription).toBe('fix the auth bug')
  })

  it('preserves multi-line task bodies', () => {
    const text = `<delegate to="@Bug Fixer Boo">
Investigate the null pointer in auth.ts:42.
Check JWT signing for null safety.
</delegate>`
    const result = parseStructuredDelegations(text, 'src', agents)
    expect(result).toHaveLength(1)
    expect(result[0]!.taskDescription).toContain('Investigate the null pointer')
    expect(result[0]!.taskDescription).toContain('Check JWT signing')
  })

  it('filters out self-delegation', () => {
    const text = '<delegate to="@Bug Fixer Boo">do the thing</delegate>'
    expect(parseStructuredDelegations(text, 'a3', agents)).toEqual([])
  })

  it('filters out unknown agents', () => {
    const text = '<delegate to="@Nonexistent Agent">do the thing</delegate>'
    expect(parseStructuredDelegations(text, 'src', agents)).toEqual([])
  })

  it('filters out empty task bodies', () => {
    const text = '<delegate to="@Bug Fixer Boo"></delegate>'
    expect(parseStructuredDelegations(text, 'src', agents)).toEqual([])
  })

  it('returns empty array when there are no delegate tags', () => {
    expect(parseStructuredDelegations('plain prose only', 'src', agents)).toEqual([])
  })
})

describe('parseStructuredDelegations — quote tolerance', () => {
  it('accepts single-quoted to=', () => {
    const out = parseStructuredDelegations(
      `<delegate to='@SEO Analyst Boo'>do it</delegate>`,
      'src',
      agents,
    )
    expect(out).toHaveLength(1)
    expect(out[0]!.targetAgentId).toBe('a2')
  })
  it('accepts curly/smart quotes around to=', () => {
    const out = parseStructuredDelegations(
      `<delegate to=“@SEO Analyst Boo”>do it</delegate>`,
      'src',
      agents,
    )
    expect(out).toHaveLength(1)
    expect(out[0]!.targetAgentId).toBe('a2')
  })
})

describe('detectDelegationIntent', () => {
  it('flags a malformed/unclosed delegate attempt', () => {
    expect(
      detectDelegationIntent('On it. <delegate to="@SEO Analyst Boo">do the thing (never closed'),
    ).toBe(true)
    expect(detectDelegationIntent('plan>\n<step to="@X">a</step>')).toBe(true)
    expect(detectDelegationIntent('delegate to= @SEO')).toBe(true)
  })
  it('does NOT flag prose that merely mentions delegation', () => {
    expect(detectDelegationIntent("I'll delegate this to the team later.")).toBe(false)
    expect(detectDelegationIntent('Here is the combined synthesis of all results.')).toBe(false)
  })
})

describe('stripDelegationBlocks', () => {
  it('removes a single block from prose', () => {
    const text = `I'll coordinate.

<delegate to="@A">do x</delegate>`
    expect(stripDelegationBlocks(text)).toBe("I'll coordinate.")
  })

  it('removes multiple blocks while preserving prose between them', () => {
    const text = `Plan:
<delegate to="@A">first</delegate>
mid prose
<delegate to="@B">second</delegate>
end prose`
    const result = stripDelegationBlocks(text)
    expect(result).not.toContain('<delegate')
    expect(result).toContain('Plan:')
    expect(result).toContain('mid prose')
    expect(result).toContain('end prose')
  })

  it('returns the input untouched when no blocks present', () => {
    expect(stripDelegationBlocks('plain text')).toBe('plain text')
  })
})

// ─── Structured `<plan>` protocol ─────────────────────────────────────────────

describe('findPlanBlocks — plan/step parser', () => {
  it('parses a single plan with three steps', () => {
    const text = `Let's build this.
<plan>
  <step to="@Marketing Content Creator Boo">Write the copy first.</step>
  <step to="@Design Ui Designer Boo">Create the visual design from the copy.</step>
  <step to="@Engineering Frontend Developer Boo">Build the page from the design.</step>
</plan>
The team is on it.`
    const blocks = findPlanBlocks(text)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.steps).toHaveLength(3)
    expect(blocks[0]!.steps[0]!.targetName).toBe('@Marketing Content Creator Boo')
    expect(blocks[0]!.steps[0]!.task).toBe('Write the copy first.')
    expect(blocks[0]!.steps[1]!.targetName).toBe('@Design Ui Designer Boo')
    expect(blocks[0]!.steps[2]!.targetName).toBe('@Engineering Frontend Developer Boo')
  })

  it('returns absolute character offsets for each step in the original text', () => {
    const text = `<plan><step to="@A">first</step><step to="@B">second</step></plan>`
    const blocks = findPlanBlocks(text)
    expect(blocks).toHaveLength(1)
    const [step1, step2] = blocks[0]!.steps
    expect(step1).toBeDefined()
    expect(step2).toBeDefined()
    expect(step1!.stepStart).toBeLessThan(step2!.stepStart)
    expect(text.slice(step1!.stepStart, step1!.stepEnd)).toContain('<step to="@A">first</step>')
    expect(text.slice(step2!.stepStart, step2!.stepEnd)).toContain('<step to="@B">second</step>')
  })

  it('skips steps with missing target or empty task', () => {
    const text = `<plan>
  <step to="@A">valid task</step>
  <step to="">empty target ignored</step>
  <step to="@B"></step>
</plan>`
    const blocks = findPlanBlocks(text)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.steps).toHaveLength(1)
    expect(blocks[0]!.steps[0]!.targetName).toBe('@A')
  })

  it('handles multi-line task bodies', () => {
    const text = `<plan>
  <step to="@Engineer Boo">
    Build the auth flow:
    - JWT validation
    - Session handling
  </step>
</plan>`
    const blocks = findPlanBlocks(text)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.steps).toHaveLength(1)
    expect(blocks[0]!.steps[0]!.task).toContain('Build the auth flow:')
    expect(blocks[0]!.steps[0]!.task).toContain('JWT validation')
  })

  it('parses multiple plans in one response (rare but legal)', () => {
    const text = `<plan><step to="@A">stage one</step></plan>
Some prose between plans.
<plan><step to="@B">stage two</step></plan>`
    const blocks = findPlanBlocks(text)
    expect(blocks).toHaveLength(2)
    expect(blocks[0]!.steps[0]!.task).toBe('stage one')
    expect(blocks[1]!.steps[0]!.task).toBe('stage two')
  })

  it('returns an empty steps array for `<plan></plan>` so caller can decide', () => {
    const text = `<plan></plan>`
    const blocks = findPlanBlocks(text)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.steps).toEqual([])
  })

  it('returns empty when no plan tags present', () => {
    expect(findPlanBlocks('just prose, no plan here')).toEqual([])
    expect(findPlanBlocks('<delegate to="@X">not a plan</delegate>')).toEqual([])
  })

  it('is case-insensitive on the tag names', () => {
    const text = `<PLAN><STEP to="@A">task</STEP></PLAN>`
    const blocks = findPlanBlocks(text)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.steps).toHaveLength(1)
    expect(blocks[0]!.steps[0]!.task).toBe('task')
  })

  it('recovers a plan + steps with dropped opening "<" (weak-model drift)', () => {
    const text = 'plan><step to="@A">step one</step>to="@B">step two</step></plan>'
    const blocks = findPlanBlocks(text)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.steps).toHaveLength(2)
    expect(blocks[0]!.steps[0]!.targetName).toBe('@A')
    expect(blocks[0]!.steps[0]!.task).toBe('step one')
    expect(blocks[0]!.steps[1]!.targetName).toBe('@B')
    expect(blocks[0]!.steps[1]!.task).toBe('step two')
  })
})

describe('stripPlanBlocks', () => {
  it('removes the plan block from text, leaving surrounding prose', () => {
    const text = `intro
<plan>
  <step to="@A">task</step>
</plan>
outro`
    const stripped = stripPlanBlocks(text)
    expect(stripped).not.toContain('<plan>')
    expect(stripped).not.toContain('<step')
    expect(stripped).toContain('intro')
    expect(stripped).toContain('outro')
  })

  it('returns trimmed text when only a plan was present', () => {
    expect(stripPlanBlocks('<plan><step to="@A">task</step></plan>')).toBe('')
  })

  it('strips a plan whose opening "<" was dropped, leaving clean prose', () => {
    const stripped = stripPlanBlocks('intro plan><step to="@A">task</step></plan> outro')
    expect(stripped).not.toContain('plan>')
    expect(stripped).not.toContain('</plan>')
    expect(stripped).not.toContain('step')
    expect(stripped).toContain('intro')
    expect(stripped).toContain('outro')
  })

  it('is a no-op when no plan is present', () => {
    expect(stripPlanBlocks('just prose')).toBe('just prose')
  })
})

// ─── sessions_send target resolution ─────────────────────────────────────────

describe('resolveSessionsSendTarget', () => {
  const roster = [
    { id: 'a2', name: 'SEO Analyst Boo' },
    { id: 'a3', name: 'Bug Fixer Boo' },
  ]

  it('resolves by sessionKey (agent:<id>:<session>)', () => {
    expect(
      resolveSessionsSendTarget({ sessionKey: 'agent:a3:main', message: 'x' }, roster),
    ).toEqual({ id: 'a3', name: 'Bug Fixer Boo' })
  })

  it('resolves by direct agentId', () => {
    expect(resolveSessionsSendTarget({ agentId: 'a2', message: 'x' }, roster)).toEqual({
      id: 'a2',
      name: 'SEO Analyst Boo',
    })
  })

  it('resolves by label (case-insensitive, optional @, longest-prefix)', () => {
    expect(resolveSessionsSendTarget({ label: '@bug fixer boo', message: 'x' }, roster)).toEqual({
      id: 'a3',
      name: 'Bug Fixer Boo',
    })
  })

  it('returns null when no identifier resolves', () => {
    expect(resolveSessionsSendTarget({ label: 'Nobody', message: 'x' }, roster)).toBeNull()
  })
})
