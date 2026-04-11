// Clawboo built-in agents — extracted from the five hand-authored TeamTemplates
// under templates/builtin/. This file is hand-written (not auto-generated) because
// the source is local TS with path-alias imports and rarely changes.
//
// Session 3 will atomically migrate TEAM_CATALOG to agentIds[] and delete the
// legacy templates/builtin/*.ts files — this file stays as the canonical home
// for the 15 built-in agents.

import type {
  AgentCatalogEntry,
  AgentTemplate,
  TeamTemplate,
  TemplateCategory,
} from '@/features/teams/types'

import { SKILL_CATALOG } from '../../catalog'
import { devTemplate } from '../../templates/builtin/dev'
import { marketingTemplate } from '../../templates/builtin/marketing'
import { researchTemplate } from '../../templates/builtin/research'
import { studentTemplate } from '../../templates/builtin/student'
import { youtubeTemplate } from '../../templates/builtin/youtube'

/** Set of valid catalog skill IDs — used to filter extracted skill bullets. */
const VALID_SKILL_IDS = new Set(SKILL_CATALOG.map((s) => s.id))

/** Convert a display name to a kebab-case slug. */
function slugify(str: string): string {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * Synthesize a full IDENTITY.md manifest combining role + soul + identity + tools
 * + routing under headings. Guarantees zero-loss (all original fields preserved)
 * AND identityTemplate.length > 500 (test invariant).
 */
function synthesizeIdentity(team: TeamTemplate, agent: AgentTemplate): string {
  return [
    `# ${agent.name}`,
    '',
    `Part of the ${team.name} team (${team.emoji}).`,
    '',
    '## Role',
    agent.role,
    '',
    '## Soul',
    agent.soulTemplate,
    '',
    '## Identity',
    agent.identityTemplate,
    '',
    '## Tools',
    agent.toolsTemplate,
    '',
    '## Routing',
    agent.agentsTemplate ?? '(no routing)',
  ].join('\n')
}

/**
 * Extract skill IDs from a TOOLS.md-style body. Looks for bullet lines under
 * `## Skills` and returns the kebab-case skill IDs. Best-effort — empty array
 * is acceptable per spec.
 */
function extractSkillIds(toolsTemplate: string): string[] {
  const lines = toolsTemplate.split('\n')
  const skills: string[] = []
  let inSkills = false
  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (/^##\s+Skills\b/i.test(line)) {
      inSkills = true
      continue
    }
    if (inSkills && line.startsWith('##')) break
    if (inSkills && line.startsWith('-')) {
      const skill = line.replace(/^-\s*/, '').trim()
      // Only keep bullets that correspond to real catalog skill IDs — drops
      // freeform entries like "github" or "terminal access" that don't match
      // any known SKILL_CATALOG id. Empty arrays are acceptable per spec.
      if (skill && VALID_SKILL_IDS.has(skill)) skills.push(skill)
    }
  }
  return skills
}

/**
 * Convert an inline AgentTemplate into a first-class AgentCatalogEntry.
 * - id: `clawboo-<teamId>-<slugify(agentName)>`
 * - name/role/soulTemplate/toolsTemplate/agentsTemplate preserved verbatim
 * - identityTemplate synthesized via synthesizeIdentity() for zero-loss + length guarantee
 */
function fromInlineAgent(team: TeamTemplate, agent: AgentTemplate): AgentCatalogEntry {
  const id = `clawboo-${team.id}-${slugify(agent.name)}`
  const skillIds = extractSkillIds(agent.toolsTemplate)
  const description = `${agent.role} on the ${team.name} — ${team.description}`

  return {
    id,
    name: agent.name,
    role: agent.role,
    emoji: team.emoji,
    color: team.color,
    description: description.length > 200 ? description.slice(0, 197) + '...' : description,
    source: 'clawboo',
    sourceUrl: '',
    domain: 'clawboo',
    category: team.category as TemplateCategory,
    tags: ['clawboo', team.id, ...team.tags.slice(0, 4)],
    skillIds,
    soulTemplate: agent.soulTemplate,
    identityTemplate: synthesizeIdentity(team, agent),
    toolsTemplate: agent.toolsTemplate,
    agentsTemplate: agent.agentsTemplate,
  }
}

const BUILTIN_TEMPLATES: TeamTemplate[] = [
  devTemplate,
  marketingTemplate,
  researchTemplate,
  studentTemplate,
  youtubeTemplate,
]

/** 15 first-class clawboo built-in agents (5 teams x 3 agents each). */
export const CLAWBOO_BUILTIN_AGENTS: AgentCatalogEntry[] = BUILTIN_TEMPLATES.flatMap((team) =>
  team.agents.map((agent) => fromInlineAgent(team, agent)),
).sort((a, b) => a.id.localeCompare(b.id))
