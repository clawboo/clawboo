import { describe, it, expect } from 'vitest'
import {
  buildTeamBrief,
  buildGlobalBrief,
  type TeamBriefMember,
  type GlobalBriefTeam,
} from '../booZeroBrief'

describe('buildTeamBrief', () => {
  const baseTeam = {
    name: 'Dev Team',
    icon: '👾',
    templateId: 'dev',
    description: 'Code review, bug hunting, documentation.',
  }
  const members: TeamBriefMember[] = [
    {
      name: 'Code Reviewer Boo',
      role: 'Code Reviewer',
      strengths: 'Spots logic errors and security issues.',
      tools: ['github', 'code-search'],
    },
    {
      name: 'Bug Fixer Boo',
      role: 'Bug Fixer',
      strengths: 'Root-cause analysis and targeted fixes.',
      tools: ['github', 'code-search', 'test-runner'],
    },
    {
      name: 'Doc Writer Boo',
      role: 'Doc Writer',
      strengths: 'Clear technical writing.',
      tools: ['github', 'computer'],
    },
  ]

  it('renders header, identity, members, internal lead, routing, tools, anti-patterns, notes', () => {
    const out = buildTeamBrief({ team: baseTeam, members })
    expect(out).toContain('# Team: Dev Team 👾')
    expect(out).toContain('## Identity\nCode review, bug hunting, documentation.')
    expect(out).toContain('## Members')
    expect(out).toContain('| Code Reviewer Boo | Code Reviewer |')
    expect(out).toContain('## Internal Lead')
    expect(out).toContain('Boo Zero leads the team directly.')
    expect(out).toContain('## Routing patterns')
    expect(out).toContain('## Aggregated tools')
    expect(out).toContain('## Anti-patterns')
    expect(out).toContain('## Notes')
  })

  it('falls back to templateId line when description is empty', () => {
    const out = buildTeamBrief({
      team: { ...baseTeam, description: '' },
      members,
    })
    expect(out).toContain('Deployed from template `dev`.')
  })

  it('says "no description recorded" when both description and templateId are absent', () => {
    const out = buildTeamBrief({
      team: { name: 'Empty', icon: '🎈', templateId: null, description: null },
      members,
    })
    expect(out).toContain('No description recorded.')
  })

  it('handles internal lead — surfaces matched keyword', () => {
    const out = buildTeamBrief({
      team: baseTeam,
      members,
      internalLead: { agentName: 'Code Reviewer Boo', matchedKeyword: 'Tech Lead' },
    })
    expect(out).toContain(
      '**Code Reviewer Boo** — detected via the leadership keyword "Tech Lead".',
    )
    // Routing patterns should reference the lead
    expect(out).toContain('**Code Reviewer Boo** (internal lead) coordinates intake')
  })

  it('renders "no members" placeholder when team is empty', () => {
    const out = buildTeamBrief({ team: baseTeam, members: [] })
    expect(out).toContain('_No members yet. Boo Zero will respond solo')
    expect(out).toContain('_No tools recorded yet._')
  })

  it('escapes pipe characters in member strengths', () => {
    const out = buildTeamBrief({
      team: baseTeam,
      members: [
        {
          name: 'Markdown Boo',
          role: 'Tester',
          strengths: 'Handles pipes | in strings | gracefully',
          tools: [],
        },
      ],
    })
    expect(out).toContain('| Markdown Boo | Tester | Handles pipes \\| in strings \\| gracefully |')
  })

  it('deduplicates and sorts aggregated tools', () => {
    const out = buildTeamBrief({ team: baseTeam, members })
    // github appears in all three, code-search in two, test-runner once, computer once
    const toolsSection = out.split('## Aggregated tools')[1]!.split('## Anti-patterns')[0]!
    expect(toolsSection).toContain('- code-search')
    expect(toolsSection).toContain('- computer')
    expect(toolsSection).toContain('- github')
    expect(toolsSection).toContain('- test-runner')
    // Sorted alphabetically
    const codeIdx = toolsSection.indexOf('- code-search')
    const githubIdx = toolsSection.indexOf('- github')
    expect(codeIdx).toBeLessThan(githubIdx)
  })

  it('uses default anti-patterns when none provided', () => {
    const out = buildTeamBrief({ team: baseTeam, members })
    expect(out).toContain("Don't ask the team to simulate sub-agents")
    expect(out).toContain("Don't `ls` or `cat`")
  })

  it('uses custom anti-patterns when provided', () => {
    const out = buildTeamBrief({
      team: baseTeam,
      members,
      antiPatterns: ['Custom guardrail 1.', 'Custom guardrail 2.'],
    })
    expect(out).toContain('- Custom guardrail 1.')
    expect(out).toContain('- Custom guardrail 2.')
    expect(out).not.toContain("Don't ask the team to simulate sub-agents")
  })

  it('uses custom routing summary when provided', () => {
    const out = buildTeamBrief({
      team: baseTeam,
      members,
      routingSummary: '- Custom routing line.',
    })
    expect(out).toContain('## Routing patterns\n- Custom routing line.')
  })

  it('produces deterministic output for snapshot stability', () => {
    const out1 = buildTeamBrief({ team: baseTeam, members })
    const out2 = buildTeamBrief({ team: baseTeam, members })
    expect(out1).toBe(out2)
  })
})

describe('buildGlobalBrief', () => {
  const teams: GlobalBriefTeam[] = [
    { name: 'Dev Team', icon: '👾', description: 'Code review and bug hunting.' },
    { name: 'Marketing Boos', icon: '📣', description: 'Content + campaigns.' },
  ]

  it('renders role, responsibilities, teams index, delegation protocol, mention syntax, pitfalls, notes', () => {
    const out = buildGlobalBrief({ teams })
    expect(out).toContain('# Boo Zero — Universal Team Leader')
    expect(out).toContain('## Role')
    // Phase C: prompt is now written in second-person ("You are…") and uses
    // imperative DO / DO NOT lists instead of first-person responsibilities.
    expect(out).toContain('You are the universal leader')
    expect(out).toContain('## Required behavior')
    expect(out).toContain('**DO**')
    expect(out).toContain('**DO NOT**')
    expect(out).toContain('## Verification protocol')
    expect(out).toContain('## Available teams')
    expect(out).toContain('- **Dev Team** 👾: Code review and bug hunting.')
    expect(out).toContain('- **Marketing Boos** 📣: Content + campaigns.')
    expect(out).toContain('## Delegation protocol')
    expect(out).toContain('<delegate to="@Teammate Name">')
    expect(out).toContain('## @-mention syntax in my individual chat')
    expect(out).toContain('`@TeamName`')
    expect(out).toContain('## Common pitfalls')
    expect(out).toContain('## Notes')
  })

  it('renders "no teams deployed" placeholder when empty', () => {
    const out = buildGlobalBrief({ teams: [] })
    expect(out).toContain('_No teams deployed yet.')
  })

  it('uses "No description." when team description is missing', () => {
    const out = buildGlobalBrief({
      teams: [{ name: 'Mystery', icon: '🎃' }],
    })
    expect(out).toContain('- **Mystery** 🎃: No description.')
  })

  it('collapses newlines in team descriptions to single spaces', () => {
    const out = buildGlobalBrief({
      teams: [{ name: 'Multi', icon: '🌀', description: 'Line one.\n\nLine two.' }],
    })
    expect(out).toContain('- **Multi** 🌀: Line one. Line two.')
  })

  it('produces deterministic output', () => {
    const a = buildGlobalBrief({ teams })
    const b = buildGlobalBrief({ teams })
    expect(a).toBe(b)
  })
})
