import { describe, it, expect } from 'vitest'
import { findPlanBlocks, stripPlanBlocks } from '../planDetector'

describe('findPlanBlocks — Round 8B parser', () => {
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
    // Verify the offsets actually point at the `<step` opener in the source.
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
    // Only the first step is valid; empty target + empty task are skipped.
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
    const text = `<plan><step to="@A">phase 1</step></plan>
Some prose between plans.
<plan><step to="@B">phase 2</step></plan>`
    const blocks = findPlanBlocks(text)
    expect(blocks).toHaveLength(2)
    expect(blocks[0]!.steps[0]!.task).toBe('phase 1')
    expect(blocks[1]!.steps[0]!.task).toBe('phase 2')
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
})

describe('stripPlanBlocks — Round 8B utility', () => {
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

  it('is a no-op when no plan is present', () => {
    expect(stripPlanBlocks('just prose')).toBe('just prose')
  })
})
