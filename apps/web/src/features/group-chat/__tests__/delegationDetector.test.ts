import { describe, it, expect } from 'vitest'
import {
  detectDelegations,
  isRelayMessage,
  isIntroductionResponse,
  findDelegationBlocks,
  parseStructuredDelegations,
  stripDelegationBlocks,
} from '../delegationDetector'

const agents = [
  { id: 'a1', name: 'Code Reviewer Boo' },
  { id: 'a2', name: 'SEO Analyst Boo' },
  { id: 'a3', name: 'Bug Fixer Boo' },
  { id: 'a4', name: 'Bug Fixer' },
  { id: 'a5', name: 'Doc Writer Boo' },
]

describe('detectDelegations — basic patterns', () => {
  it('detects "@AgentName, please do X" pattern', () => {
    const result = detectDelegations(
      '@Code Reviewer Boo, please review the auth module',
      'src',
      agents,
    )
    expect(result).toHaveLength(1)
    expect(result[0]!.targetAgentId).toBe('a1')
    expect(result[0]!.taskDescription).toBe('review the auth module')
  })

  it('detects "route to @AgentName for X" pattern', () => {
    const result = detectDelegations(
      'route to @SEO Analyst Boo for keyword analysis',
      'src',
      agents,
    )
    expect(result).toHaveLength(1)
    expect(result[0]!.targetAgentId).toBe('a2')
    expect(result[0]!.taskDescription).toBe('keyword analysis')
  })

  it('detects "coordinate with @AgentName on X" pattern', () => {
    const result = detectDelegations(
      'coordinate with @Bug Fixer Boo on the memory leak',
      'src',
      agents,
    )
    expect(result).toHaveLength(1)
    expect(result[0]!.targetAgentId).toBe('a3')
    expect(result[0]!.taskDescription).toBe('the memory leak')
  })

  it('detects "I need @AgentName to X" pattern', () => {
    const result = detectDelegations('I need @Doc Writer Boo to update the API docs', 'src', agents)
    expect(result).toHaveLength(1)
    expect(result[0]!.targetAgentId).toBe('a5')
    expect(result[0]!.taskDescription).toBe('update the API docs')
  })

  it('detects "delegate to @AgentName: X" pattern', () => {
    const result = detectDelegations(
      'delegate to @SEO Analyst Boo: run a site audit',
      'src',
      agents,
    )
    expect(result).toHaveLength(1)
    expect(result[0]!.targetAgentId).toBe('a2')
    expect(result[0]!.taskDescription).toBe('run a site audit')
  })

  it('detects direct address "@AgentName, X" with comma', () => {
    const result = detectDelegations(
      '@Bug Fixer Boo, investigate the crash in the parser',
      'src',
      agents,
    )
    expect(result).toHaveLength(1)
    expect(result[0]!.targetAgentId).toBe('a3')
    expect(result[0]!.taskDescription).toBe('investigate the crash in the parser')
  })

  // ── Pattern 7: em/en/regular dash separator ────────────────────────────
  // Production regression: leader wrote "Let's go. @Engineering Boo — take
  // the lead on the MVP." which the detector missed entirely. Real LLMs use
  // em-dash as a delegation separator very frequently.

  it('detects "@AgentName — task" with em dash (U+2014)', () => {
    const result = detectDelegations(
      "Let's go. @Bug Fixer Boo — take the lead on the parser refactor.",
      'src',
      agents,
    )
    expect(result).toHaveLength(1)
    expect(result[0]!.targetAgentId).toBe('a3')
    expect(result[0]!.taskDescription).toBe('take the lead on the parser refactor')
  })

  it('detects "@AgentName – task" with en dash (U+2013)', () => {
    const result = detectDelegations(
      "Let's go. @Bug Fixer Boo – take the lead on the parser refactor.",
      'src',
      agents,
    )
    expect(result).toHaveLength(1)
    expect(result[0]!.targetAgentId).toBe('a3')
    expect(result[0]!.taskDescription).toBe('take the lead on the parser refactor')
  })

  it('detects "@AgentName - task" with regular hyphen', () => {
    const result = detectDelegations(
      "Let's go. @Bug Fixer Boo - take the lead on the parser refactor.",
      'src',
      agents,
    )
    expect(result).toHaveLength(1)
    expect(result[0]!.targetAgentId).toBe('a3')
    expect(result[0]!.taskDescription).toBe('take the lead on the parser refactor')
  })

  // ── Pattern 8: bare colon separator after @Name ────────────────────────

  it('detects "@AgentName: task" with bare colon', () => {
    const result = detectDelegations(
      '@Bug Fixer Boo: investigate the crash in the parser',
      'src',
      agents,
    )
    expect(result).toHaveLength(1)
    expect(result[0]!.targetAgentId).toBe('a3')
    expect(result[0]!.taskDescription).toBe('investigate the crash in the parser')
  })

  // ── Pattern 9: declarative @Name {verb} {task} at clause start ──────────
  // Production regression: leader wrote a bulleted plan
  //   "Suggested Sequence:
  //    This week: @Engineering Rapid Prototyper Boo builds the MVP
  //    Next week: @Engineering Frontend Developer Boo polishes the UI"
  // None of these matched the old detector. The clause-start guard lets
  // us catch them while still rejecting casual mid-sentence references.

  it('detects "Label: @AgentName builds X" structured list delegations', () => {
    const text = `Suggested Sequence:
This week: @Bug Fixer Boo builds the MVP
Next week: @SEO Analyst Boo polishes the landing page
Parallel: @Doc Writer Boo drafts the README`
    const result = detectDelegations(text, 'src', agents)
    const targets = result.map((d) => d.targetAgentId).sort()
    expect(targets).toEqual(['a2', 'a3', 'a5'])
    // Each task should be the verb + rest
    const bug = result.find((d) => d.targetAgentId === 'a3')
    expect(bug?.taskDescription).toBe('builds the MVP')
  })

  it('detects "@AgentName <verb> X" at the very start of the text', () => {
    const result = detectDelegations(
      '@Bug Fixer Boo handles the auth refactor today.',
      'src',
      agents,
    )
    expect(result).toHaveLength(1)
    expect(result[0]!.targetAgentId).toBe('a3')
    expect(result[0]!.taskDescription).toBe('handles the auth refactor today')
  })

  it('detects "@AgentName <verb> X" at start of new line in a paragraph', () => {
    const text = `Plan for the sprint:
@Bug Fixer Boo investigates the parser bug.
@SEO Analyst Boo audits the landing page keywords.`
    const result = detectDelegations(text, 'src', agents)
    expect(result).toHaveLength(2)
    expect(result.map((d) => d.targetAgentId).sort()).toEqual(['a2', 'a3'])
  })

  // ── False-positive guards (Pattern 9) ───────────────────────────────────
  // The clause-start restriction + stative-verb deny-list keeps the new
  // pattern from over-matching casual references.

  it('does NOT treat "I worked with @AgentName yesterday" as a delegation', () => {
    const result = detectDelegations(
      'I worked with @Bug Fixer Boo yesterday on the parser bug.',
      'src',
      agents,
    )
    // @ is mid-sentence (not at clause start), and there's no "with @Name"
    // / coordinate-with / route-to prefix, so no delegation should fire.
    expect(result).toEqual([])
  })

  it('does NOT trigger on "@AgentName and @AgentName" (conjunction list)', () => {
    const result = detectDelegations(
      'Today @Bug Fixer Boo and @SEO Analyst Boo are working together.',
      'src',
      agents,
    )
    // The bare follow-word "and" is in NON_DELEGATION_FOLLOW_WORDS, so
    // Pattern 9 rejects @Bug Fixer Boo. @SEO Analyst Boo is mid-sentence
    // (not at clause start), so it's also not a delegation.
    expect(result).toEqual([])
  })

  it('does NOT trigger on stative verbs like "@AgentName is busy"', () => {
    const result = detectDelegations('@Bug Fixer Boo is busy with the parser bug.', 'src', agents)
    // "is" is in NON_DELEGATION_FOLLOW_WORDS — keeps casual descriptive
    // statements out of the delegation detector.
    expect(result).toEqual([])
  })
})

describe('detectDelegations — task extraction', () => {
  it('extracts task up to period', () => {
    const result = detectDelegations(
      '@Code Reviewer Boo, check the types. Then we can merge.',
      'src',
      agents,
    )
    expect(result).toHaveLength(1)
    expect(result[0]!.taskDescription).toBe('check the types')
  })

  it('extracts task up to newline', () => {
    const result = detectDelegations(
      '@Code Reviewer Boo, check the types\nAlso fix the tests',
      'src',
      agents,
    )
    expect(result).toHaveLength(1)
    expect(result[0]!.taskDescription).toBe('check the types')
  })

  it('extracts task up to next @mention', () => {
    const result = detectDelegations(
      '@Code Reviewer Boo, check the types @SEO Analyst Boo, run an audit',
      'src',
      agents,
    )
    expect(result).toHaveLength(2)
    expect(result[0]!.taskDescription).toBe('check the types')
    expect(result[1]!.targetAgentId).toBe('a2')
  })

  it('trims whitespace from task', () => {
    const result = detectDelegations('@Code Reviewer Boo,   review the PR   ', 'src', agents)
    expect(result).toHaveLength(1)
    expect(result[0]!.taskDescription).toBe('review the PR')
  })
})

describe('detectDelegations — multiple delegations', () => {
  it('finds multiple @mentions to different agents', () => {
    const text = '@Code Reviewer Boo, review auth module\n@SEO Analyst Boo, check meta tags'
    const result = detectDelegations(text, 'src', agents)
    expect(result).toHaveLength(2)
    expect(result[0]!.targetAgentId).toBe('a1')
    expect(result[1]!.targetAgentId).toBe('a2')
  })

  it('dedupes same agent mentioned twice (returns first only)', () => {
    const text = '@Code Reviewer Boo, review auth module\nAlso @Code Reviewer Boo, check types'
    const result = detectDelegations(text, 'src', agents)
    expect(result).toHaveLength(1)
    expect(result[0]!.taskDescription).toBe('review auth module')
  })
})

describe('detectDelegations — filters', () => {
  it('skips self-mention (source === target)', () => {
    const result = detectDelegations('@Code Reviewer Boo, review this', 'a1', agents)
    expect(result).toHaveLength(0)
  })

  it('skips @mention inside fenced code block', () => {
    const text = '```\n@Code Reviewer Boo, review this\n```'
    const result = detectDelegations(text, 'src', agents)
    expect(result).toHaveLength(0)
  })

  it('skips @mention inside inline code', () => {
    const text = 'Use `@Code Reviewer Boo` for reviews'
    const result = detectDelegations(text, 'src', agents)
    expect(result).toHaveLength(0)
  })

  it('skips @mention inside blockquote', () => {
    const text = '> @Code Reviewer Boo, review this'
    const result = detectDelegations(text, 'src', agents)
    expect(result).toHaveLength(0)
  })

  it('skips when task description is empty', () => {
    const text = 'delegate to @Code Reviewer Boo:'
    const result = detectDelegations(text, 'src', agents)
    expect(result).toHaveLength(0)
  })

  it('skips unknown agent names (not in teamAgents)', () => {
    const result = detectDelegations('@Unknown Agent, do something', 'src', agents)
    expect(result).toHaveLength(0)
  })
})

describe('detectDelegations — edge cases', () => {
  it('returns empty array for text with no @mentions', () => {
    const result = detectDelegations('Just a normal message', 'src', agents)
    expect(result).toHaveLength(0)
  })

  it('handles case-insensitive agent names', () => {
    const result = detectDelegations('@code reviewer boo, check the PR', 'src', agents)
    expect(result).toHaveLength(1)
    expect(result[0]!.targetAgentId).toBe('a1')
    expect(result[0]!.targetAgentName).toBe('Code Reviewer Boo')
  })

  it('uses longest-prefix match for agent names', () => {
    const result = detectDelegations('@Bug Fixer Boo, fix the null pointer', 'src', agents)
    expect(result).toHaveLength(1)
    // Should match "Bug Fixer Boo" (a3), not "Bug Fixer" (a4)
    expect(result[0]!.targetAgentId).toBe('a3')
    expect(result[0]!.targetAgentName).toBe('Bug Fixer Boo')
  })
})

describe('isRelayMessage', () => {
  it('returns true for "[Team Update]" prefix', () => {
    expect(isRelayMessage('[Team Update] Agent completed task')).toBe(true)
  })

  it('returns true for "[Team Context" prefix', () => {
    expect(isRelayMessage('[Team Context — last 3 messages]\n...')).toBe(true)
  })

  it('returns false for normal text', () => {
    expect(isRelayMessage('Hello team, lets get started')).toBe(false)
  })
})

describe('isIntroductionResponse — cascade-prevention guard', () => {
  it('detects classic "I\'m {name}, I specialize in" intros', () => {
    expect(
      isIntroductionResponse(
        "I'm Bug Fixer Boo, and I specialize in finding and fixing root causes in code.",
      ),
    ).toBe(true)
  })

  it('detects "Hi! I\'m {name}, here to help" intros', () => {
    expect(
      isIntroductionResponse("Hi! I'm SEO Analyst Boo, here to help with keyword analysis."),
    ).toBe(true)
  })

  it('detects "Hello, my name is" intros', () => {
    expect(
      isIntroductionResponse(
        'Hello, my name is Code Reviewer Boo and my focus is on code quality and security.',
      ),
    ).toBe(true)
  })

  it('returns false for normal delegation text', () => {
    expect(
      isIntroductionResponse('@Bug Fixer Boo, please investigate the null pointer in auth.ts.'),
    ).toBe(false)
  })

  it('returns false for long responses (>400 chars) even if intro-like', () => {
    const long = "I'm a specialist with expertise in ".concat('.'.repeat(500))
    expect(isIntroductionResponse(long)).toBe(false)
  })

  it('returns false for openers without specialization keywords', () => {
    expect(isIntroductionResponse("Hi! I'm done with the task you requested.")).toBe(false)
  })

  // Regression: in production, a leader response like "Hi! I'm here to help.
  // @Bug Fixer Boo, please handle X" was being short-circuited as a "pure
  // intro" by isIntroductionResponse, so the @mention delegations never
  // reached their target agents and team chat went stale.
  it('returns false when intro-shaped text contains a comma delegation pattern', () => {
    expect(
      isIntroductionResponse(
        "Hi! I'm here to help. @Bug Fixer Boo, please investigate the auth bug.",
      ),
    ).toBe(false)
  })

  it('returns false when intro-shaped text contains "delegate to @Name"', () => {
    expect(
      isIntroductionResponse("Hi! I'm here to help. Let me delegate to @Bug Fixer Boo for this."),
    ).toBe(false)
  })

  it('returns false when intro-shaped text contains "I need @Name to ..."', () => {
    expect(
      isIntroductionResponse(
        'Hello! I am the project lead and I specialize in coordination. I need @SEO Analyst Boo to run a site audit.',
      ),
    ).toBe(false)
  })

  it('returns false when intro-shaped text contains "coordinate with @Name on"', () => {
    expect(
      isIntroductionResponse(
        "Hi! I'm here to help. We should coordinate with @Bug Fixer Boo on this issue.",
      ),
    ).toBe(false)
  })

  it('returns true for casual intro mentioning teammates without delegation', () => {
    // Pure intro acknowledgment — keep blocking these (this is what the
    // wake-message cascade looked like in production).
    expect(
      isIntroductionResponse(
        "Hi! I'm Bug Fixer Boo and I specialize in debugging. Looking forward to working with @SEO Analyst Boo and @Code Reviewer Boo.",
      ),
    ).toBe(true)
  })
})

describe('detectDelegations — introduction cascade guard', () => {
  it('does NOT detect delegations in introduction-style responses', () => {
    // This is the cascade trigger: when wake messages asked agents to introduce
    // themselves with teammate context, agents echoed the @mentions, which were
    // then parsed as delegations. The guard prevents this regression.
    const intro =
      "Hi! I'm Bug Fixer Boo, and I specialize in debugging. Looking forward to working with @SEO Analyst Boo and @Code Reviewer Boo."
    expect(detectDelegations(intro, 'a3', agents)).toEqual([])
  })

  it('still detects real delegations in non-introduction text', () => {
    const real = '@SEO Analyst Boo, please run a site audit on the new landing page.'
    expect(detectDelegations(real, 'a1', agents).length).toBe(1)
  })

  // Production regression: in the second stale-delegation chat the leader
  // wrote a bulleted plan with em-dash separators that the original
  // detector missed entirely. After fixing patterns 7 / 8 / 9, all three
  // engineering delegations should be picked up.
  it('detects all delegations from the production "stale chat" leader response', () => {
    const text = `Let's go. @Bug Fixer Boo — take the lead on the MVP. Here's what we're building:

MVP Scope:
- Single AI Consultant agent (conversational, not multi-agent yet)
- Pre-built prompt templates

@SEO Analyst Boo — since this is an MVP, suggest a simple architecture we can spin up quickly. Database, API, auth — keep it lean.

@Doc Writer Boo — after the prototyper has something working, you'll polish the UI. For now, what frontend framework do you prefer?`
    const result = detectDelegations(text, 'src', agents)
    const targets = result.map((d) => d.targetAgentId).sort()
    // All three em-dash delegations land
    expect(targets).toEqual(['a2', 'a3', 'a5'])
    // Each task should be non-empty
    expect(result.every((d) => d.taskDescription.length > 0)).toBe(true)
  })

  it('detects bulleted "Time: @Name verb X" delegations from the production chat', () => {
    const text = `Suggested Sequence:

This week: @Bug Fixer Boo builds the MVP (single agent + templates)
Next week: @SEO Analyst Boo polishes the UI for pilot users
Parallel: @Doc Writer Boo launches pilot outreach + content prep`
    const result = detectDelegations(text, 'src', agents)
    const targets = result.map((d) => d.targetAgentId).sort()
    expect(targets).toEqual(['a2', 'a3', 'a5'])
  })

  // Regression test for the production "stale delegations" bug:
  // a leader response like "Hi! I'm here to help. @X, please A. @Y, please B."
  // was being entirely skipped by the (overly-aggressive) intro guard, so the
  // tagged teammates never received their tasks and the chat went stale.
  it('detects delegations even when the message opens with an intro greeting', () => {
    // Agents fixture: a1 Code Reviewer Boo, a2 SEO Analyst Boo, a3 Bug Fixer Boo, a5 Doc Writer Boo
    const text = `Hi! I'm here to help with that. Let me coordinate the team:
@Bug Fixer Boo, please investigate the auth bug in login.ts.
@SEO Analyst Boo, please review keyword performance for the landing page.
@Code Reviewer Boo, please review the recent PR for security issues.`

    // Source = a5 (Doc Writer Boo), so all three @mentions should resolve
    const fromOther = detectDelegations(text, 'a5', agents)
    const allTargets = fromOther.map((d) => d.targetAgentId).sort()
    expect(allTargets).toEqual(['a1', 'a2', 'a3'])
    expect(fromOther.every((d) => d.taskDescription.length > 0)).toBe(true)

    // When source is the leader (a1 Code Reviewer Boo), self-mentions get
    // filtered, so only a2 and a3 should be returned.
    const fromLeader = detectDelegations(text, 'a1', agents)
    const leaderTargets = fromLeader.map((d) => d.targetAgentId).sort()
    expect(leaderTargets).toEqual(['a2', 'a3'])
  })
})

// ─── Structured `<delegate>` protocol ────────────────────────────────────
// Primary path: agents are instructed via AGENTS.md to emit explicit
// `<delegate to="@Name">task</delegate>` blocks. These bypass the heuristic
// regex flow entirely and route with high confidence.

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

describe('detectDelegations — structured-first routing', () => {
  it('uses structured tags exclusively when present (ignores prose @-mentions)', () => {
    // Both forms in the same message — structured should win and prose @
    // mentions should be ignored to avoid double-routing.
    const text = `Coordination plan:
@SEO Analyst Boo, please pause on keywords until Bug Fixer is done.
<delegate to="@Bug Fixer Boo">fix the parser bug first</delegate>`
    const result = detectDelegations(text, 'src', agents)
    expect(result).toHaveLength(1)
    expect(result[0]!.targetAgentId).toBe('a3')
    expect(result[0]!.taskDescription).toBe('fix the parser bug first')
  })

  it('falls back to regex patterns when no structured tags are present', () => {
    const text = '@Bug Fixer Boo, please investigate the parser bug.'
    const result = detectDelegations(text, 'src', agents)
    expect(result).toHaveLength(1)
    expect(result[0]!.targetAgentId).toBe('a3')
    expect(result[0]!.taskDescription).toBe('investigate the parser bug')
  })

  it('returns empty array when neither structured nor regex pattern matches', () => {
    expect(detectDelegations('plain prose with no delegation', 'src', agents)).toEqual([])
  })

  it('routes the production "stale chat" scenario via structured tags', () => {
    // The production-failing leader response, but rewritten with the
    // structured protocol the agent will be instructed to use after
    // refresh-protocol. All three engineering delegations should land.
    const text = `Let's go. Here's the plan:

<delegate to="@Bug Fixer Boo">
take the lead on the MVP — single AI Consultant agent + pre-built prompt templates
</delegate>

<delegate to="@SEO Analyst Boo">
suggest a simple architecture we can spin up quickly. Database, API, auth — keep it lean.
</delegate>

<delegate to="@Doc Writer Boo">
after the prototyper has something working, you'll polish the UI. What frontend framework do you prefer?
</delegate>`
    const result = detectDelegations(text, 'src', agents)
    expect(result.map((d) => d.targetAgentId).sort()).toEqual(['a2', 'a3', 'a5'])
    expect(result.every((d) => d.taskDescription.length > 0)).toBe(true)
  })
})
