import { describe, it, expect } from 'vitest'

import {
  findDelegationBlocks,
  parseStructuredDelegations,
  stripDelegationBlocks,
  findPlanBlocks,
  stripPlanBlocks,
  resolveSessionsSendTarget,
  detectDelegationIntent,
  findActionableHandOffs,
  looksLikeBrokenHandOff,
  stripActionableHandOffs,
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

  it('returns null for a label of only spaces or `@`, which an empty prefix would match to anyone', () => {
    for (const label of ['   ', '@', ' @ '])
      expect(resolveSessionsSendTarget({ label, message: 'x' }, roster), label).toBeNull()
  })
})

describe('tag scanning holds up on hostile and mangled input', () => {
  it('still recovers each documented opener drift', () => {
    const variants = [
      '<delegate to="@Bug Fixer Boo">fix it</delegate>',
      'delegate to="@Bug Fixer Boo">fix it</delegate>',
      'to="@Bug Fixer Boo">fix it</delegate>',
      '< delegate  to="@Bug Fixer Boo">fix it</delegate>',
      "<delegate to='@Bug Fixer Boo'>fix it</delegate>",
      '<delegate to=“@Bug Fixer Boo”>fix it</delegate>',
    ]
    for (const text of variants) {
      const blocks = findDelegationBlocks(text)
      expect(blocks, text).toHaveLength(1)
      expect(blocks[0]!.task, text).toBe('fix it')
      expect(stripDelegationBlocks(text), text).toBe('')
    }
  })

  it('keeps prose around a block and reports usable offsets', () => {
    const text = 'before <delegate to="@Doc Writer Boo">write</delegate> after'
    const [block] = findDelegationBlocks(text)
    expect(text.slice(block!.blockStart, block!.blockEnd)).toBe(
      '<delegate to="@Doc Writer Boo">write</delegate>',
    )
    expect(stripDelegationBlocks(text)).toBe('before  after')
  })

  it('pairs each opener with its own closer across several blocks', () => {
    const text =
      '<delegate to="@Bug Fixer Boo">one</delegate> mid <delegate to="@Doc Writer Boo">two</delegate>'
    const blocks = findDelegationBlocks(text)
    expect(blocks.map((b) => b.task)).toEqual(['one', 'two'])
    expect(stripDelegationBlocks(text)).toBe('mid')
  })

  it('ignores an opener that never closes', () => {
    expect(findDelegationBlocks('<delegate to="@Bug Fixer Boo">dangling')).toHaveLength(0)
    expect(findPlanBlocks('<plan><step to="@Bug Fixer Boo">s</step>')).toHaveLength(0)
  })

  it('keeps plan step offsets pointing at the step source', () => {
    const text = 'x <plan>\n<step to="@Bug Fixer Boo">alpha</step>\n</plan>'
    const [plan] = findPlanBlocks(text)
    const step = plan!.steps[0]!
    expect(text.slice(step.stepStart, step.stepEnd)).toBe('<step to="@Bug Fixer Boo">alpha</step>')
    expect(text.slice(plan!.blockStart, plan!.blockEnd).startsWith('<plan>')).toBe(true)
  })

  it('stays linear on a burst of unclosed openers', () => {
    const delegates = '<delegate to="@Bug Fixer Boo">a'.repeat(20000)
    const plans = '<plan>a'.repeat(20000)
    const started = performance.now()
    expect(findDelegationBlocks(delegates)).toHaveLength(0)
    expect(stripDelegationBlocks(delegates)).toBe(delegates.trim())
    expect(findPlanBlocks(plans)).toHaveLength(0)
    expect(performance.now() - started).toBeLessThan(1000)
  })
})

// ─── What a reply means, and what it only shows ──────────────────────────────

describe('findActionableHandOffs: a tag starts work only where a reader sees a tag', () => {
  const tag = '<delegate to="@Growth/Coder">fix the parser</delegate>'
  const planTag = '<plan><step to="@Growth/Coder">one</step></plan>'

  it('an opener shown with no close does not take the real tag’s closer', () => {
    const found = findActionableHandOffs(
      `The syntax starts \`<delegate to="@Name">\`, like this: ${tag}`,
    )
    expect(found.delegates.map((b) => b.task)).toEqual(['fix the parser'])
    expect(found.shownDelegates).toEqual([])
    expect(
      looksLikeBrokenHandOff(`The syntax starts \`<delegate to="@Name">\`, like this: ${tag}`),
    ).toBe(false)
    // A whole tag shown first stays shown, and the real one still counts.
    const both = findActionableHandOffs(`\`${tag}\` is the form. ${tag}`)
    expect(both.delegates).toHaveLength(1)
    expect(both.shownDelegates).toHaveLength(1)
    // Code in a real brief is left in it, opener and all.
    const brief = findActionableHandOffs(
      '<delegate to="@Growth/Coder">explain `<delegate to="@X">` to them</delegate>',
    )
    expect(brief.delegates.map((b) => b.task)).toEqual(['explain `<delegate to="@X">` to them'])
  })

  it('a line straight after a quote’s words is still the quote', () => {
    for (const reply of [
      `> Here is what I would send:\n${tag}`,
      `> Here is what I would send:\nand then\n${tag}`,
    ]) {
      const found = findActionableHandOffs(reply)
      expect(found.delegates).toEqual([])
      expect(found.shownDelegates).toHaveLength(1)
    }
    // A blank line, or anything that ends a paragraph, ends it.
    for (const reply of [`> Your words.\n\n${tag}`, `> Your words.\n- ${tag}`, `>\n${tag}`]) {
      expect(findActionableHandOffs(reply).delegates, reply).toHaveLength(1)
    }
  })

  it('a tag partway through a quoted sentence is quoted', () => {
    for (const reply of [
      `She wrote: "please run ${tag} today" last week.`,
      `She wrote: “please run ${tag} today” last week.`,
      `She wrote: ‘please run ${tag} today’ last week.`,
    ]) {
      const found = findActionableHandOffs(reply)
      expect(found.delegates, reply).toEqual([])
      expect(found.shownDelegates, reply).toHaveLength(1)
    }
    // A quote that closed first, or quotes in the brief, are nothing of the kind.
    for (const reply of [
      `You said "soon". ${tag}`,
      `"Soon" it is: ${tag} and the "numbers" next.`,
      '<delegate to="@Growth/Coder">say "hi" to them</delegate>',
      `${tag} ${tag}`,
      `It's Growth's. ${tag} It's done.`,
    ]) {
      expect(findActionableHandOffs(reply).shownDelegates, reply).toEqual([])
    }
  })

  it('counts only quotes a reader sees as quotes', () => {
    // An inch mark opens nothing, and neither does the brief of a tag before it, its own
    // quote marks, or code.
    for (const reply of [
      `Use the 5" pipe: ${tag} Then say "done".`,
      `<delegate to="@Growth/Coder">tell them "hi</delegate> ${tag} then "ok".`,
      `Use \`"\` for strings, then ${tag} and "ok".`,
    ]) {
      const found = findActionableHandOffs(reply)
      expect(
        found.delegates.map((b) => b.task),
        reply,
      ).toContain('fix the parser')
      expect(found.shownDelegates, reply).toEqual([])
    }
    // Two tags inside one quoted sentence are both quoted.
    const both = findActionableHandOffs(`She wrote: "run ${tag} and ${tag}" last week.`)
    expect(both.delegates).toEqual([])
    expect(both.shownDelegates).toHaveLength(2)
  })

  it('an inch mark inside a quoted draft does not close it', () => {
    const found = findActionableHandOffs(`He wrote "cut the 5" pipe, then ${tag} next" and left.`)
    expect(found.delegates).toEqual([])
    expect(found.shownDelegates).toHaveLength(1)
  })

  it('a quote mark after a number is read both ways, and either reading can show a tag', () => {
    // `5"` may end "take 5", so the quote may be closed there, and the next mark may
    // open another quote around the tag. Showing it is the safe side.
    const take5 = findActionableHandOffs(`He said "take 5" and then "please ${tag} now" ok.`)
    expect(take5.delegates).toEqual([])
    expect(take5.shownDelegates).toHaveLength(1)
    // With no quote open before it, a mark after a number opens nothing.
    expect(findActionableHandOffs(`It is 5" long. ${tag}`).delegates).toHaveLength(1)
    expect(findActionableHandOffs(`The 5" and 6" pipes, ${tag} today.`).delegates).toHaveLength(1)
  })

  it('a curly apostrophe in a quoted brief is not its closing quote', () => {
    const reply = `She wrote ‘<delegate to="@Growth/Coder">It’s broken</delegate>’ yesterday.`
    const found = findActionableHandOffs(reply)
    expect(found.delegates).toEqual([])
    expect(found.shownDelegates).toHaveLength(1)
    expect(looksLikeBrokenHandOff(reply)).toBe(false)
  })

  it('an apostrophe inside curly quotes does not close them', () => {
    const found = findActionableHandOffs(`She said ‘It’s done, ${tag} now’ and left.`)
    expect(found.delegates).toEqual([])
    expect(found.shownDelegates).toHaveLength(1)
  })

  it('a hand-off whose own text runs over lines stays in its quoted sentence', () => {
    // The quote opens on the line where the tag starts and closes on the line where it
    // ends, which is the one-line rule the docs state.
    const multiLine = '<delegate to="@Growth/Coder">fix\nthe parser</delegate>'
    const found = findActionableHandOffs(`He wrote "please ${multiLine} soon" today.`)
    expect(found.delegates).toEqual([])
    expect(found.shownDelegates).toHaveLength(1)
    // A quote opened on an earlier line does not hold a tag.
    expect(findActionableHandOffs(`He wrote "please\n${tag} soon" today.`).delegates).toHaveLength(
      1,
    )
  })

  it('a quoted opener with no closer anywhere is a mention, not a hand-off that could not be read', () => {
    expect(looksLikeBrokenHandOff(`Don't write "<delegate to="@Name">" like that.`)).toBe(false)
    expect(looksLikeBrokenHandOff('Code: `<delegate to="@Name">` like that.')).toBe(false)
    expect(looksLikeBrokenHandOff('Then <delegate to="@Name"> fix it.')).toBe(true)
  })

  it('a quoted opener with no close of its own does not take the real tag’s closer', () => {
    for (const reply of [
      `Don't write "<delegate to="@Name">" like that. ${tag}`,
      `I'd say "use <delegate to="@Name"> for that", then ${tag}`,
      `Don't write “<delegate to="@Name">” like that. ${tag}`,
    ]) {
      const found = findActionableHandOffs(reply)
      expect(
        found.delegates.map((b) => [b.targetName, b.task]),
        reply,
      ).toEqual([['@Growth/Coder', 'fix the parser']])
      expect(found.shownDelegates, reply).toEqual([])
      // A quoted opener is only a mention, not a hand-off that could not be read.
      expect(looksLikeBrokenHandOff(reply), reply).toBe(false)
    }
    // A real tag that opens in a quote and closes there is still the quoted one.
    const quoted = findActionableHandOffs(`He wrote "${tag}" last time. ${tag}`)
    expect(quoted.delegates).toHaveLength(1)
    expect(quoted.shownDelegates).toHaveLength(1)
  })

  it('a tag shown in a quoted sentence is not a hand-off that could not be read', () => {
    expect(looksLikeBrokenHandOff(`She wrote: "please run ${tag} today" last week.`)).toBe(false)
  })

  it('stays linear on a line of quoted openers', { timeout: 60_000 }, () => {
    // Wall time on a busy CI runner says little, so this compares sizes instead: eight
    // times the input may take about eight times as long, not the 64 of a quadratic read.
    // It counts the CPU time this process spent, not the wall clock, which stretches
    // when the tests running beside this one take the machine. The two sizes take turns
    // and each keeps its fastest read.
    const quotedOpeners = (count: number): string =>
      Array.from({ length: count }, () => '"x <delegate to="@Name"> y"').join(' ') + ' ' + tag
    const read = (text: string): number => {
      const started = process.cpuUsage()
      findActionableHandOffs(text)
      looksLikeBrokenHandOff(text)
      const spent = process.cpuUsage(started)
      return spent.user + spent.system
    }
    const smallText = quotedOpeners(1000)
    const largeText = quotedOpeners(8000)
    read(smallText)
    let small = Infinity
    let large = Infinity
    for (let i = 0; i < 5; i++) {
      small = Math.min(small, read(smallText))
      large = Math.min(large, read(largeText))
    }
    expect(large / small).toBeLessThan(24)
    // And it still reads the long reply right: only the real tag at the end hands off.
    const text = quotedOpeners(8000)
    const found = findActionableHandOffs(text)
    expect(found.delegates.map((b) => [b.targetName, b.task])).toEqual([
      ['@Growth/Coder', 'fix the parser'],
    ])
    expect(found.shownDelegates).toEqual([])
    expect(looksLikeBrokenHandOff(text)).toBe(false)
  })

  it('takes a tag in plain text', () => {
    const found = findActionableHandOffs(`On it. ${tag}`)
    expect(found.delegates.map((b) => b.task)).toEqual(['fix the parser'])
    expect(found.shownDelegates).toEqual([])
  })

  it.each([
    ['a fenced block', '```xml\n' + tag + '\n```'],
    ['a tilde fence', '~~~\n' + tag + '\n~~~'],
    ['a fence never closed', 'Draft:\n```\n' + tag],
    ['inline code', 'Write `' + tag + '` to hand it off.'],
    ['a double-backtick span', 'Write ``' + tag + '`` to hand it off.'],
    ['a block quote', 'They said:\n> ' + tag],
    ['an indented block', 'Like so:\n\n    ' + tag],
    ['quotation marks', 'He wrote "' + tag + '" last time.'],
    ['curly quotation marks', 'He wrote “' + tag + '” last time.'],
  ])('shows, and does not take, a tag in %s', (_name, text) => {
    const found = findActionableHandOffs(text)
    expect(found.delegates).toEqual([])
    expect(found.shownDelegates).toHaveLength(1)
  })

  it('does not take a plan in code either', () => {
    const found = findActionableHandOffs('```\n' + planTag + '\n```')
    expect(found.plans).toEqual([])
    expect(found.shownPlans).toHaveLength(1)
  })

  it('takes a real tag beside a quoted one', () => {
    const found = findActionableHandOffs('```\n' + tag + '\n```\nAnd now:\n' + tag)
    expect(found.delegates).toHaveLength(1)
    expect(found.shownDelegates).toHaveLength(1)
  })

  it('keeps the whole brief of a real tag that has code or a quote inside it', () => {
    const body = 'Fix this:\n```\nconst x = 1\n```\n> and this quote\nthanks'
    const found = findActionableHandOffs(`<delegate to="@Growth/Coder">${body}</delegate>`)
    expect(found.delegates).toHaveLength(1)
    expect(found.delegates[0]!.task).toBe(body)
  })

  it('a lone backtick or a fence-like word hides nothing', () => {
    expect(findActionableHandOffs('it costs 5` and ' + tag).delegates).toHaveLength(1)
    expect(findActionableHandOffs('use `x` first, then ' + tag).delegates).toHaveLength(1)
    expect(findActionableHandOffs('a list:\n- item\n' + tag).delegates).toHaveLength(1)
  })

  it('stays linear on a run of unmatched backticks', () => {
    const text = Array.from({ length: 4000 }, (_, i) => '`'.repeat((i % 7) + 1) + ' x').join(' ')
    const started = Date.now()
    findActionableHandOffs(text + tag)
    expect(Date.now() - started).toBeLessThan(500)
  })

  describe('stripActionableHandOffs', () => {
    it('takes out what started, and leaves what is only shown', () => {
      const shown = 'Draft:\n```\n' + tag + '\n```'
      expect(stripActionableHandOffs(`On it. ${tag}\n${shown}`)).toBe(`On it. \n${shown}`)
    })
    it('takes out a plan outside code, which the chat answers for', () => {
      expect(stripActionableHandOffs(`Plan: ${planTag}`)).toBe('Plan:')
    })
    it('leaves text with no tag as it is', () => {
      expect(stripActionableHandOffs('  plain words ')).toBe('  plain words ')
    })
  })

  describe('looksLikeBrokenHandOff', () => {
    it.each([
      ['an opener with no closer', '<delegate to="@Growth/Coder">fix the parser'],
      ['a closer with no opener', 'fix the parser</delegate>'],
      ['a dropped bracket', 'delegate to="@Coder" fix it'],
      ['a step outside a plan', '<step to="@Coder">fix it'],
    ])('reads %s as one', (_name, text) => {
      expect(looksLikeBrokenHandOff(text)).toBe(true)
    })
    it.each([
      ['a mention of a plan', 'A <plan> needs that team’s own chat.'],
      ['a bare mention', 'I can write a <delegate> for that.'],
      ['the word in prose', 'I will delegate to Coder later.'],
      ['a tag in code', 'Use `<delegate to="@Coder">` like that'],
    ])('does not read %s as one', (_name, text) => {
      expect(looksLikeBrokenHandOff(text)).toBe(false)
    })
  })
})

describe('a name with an apostrophe in a tag', () => {
  it.each([
    ['straight', "Founder's Office/Coder"],
    ['curly', 'Founder’s Office/Coder'],
  ])('reads a %s one in a double-quoted value', (_name, target) => {
    const blocks = findDelegationBlocks(`<delegate to="@${target}">fix it</delegate>`)
    expect(blocks.map((b) => b.targetName)).toEqual([`@${target}`])
    expect(blocks[0]!.task).toBe('fix it')
  })

  it('reads one in a plan step too', () => {
    const [plan] = findPlanBlocks(`<plan><step to="@Founder's Office/Coder">one</step></plan>`)
    expect(plan!.steps.map((s) => s.targetName)).toEqual(["@Founder's Office/Coder"])
  })

  it('still takes a single-quoted or curly-quoted value', () => {
    expect(findDelegationBlocks(`<delegate to='@Coder'>a</delegate>`)[0]!.targetName).toBe('@Coder')
    expect(findDelegationBlocks(`<delegate to=“@Coder”>a</delegate>`)[0]!.targetName).toBe('@Coder')
  })

  it('does not run one value into the next attribute', () => {
    const text = 'the to="x" part, then <delegate to="@Coder">a</delegate>'
    expect(findDelegationBlocks(text).map((b) => b.targetName)).toEqual(['@Coder'])
  })
})

describe('looksLikeBrokenHandOff on a very long reply', () => {
  it('stays fast on a long run of opening tags', () => {
    const reply = '<delegate\t'.repeat(40_000)
    const started = Date.now()
    expect(looksLikeBrokenHandOff(reply)).toBe(false)
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it('still sees a mangled tag', () => {
    expect(looksLikeBrokenHandOff('<delegate team="x" to="@Bug Boo">fix it')).toBe(true)
  })
})
