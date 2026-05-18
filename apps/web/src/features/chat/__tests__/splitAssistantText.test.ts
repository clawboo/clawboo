import { describe, it, expect } from 'vitest'
import { splitAssistantText } from '../splitAssistantText'

describe('splitAssistantText', () => {
  it('returns a single prose segment when no delegation blocks are present', () => {
    const result = splitAssistantText("Hi! Here's an update on the sprint.")
    expect(result).toEqual([{ kind: 'prose', text: "Hi! Here's an update on the sprint." }])
  })

  it('returns empty array for empty / whitespace-only input', () => {
    expect(splitAssistantText('')).toEqual([])
    expect(splitAssistantText('   \n\t  ')).toEqual([])
  })

  it('returns a single delegation segment when text is just a delegate block', () => {
    const result = splitAssistantText('<delegate to="@Bug Fixer Boo">fix the parser</delegate>')
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      kind: 'delegation',
      targetName: 'Bug Fixer Boo',
      task: 'fix the parser',
    })
    // blockStart/blockEnd carried through from findDelegationBlocks
    const seg = result[0] as { blockStart: number; blockEnd: number }
    expect(seg.blockStart).toBe(0)
    expect(seg.blockEnd).toBeGreaterThan(0)
  })

  it('preserves order: prose, delegation, prose', () => {
    const text = `Here's the plan.

<delegate to="@Bug Fixer Boo">fix the parser</delegate>

Let me know what you find.`
    const result = splitAssistantText(text)
    expect(result).toHaveLength(3)
    expect(result[0]).toMatchObject({ kind: 'prose' })
    expect((result[0] as { text: string }).text).toContain("Here's the plan")
    expect(result[1]).toMatchObject({
      kind: 'delegation',
      targetName: 'Bug Fixer Boo',
      task: 'fix the parser',
    })
    expect(result[2]).toMatchObject({ kind: 'prose' })
    expect((result[2] as { text: string }).text).toContain('Let me know what you find')
  })

  it('handles multiple delegation blocks interleaved with prose', () => {
    const text = `Plan:

<delegate to="@Bug Fixer Boo">fix the auth bug</delegate>

While that's in flight,

<delegate to="@SEO Analyst Boo">audit the keywords</delegate>

Wrap up by EOD.`
    const result = splitAssistantText(text)
    // prose, delegation, prose, delegation, prose = 5 segments
    expect(result).toHaveLength(5)
    expect(result.map((s) => s.kind)).toEqual([
      'prose',
      'delegation',
      'prose',
      'delegation',
      'prose',
    ])
    const targets = result
      .filter((s): s is Extract<typeof s, { kind: 'delegation' }> => s.kind === 'delegation')
      .map((s) => s.targetName)
    expect(targets).toEqual(['Bug Fixer Boo', 'SEO Analyst Boo'])
  })

  it('drops empty prose between consecutive delegation blocks', () => {
    // Back-to-back blocks with only whitespace between them shouldn't emit
    // an empty prose segment.
    const text = `<delegate to="@A">first</delegate>
<delegate to="@B">second</delegate>`
    const result = splitAssistantText(text)
    expect(result).toHaveLength(2)
    expect(result.map((s) => s.kind)).toEqual(['delegation', 'delegation'])
  })

  it('preserves multi-line task bodies in the delegation segment', () => {
    const text = `<delegate to="@Bug Fixer Boo">
Investigate the null pointer in auth.ts:42.
Check JWT signing for null safety.
</delegate>`
    const result = splitAssistantText(text)
    expect(result).toHaveLength(1)
    const seg = result[0] as { kind: 'delegation'; task: string }
    expect(seg.kind).toBe('delegation')
    expect(seg.task).toContain('Investigate the null pointer')
    expect(seg.task).toContain('Check JWT signing')
  })

  it('strips leading @ from the targetName for clean rendering', () => {
    // Card UI prepends `@` itself, so the segment should NOT include it.
    const text = '<delegate to="@Bug Fixer Boo">fix the parser</delegate>'
    const result = splitAssistantText(text)
    expect((result[0] as { targetName: string }).targetName).toBe('Bug Fixer Boo')
  })

  it('also accepts to="Name" without the leading @', () => {
    const text = '<delegate to="Bug Fixer Boo">fix the parser</delegate>'
    const result = splitAssistantText(text)
    expect((result[0] as { targetName: string }).targetName).toBe('Bug Fixer Boo')
  })

  it('preserves distinct blockStart offsets for multiple delegations in same text', () => {
    const text = `Plan:
<delegate to="@A">first</delegate>
mid prose
<delegate to="@B">second</delegate>`
    const result = splitAssistantText(text)
    const dels = result.filter(
      (s): s is Extract<typeof s, { kind: 'delegation' }> => s.kind === 'delegation',
    )
    expect(dels).toHaveLength(2)
    expect(dels[0]!.blockStart).toBeLessThan(dels[1]!.blockStart)
    expect(dels[0]!.blockEnd).toBeLessThan(dels[1]!.blockStart)
    // The blockStart for each delegation matches the actual character index
    // of '<delegate' in the source text.
    expect(text.slice(dels[0]!.blockStart, dels[0]!.blockStart + 9)).toBe('<delegate')
    expect(text.slice(dels[1]!.blockStart, dels[1]!.blockStart + 9)).toBe('<delegate')
  })
})
