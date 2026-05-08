import { describe, it, expect } from 'vitest'
import {
  buildTeamAgentsMd,
  buildTeamWakeMessage,
  buildTeamContextPreamble,
  buildClawbooHelpDoc,
  buildSelfDocumentingRelayHeader,
  slugifyAgentName,
} from '../teamProtocol'

describe('buildTeamAgentsMd', () => {
  const teammates = [
    { name: 'Bug Fixer Boo', role: 'Fixes bugs' },
    { name: 'SEO Analyst Boo', role: 'SEO optimization' },
  ]

  it('generates correct markdown with teammates and routing rules', () => {
    const result = buildTeamAgentsMd({
      agentName: 'Lead Dev Boo',
      teamName: 'Dev Team',
      teammates,
      routingRules: 'When code review needed, route to @Bug Fixer Boo',
    })
    expect(result).toContain('# AGENTS — Team Collaboration')
    expect(result).toContain('## Your Team: Dev Team')
    expect(result).toContain('You are **Lead Dev Boo**')
    expect(result).toContain('### Routing Rules')
    expect(result).toContain('When code review needed, route to @Bug Fixer Boo')
  })

  it('includes all teammate names in table', () => {
    const result = buildTeamAgentsMd({
      agentName: 'Lead Dev Boo',
      teamName: 'Dev Team',
      teammates,
      routingRules: '',
    })
    expect(result).toContain('| @Bug Fixer Boo | Fixes bugs |')
    expect(result).toContain('| @SEO Analyst Boo | SEO optimization |')
  })

  it('handles empty teammates (solo agent — omits team section)', () => {
    const result = buildTeamAgentsMd({
      agentName: 'Solo Boo',
      teamName: 'Solo Team',
      teammates: [],
      routingRules: 'Route to self',
    })
    expect(result).not.toContain('Team Collaboration')
    expect(result).not.toContain('Teammates')
    expect(result).not.toContain('CRITICAL')
    expect(result).toContain('Route to self')
  })

  it('handles empty/missing routing rules', () => {
    const result = buildTeamAgentsMd({
      agentName: 'Lead Dev Boo',
      teamName: 'Dev Team',
      teammates,
      routingRules: '',
    })
    expect(result).toContain('No specific routing rules defined.')
  })

  it('includes the "DO NOT spawn sub-agents" instruction when teammates exist', () => {
    const result = buildTeamAgentsMd({
      agentName: 'Lead Dev Boo',
      teamName: 'Dev Team',
      teammates,
      routingRules: '',
    })
    expect(result).toContain('**DO NOT:**')
    expect(result).toContain('Spawn sub-agents')
    expect(result).toContain('REAL OpenClaw agents')
  })

  it('preserves original routing rules content verbatim', () => {
    const rules =
      '1. Route bugs to @Bug Fixer\n2. Route SEO to @SEO Analyst\n3. Handle all else yourself'
    const result = buildTeamAgentsMd({
      agentName: 'Lead Dev Boo',
      teamName: 'Dev Team',
      teammates,
      routingRules: rules,
    })
    expect(result).toContain(rules)
  })

  it('includes the Delegation Protocol section with the <delegate> tag example', () => {
    const result = buildTeamAgentsMd({
      agentName: 'Lead Dev Boo',
      teamName: 'Dev Team',
      teammates,
      routingRules: '',
    })
    expect(result).toContain('### Delegation Protocol (REQUIRED)')
    // Literal protocol example must be present so the agent can mimic it
    expect(result).toContain('<delegate to="@')
    expect(result).toContain('</delegate>')
    // Uses the first teammate as the example to ground it in a real target
    expect(result).toContain('@Bug Fixer Boo')
  })

  it('warns against natural-language delegation in DO NOT section', () => {
    const result = buildTeamAgentsMd({
      agentName: 'Lead Dev Boo',
      teamName: 'Dev Team',
      teammates,
      routingRules: '',
    })
    // The agent should be steered AWAY from prose @-mentions for delegation
    expect(result).toMatch(/DO NOT[\s\S]*Rely on plain @-mentions/i)
  })
})

describe('buildTeamWakeMessage', () => {
  const teammates = [
    { name: 'Code Reviewer Boo', role: 'Reviews pull requests' },
    { name: 'QA Tester Boo', role: 'Writes and runs tests' },
  ]

  it('includes agent name and team name', () => {
    const result = buildTeamWakeMessage({
      agentName: 'Lead Dev Boo',
      teamName: 'Engineering',
      teammates,
    })
    expect(result).toContain('as Lead Dev Boo')
    expect(result).toContain('Team: Engineering')
  })

  it('lists all teammates with roles', () => {
    const result = buildTeamWakeMessage({
      agentName: 'Lead Dev Boo',
      teamName: 'Engineering',
      teammates,
    })
    expect(result).toContain('- @Code Reviewer Boo (Reviews pull requests)')
    expect(result).toContain('- @QA Tester Boo (Writes and runs tests)')
  })

  it('includes "REAL agents" instruction', () => {
    const result = buildTeamWakeMessage({
      agentName: 'Lead Dev Boo',
      teamName: 'Engineering',
      teammates,
    })
    expect(result).toContain('REAL agents with their own sessions')
  })

  it('includes "Do NOT spawn sub-agents" instruction', () => {
    const result = buildTeamWakeMessage({
      agentName: 'Lead Dev Boo',
      teamName: 'Engineering',
      teammates,
    })
    expect(result).toContain('Do NOT spawn sub-agents')
  })

  it('includes the structured <delegate> protocol example', () => {
    // Wake messages now nudge agents toward the structured delegation
    // protocol so they don't have to learn it from AGENTS.md alone.
    const result = buildTeamWakeMessage({
      agentName: 'Lead Dev Boo',
      teamName: 'Engineering',
      teammates,
    })
    expect(result).toContain('<delegate to=')
    expect(result).toContain('</delegate>')
    // Uses the first teammate as the example name so the agent has a
    // concrete target it knows.
    expect(result).toContain('@Code Reviewer Boo')
  })
})

describe('buildTeamContextPreamble', () => {
  const ts = (h: number, m: number) => new Date(2026, 0, 1, h, m).getTime()

  it('returns null when no entries', () => {
    const result = buildTeamContextPreamble({
      entries: [],
      targetAgentName: 'Lead Boo',
    })
    expect(result).toBeNull()
  })

  it('returns null when all entries are from the target agent', () => {
    const result = buildTeamContextPreamble({
      entries: [
        {
          agentName: 'Lead Boo',
          text: 'hello',
          timestampMs: ts(10, 0),
          kind: 'text',
          role: 'assistant',
        },
      ],
      targetAgentName: 'Lead Boo',
    })
    expect(result).toBeNull()
  })

  it('excludes target agent own messages', () => {
    const result = buildTeamContextPreamble({
      entries: [
        {
          agentName: 'Lead Boo',
          text: 'my msg',
          timestampMs: ts(10, 0),
          kind: 'text',
          role: 'assistant',
        },
        {
          agentName: 'Bug Fixer',
          text: 'their msg',
          timestampMs: ts(10, 1),
          kind: 'text',
          role: 'assistant',
        },
      ],
      targetAgentName: 'Lead Boo',
    })
    expect(result).not.toContain('my msg')
    expect(result).toContain('Bug Fixer: their msg')
  })

  it('excludes meta entries (kind === "meta")', () => {
    const result = buildTeamContextPreamble({
      entries: [
        {
          agentName: 'System',
          text: 'Initializing...',
          timestampMs: ts(10, 0),
          kind: 'meta',
          role: 'system',
        },
        {
          agentName: 'Bug Fixer',
          text: 'ready',
          timestampMs: ts(10, 1),
          kind: 'text',
          role: 'assistant',
        },
      ],
      targetAgentName: 'Lead Boo',
    })
    expect(result).not.toContain('Initializing')
    expect(result).toContain('Bug Fixer: ready')
  })

  it('excludes [Team Update] prefixed entries', () => {
    const result = buildTeamContextPreamble({
      entries: [
        {
          agentName: 'Bug Fixer',
          text: '[Team Update] relay msg',
          timestampMs: ts(10, 0),
          kind: 'text',
          role: 'assistant',
        },
        {
          agentName: 'QA Boo',
          text: 'actual msg',
          timestampMs: ts(10, 1),
          kind: 'text',
          role: 'assistant',
        },
      ],
      targetAgentName: 'Lead Boo',
    })
    expect(result).not.toContain('relay msg')
    expect(result).toContain('QA Boo: actual msg')
  })

  it('truncates long messages to 200 chars', () => {
    const longText = 'a'.repeat(300)
    const result = buildTeamContextPreamble({
      entries: [
        {
          agentName: 'Bug Fixer',
          text: longText,
          timestampMs: ts(10, 0),
          kind: 'text',
          role: 'assistant',
        },
      ],
      targetAgentName: 'Lead Boo',
    })
    expect(result).toContain('a'.repeat(200) + '...')
    expect(result).not.toContain('a'.repeat(201))
  })

  it('respects maxMessages limit (takes last N)', () => {
    const entries = Array.from({ length: 5 }, (_, i) => ({
      agentName: 'Bug Fixer',
      text: `msg-${i}`,
      timestampMs: ts(10, i),
      kind: 'text',
      role: 'assistant' as const,
    }))
    const result = buildTeamContextPreamble({
      entries,
      targetAgentName: 'Lead Boo',
      maxMessages: 2,
    })
    expect(result).not.toContain('msg-0')
    expect(result).not.toContain('msg-2')
    expect(result).toContain('msg-3')
    expect(result).toContain('msg-4')
  })

  it('respects maxChars limit (drops oldest)', () => {
    const entries = Array.from({ length: 10 }, (_, i) => ({
      agentName: 'Bug Fixer',
      text: `message number ${i} with some padding text`,
      timestampMs: ts(10, i),
      kind: 'text',
      role: 'assistant' as const,
    }))
    const result = buildTeamContextPreamble({
      entries,
      targetAgentName: 'Lead Boo',
      maxChars: 300,
    })
    expect(result).not.toBeNull()
    expect(result!.length).toBeLessThanOrEqual(300)
    // Should contain later messages, not earlier ones
    expect(result).toContain('message number 9')
  })

  it('formats timestamps as HH:MM', () => {
    const result = buildTeamContextPreamble({
      entries: [
        {
          agentName: 'Bug Fixer',
          text: 'hello',
          timestampMs: ts(9, 5),
          kind: 'text',
          role: 'assistant',
        },
      ],
      targetAgentName: 'Lead Boo',
    })
    expect(result).toContain('[09:05]')
  })

  it('uses "User" for user role entries', () => {
    const result = buildTeamContextPreamble({
      entries: [
        {
          agentName: 'ignored-name',
          text: 'user says hi',
          timestampMs: ts(10, 0),
          kind: 'text',
          role: 'user',
        },
      ],
      targetAgentName: 'Lead Boo',
    })
    expect(result).toContain('User: user says hi')
    expect(result).not.toContain('ignored-name')
  })

  // ── userIntroText injection (user-intro persistence regression) ──────────
  // Background: the user reported uncertainty about whether their self-
  // introduction was actually being delivered to agents. The original code
  // wrote it to SOUL.md only, which Gateway persists unreliably AND was
  // sending the wrong param name (`path` instead of `name`), so the write
  // was silently dropped. The fix adds the intro to the context preamble
  // so it's delivered on every message regardless of file persistence.

  it('emits an [About the User] block when userIntroText is provided with history', () => {
    const result = buildTeamContextPreamble({
      entries: [
        {
          agentName: 'Worker',
          text: 'hello',
          timestampMs: ts(10, 0),
          kind: 'text',
          role: 'assistant',
        },
      ],
      targetAgentName: 'Lead Boo',
      userIntroText: "Hi, I'm Sanju and I'm building Clawboo.",
    })
    expect(result).toContain('[About the User]')
    expect(result).toContain("Hi, I'm Sanju and I'm building Clawboo.")
    expect(result).toContain('[End About the User]')
    // History block still present
    expect(result).toContain('[Team Context')
  })

  it('emits ONLY the user-intro block when there is no relevant history', () => {
    // First message scenario: no team conversation yet, but the agent should
    // still see the user intro on this very first message.
    const result = buildTeamContextPreamble({
      entries: [],
      targetAgentName: 'Lead Boo',
      userIntroText: "I'm Sanju.",
    })
    expect(result).not.toBeNull()
    expect(result).toContain('[About the User]')
    expect(result).toContain("I'm Sanju.")
    expect(result).not.toContain('[Team Context')
  })

  it('returns null when there is no history AND no user intro', () => {
    const result = buildTeamContextPreamble({
      entries: [],
      targetAgentName: 'Lead Boo',
    })
    expect(result).toBeNull()
  })

  it('trims whitespace-only userIntroText to nothing', () => {
    const result = buildTeamContextPreamble({
      entries: [],
      targetAgentName: 'Lead Boo',
      userIntroText: '   \n\t   ',
    })
    expect(result).toBeNull()
  })

  it('places the [About the User] block BEFORE the Team Context block', () => {
    const result = buildTeamContextPreamble({
      entries: [
        {
          agentName: 'Worker',
          text: 'response',
          timestampMs: ts(10, 0),
          kind: 'text',
          role: 'assistant',
        },
      ],
      targetAgentName: 'Lead Boo',
      userIntroText: "I'm Sanju.",
    })
    expect(result).not.toBeNull()
    const aboutIdx = result!.indexOf('[About the User]')
    const ctxIdx = result!.indexOf('[Team Context')
    expect(aboutIdx).toBeGreaterThanOrEqual(0)
    expect(ctxIdx).toBeGreaterThan(aboutIdx)
  })
})

// ─── slugifyAgentName ───────────────────────────────────────────────────────
//
// Must stay byte-identical to `slugifyName` in `lib/createAgent.ts:29`
// — we use this slug to build the workspace path written into CLAWBOO.md,
// and any drift would point agents at the wrong directory on disk.

describe('slugifyAgentName', () => {
  it('lowercases and hyphenates spaces', () => {
    expect(slugifyAgentName('Bug Fixer Boo')).toBe('bug-fixer-boo')
  })
  it('strips non-alphanumeric runs and collapses to single hyphens', () => {
    expect(slugifyAgentName('SEO/Analyst.Boo!!')).toBe('seo-analyst-boo')
  })
  it('trims leading and trailing hyphens', () => {
    expect(slugifyAgentName('  --Code Reviewer Boo--  ')).toBe('code-reviewer-boo')
  })
  it("falls back to 'agent' when input slugifies to empty", () => {
    expect(slugifyAgentName('!!!')).toBe('agent')
    expect(slugifyAgentName('')).toBe('agent')
  })
})

// ─── buildClawbooHelpDoc — CLAWBOO.md workspace-resident reference ──────────

describe('buildClawbooHelpDoc', () => {
  const teammates = [
    { name: 'Bug Fixer Boo', role: 'Fixes bugs' },
    { name: 'SEO Analyst Boo', role: 'SEO optimization' },
  ]

  it('includes the agent name and team name in the header', () => {
    const result = buildClawbooHelpDoc({
      agentName: 'Lead Dev Boo',
      teamName: 'Dev Team',
      teammates,
    })
    expect(result).toContain('Lead Dev Boo')
    expect(result).toContain('Dev Team')
  })

  it('lists every teammate with the correct workspace path', () => {
    const result = buildClawbooHelpDoc({
      agentName: 'Lead Dev Boo',
      teamName: 'Dev Team',
      teammates,
    })
    // Self workspace
    expect(result).toContain('~/.openclaw/workspace-lead-dev-boo')
    // Teammate workspaces
    expect(result).toContain('~/.openclaw/workspace-bug-fixer-boo')
    expect(result).toContain('~/.openclaw/workspace-seo-analyst-boo')
  })

  it('contains the workspace-isolation warning', () => {
    const result = buildClawbooHelpDoc({
      agentName: 'Lead',
      teamName: 'Dev',
      teammates,
    })
    expect(result).toContain('Workspaces are isolated')
    // The "do NOT ls / cat" guidance is the production-derived pitfall
    expect(result).toMatch(/do NOT/i)
  })

  it('explains [Team Update] semantics — explicitly NOT a fresh user message', () => {
    const result = buildClawbooHelpDoc({
      agentName: 'Lead',
      teamName: 'Dev',
      teammates,
    })
    expect(result).toContain('[Team Update]')
    // The exact phrase that prevents the production-confusion case
    expect(result).toContain('NOT A FRESH USER')
  })

  it('describes the orchestration loop', () => {
    const result = buildClawbooHelpDoc({
      agentName: 'Lead',
      teamName: 'Dev',
      teammates,
    })
    // Should describe the 5-step loop
    expect(result).toContain('orchestration loop')
    expect(result).toContain('User sends')
    expect(result).toContain('<delegate>')
  })

  it('teaches the structured <delegate> protocol with a concrete example', () => {
    const result = buildClawbooHelpDoc({
      agentName: 'Lead',
      teamName: 'Dev',
      teammates,
    })
    expect(result).toContain('<delegate to="@')
    // First teammate is used as the example name so it grounds in reality
    expect(result).toContain('@Bug Fixer Boo')
  })

  it('handles a solo agent (no teammates) without crashing', () => {
    const result = buildClawbooHelpDoc({
      agentName: 'Solo Boo',
      teamName: 'Solo Team',
      teammates: [],
    })
    expect(result).toContain('Solo Boo')
    // Falls back to a generic placeholder for the example name
    expect(result).toContain('Teammate Name')
    // Self workspace still listed
    expect(result).toContain('~/.openclaw/workspace-solo-boo')
  })
})

// ─── buildTeamAgentsMd — workspace warning + CLAWBOO.md pointer ─────────────
//
// Production regression: the leader thought it could see teammates' code in
// its own workspace and accused them of fabricating work. The trimmed
// AGENTS.md now ALWAYS includes a workspace-isolation paragraph and a
// pointer to `cat ~/CLAWBOO.md` for the full reference.

describe('buildTeamAgentsMd — workspace isolation + reference pointer', () => {
  const teammates = [
    { name: 'Bug Fixer Boo', role: 'Fixes bugs' },
    { name: 'SEO Analyst Boo', role: 'SEO optimization' },
  ]

  it('contains the Workspace Isolation section', () => {
    const result = buildTeamAgentsMd({
      agentName: 'Lead',
      teamName: 'Dev',
      teammates,
      routingRules: 'route to @Bug Fixer Boo for bugs',
    })
    expect(result).toContain('### Workspace Isolation')
    expect(result).toMatch(/own isolated workspace/i)
    expect(result).toMatch(/CANNOT\s+read their files/i)
  })

  it('points agents at `cat ~/CLAWBOO.md` for detailed reference', () => {
    const result = buildTeamAgentsMd({
      agentName: 'Lead',
      teamName: 'Dev',
      teammates,
      routingRules: '',
    })
    expect(result).toContain('cat ~/CLAWBOO.md')
    expect(result).toContain('### Detailed Reference')
  })

  it('demonstrates the "delegate a status request" workaround for file isolation', () => {
    // The workspace-isolation section must include a concrete <delegate>
    // example showing how to ask a teammate for a status update — the
    // production user had to manually prompt the leader to do this.
    const result = buildTeamAgentsMd({
      agentName: 'Lead',
      teamName: 'Dev',
      teammates,
      routingRules: '',
    })
    expect(result).toMatch(/<delegate to="@Bug Fixer Boo">[\s\S]*summary[\s\S]*<\/delegate>/i)
  })
})

// ─── buildSelfDocumentingRelayHeader ───────────────────────────────────────

describe('buildSelfDocumentingRelayHeader', () => {
  it('starts with the [Team Update] prefix', () => {
    const result = buildSelfDocumentingRelayHeader({ fromAgentName: 'Bug Fixer Boo' })
    expect(result.startsWith('[Team Update]')).toBe(true)
  })

  it('includes "not a fresh user message" anti-confusion hint', () => {
    const result = buildSelfDocumentingRelayHeader({ fromAgentName: 'Bug Fixer Boo' })
    expect(result).toContain('not a fresh user message')
  })

  it('tells the recipient to continue their own work using the update as context', () => {
    const result = buildSelfDocumentingRelayHeader({ fromAgentName: 'Agent' })
    expect(result).toContain('Continue your own work using this update as context')
  })

  it('inlines truncated task context when provided', () => {
    const result = buildSelfDocumentingRelayHeader({
      fromAgentName: 'Agent',
      taskContext: 'investigate the auth module',
    })
    expect(result).toContain('(re: "investigate the auth module")')
  })

  it('truncates long task context to 80 chars', () => {
    const longContext = 'A'.repeat(120)
    const result = buildSelfDocumentingRelayHeader({
      fromAgentName: 'Agent',
      taskContext: longContext,
    })
    expect(result).toContain('(re: "' + 'A'.repeat(80) + '...")')
  })
})
