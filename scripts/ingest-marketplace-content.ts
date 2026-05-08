#!/usr/bin/env tsx
/**
 * Marketplace content ingestion script.
 *
 * Fetches all 162 agent .md files from agency-agents (MIT) at a pinned commit
 * and generates committed TypeScript files in apps/web/src/features/marketplace/agents/.
 *
 * Source repo: https://github.com/msitarzewski/agency-agents
 * Pinned commit: 64eee9f8e04f69b04e78e150d771a443c64720be
 *
 * Usage: pnpm ingest:marketplace
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import {
  AGENCY_AGENTS_SHA,
  AWESOME_OPENCLAW_SHA,
  TARGET_DOMAINS,
  type AgencyDomain,
  type AwesomeOpenclawAgent,
  type ProcessedAgent,
  fetchAgentTree,
  filterAgentFiles,
  fetchRawFile,
  pLimit,
  processAgentFile,
  processUsecaseFile,
  renderDomainFile,
  renderAgencyIndex,
  renderAwesomeOpenclawFile,
  renderAwesomeOpenclawIndex,
  fetchAwesomeOpenclawTree,
  filterUsecaseFiles,
  fetchAwesomeOpenclawRawFile,
  domainFilePath,
  agencyIndexPath,
  agentsIndexPath,
  awesomeOpenclawFilePath,
  awesomeOpenclawIndexPath,
  AGENTS_DIR,
  AGENCY_DIR,
  AWESOME_OPENCLAW_DIR,
  TEAMS_DIR,
  WORKFLOW_TEAM_CONFIGS,
  fetchAgencyExampleFile,
  workflowAgentIds,
  verifyWorkflowMap,
  renderAgencyWorkflowsFile,
  groupAwesomeByUsecase,
  renderAwesomeOpenclawTeamsFile,
  generateSyntheticTeams,
  renderSyntheticTeamsFile,
  agencyWorkflowsTeamPath,
  awesomeOpenclawTeamsPath,
  syntheticTeamsPath,
} from './lib/ingest-helpers.js'

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`\n🦞 Clawboo marketplace ingestion`)
  console.log(`   Agency source:  github.com/msitarzewski/agency-agents`)
  console.log(`   Agency commit:  ${AGENCY_AGENTS_SHA}`)
  console.log(`   Awesome source: github.com/hesamsheikh/awesome-openclaw-usecases`)
  console.log(`   Awesome commit: ${AWESOME_OPENCLAW_SHA}\n`)

  // 1. Fetch the git tree
  console.log('Fetching git tree...')
  const tree = await fetchAgentTree()
  const agentFiles = filterAgentFiles(tree)
  console.log(
    `Found ${agentFiles.length} agent .md files across ${TARGET_DOMAINS.length} domains\n`,
  )

  // 2. Fetch all raw files with concurrency=10
  console.log('Fetching raw file content (concurrency=10)...')
  const fileContents = new Map<string, string>()
  const fetchTasks = agentFiles.map((item) => async () => {
    process.stdout.write('.')
    const content = await fetchRawFile(item.path)
    fileContents.set(item.path, content)
  })
  await pLimit(fetchTasks, 10)
  console.log(`\nFetched ${fileContents.size} files\n`)

  // 3. Process each file
  console.log('Processing agents...')
  const domainAgents = new Map<AgencyDomain, ProcessedAgent[]>()
  for (const domain of TARGET_DOMAINS) {
    domainAgents.set(domain, [])
  }

  for (const [filePath, content] of fileContents) {
    const agent = processAgentFile(filePath, content)
    const domainList = domainAgents.get(agent.domain)
    if (domainList) {
      domainList.push(agent)
    }
  }

  // Sort each domain's agents by id for determinism
  for (const agents of domainAgents.values()) {
    agents.sort((a, b) => a.id.localeCompare(b.id))
  }

  // Log domain summary
  let total = 0
  for (const domain of TARGET_DOMAINS) {
    const agents = domainAgents.get(domain) ?? []
    total += agents.length
    console.log(`  ${domain.padEnd(22)} ${agents.length} agents`)
  }
  console.log(`  ${'TOTAL'.padEnd(22)} ${total} agents\n`)

  // 4. Ensure output directories exist
  await fs.mkdir(AGENTS_DIR, { recursive: true })
  await fs.mkdir(AGENCY_DIR, { recursive: true })
  await fs.mkdir(AWESOME_OPENCLAW_DIR, { recursive: true })

  // 5. Write domain files
  console.log('Writing domain files...')
  const writePromises: Promise<void>[] = []
  for (const domain of TARGET_DOMAINS) {
    const agents = domainAgents.get(domain) ?? []
    const content = renderDomainFile(domain, agents)
    const outPath = domainFilePath(domain)
    writePromises.push(fs.writeFile(outPath, content, 'utf8'))
    console.log(`  Wrote ${path.relative(process.cwd(), outPath)} (${agents.length} entries)`)
  }
  await Promise.all(writePromises)

  // 6. Write agency/index.ts
  const agencyIndex = renderAgencyIndex()
  await fs.writeFile(agencyIndexPath(), agencyIndex, 'utf8')
  console.log(`  Wrote ${path.relative(process.cwd(), agencyIndexPath())}`)

  // ─── Awesome OpenClaw pipeline ──────────────────────────────────────────────
  console.log('\nFetching awesome-openclaw git tree...')
  const awesomeTree = await fetchAwesomeOpenclawTree()
  const usecaseFiles = filterUsecaseFiles(awesomeTree)
  console.log(`Found ${usecaseFiles.length} usecase .md files\n`)

  console.log('Fetching awesome-openclaw raw content (concurrency=10)...')
  const usecaseContents = new Map<string, string>()
  const usecaseFetchTasks = usecaseFiles.map((item) => async () => {
    process.stdout.write('.')
    const content = await fetchAwesomeOpenclawRawFile(item.path)
    usecaseContents.set(item.path, content)
  })
  await pLimit(usecaseFetchTasks, 10)
  console.log(`\nFetched ${usecaseContents.size} files\n`)

  console.log('Processing usecases...')
  const awesomeAgents: AwesomeOpenclawAgent[] = []
  for (const [filePath, content] of usecaseContents) {
    const entries = processUsecaseFile(filePath, content)
    awesomeAgents.push(...entries)
  }
  awesomeAgents.sort((a, b) => a.id.localeCompare(b.id))
  console.log(
    `  Extracted ${awesomeAgents.length} awesome-openclaw agents (${usecaseFiles.length} operators + ${awesomeAgents.length - usecaseFiles.length} named)\n`,
  )

  // Write awesome-openclaw/usecases.ts
  const awesomeFileContent = renderAwesomeOpenclawFile(awesomeAgents)
  await fs.writeFile(awesomeOpenclawFilePath(), awesomeFileContent, 'utf8')
  console.log(
    `  Wrote ${path.relative(process.cwd(), awesomeOpenclawFilePath())} (${awesomeAgents.length} entries)`,
  )

  // Write awesome-openclaw/index.ts
  const awesomeIndex = renderAwesomeOpenclawIndex()
  await fs.writeFile(awesomeOpenclawIndexPath(), awesomeIndex, 'utf8')
  console.log(`  Wrote ${path.relative(process.cwd(), awesomeOpenclawIndexPath())}`)

  // 7. Write agents/index.ts (imports from all three sources)
  const agentsIndex = renderAgentsIndex()
  await fs.writeFile(agentsIndexPath(), agentsIndex, 'utf8')
  console.log(`  Wrote ${path.relative(process.cwd(), agentsIndexPath())}`)

  // ─── Team file generation ──────────────────────────────────────────────────
  console.log('\nBuilding teams...')
  await fs.mkdir(TEAMS_DIR, { recursive: true })

  // Build agent name lookup across all sources so routing can use display names.
  const agentNameById = new Map<string, string>()
  for (const agents of domainAgents.values()) {
    for (const a of agents) agentNameById.set(a.id, a.name)
  }
  for (const a of awesomeAgents) agentNameById.set(a.id, a.name)

  // 8. Fetch workflow example bodies + emit teams/agency-workflows.ts
  console.log('Fetching agency workflow examples...')
  const workflowBodies = new Map<string, string>()
  const workflowFetchTasks = WORKFLOW_TEAM_CONFIGS.map((cfg) => async () => {
    process.stdout.write('.')
    try {
      const body = await fetchAgencyExampleFile(cfg.filename)
      workflowBodies.set(cfg.filename, body)
    } catch (err) {
      console.warn(`\n[workflow] failed to fetch ${cfg.filename}: ${(err as Error).message}`)
    }
  })
  await pLimit(workflowFetchTasks, 5)
  console.log(`\nFetched ${workflowBodies.size} workflow examples`)

  verifyWorkflowMap(WORKFLOW_TEAM_CONFIGS, workflowBodies, agentNameById)

  const agencyWorkflowsContent = renderAgencyWorkflowsFile(
    WORKFLOW_TEAM_CONFIGS,
    workflowBodies,
    agentNameById,
  )
  await fs.writeFile(agencyWorkflowsTeamPath(), agencyWorkflowsContent, 'utf8')
  console.log(
    `  Wrote ${path.relative(process.cwd(), agencyWorkflowsTeamPath())} (${WORKFLOW_TEAM_CONFIGS.length} teams)`,
  )

  // 9. Group awesome-openclaw agents by usecase + emit teams/awesome-openclaw.ts
  const awesomeGroups = groupAwesomeByUsecase(awesomeAgents)
  const awesomeTeamsContent = renderAwesomeOpenclawTeamsFile(awesomeGroups)
  await fs.writeFile(awesomeOpenclawTeamsPath(), awesomeTeamsContent, 'utf8')
  console.log(
    `  Wrote ${path.relative(process.cwd(), awesomeOpenclawTeamsPath())} (${awesomeGroups.size} teams)`,
  )

  // 10. Generate synthetic excellence teams from uncovered agency agents
  const excludeIds = workflowAgentIds()
  const syntheticTeams = generateSyntheticTeams(domainAgents, excludeIds)
  const syntheticContent = renderSyntheticTeamsFile(syntheticTeams)
  await fs.writeFile(syntheticTeamsPath(), syntheticContent, 'utf8')
  console.log(
    `  Wrote ${path.relative(process.cwd(), syntheticTeamsPath())} (${syntheticTeams.length} teams)`,
  )

  const grandTotal = total + awesomeAgents.length
  const teamTotal = WORKFLOW_TEAM_CONFIGS.length + awesomeGroups.size + syntheticTeams.length
  console.log(
    `\n✅ Done — ${grandTotal} agents + ${teamTotal} teams written (${total} agency + ${awesomeAgents.length} awesome-openclaw; clawboo 15 agents + 5 teams hand-written separately)\n`,
  )
}

function renderAgentsIndex(): string {
  return `// AUTO-GENERATED — do not edit manually.
// Regenerate: pnpm ingest:marketplace

import type { AgentCatalogEntry, AgentDomain, TemplateSource } from '@/features/teams/types'
import { AGENCY_AGENTS } from './agency'
import { AWESOME_OPENCLAW_AGENTS } from './awesome-openclaw'
import { CLAWBOO_AGENTS } from './clawboo'

export { AGENCY_AGENTS } from './agency'
export { AWESOME_OPENCLAW_AGENTS } from './awesome-openclaw'
export { CLAWBOO_AGENTS } from './clawboo'

/** All agents in the catalog — agency-agents + awesome-openclaw + clawboo builtins. */
export const AGENT_CATALOG: AgentCatalogEntry[] = [
  ...AGENCY_AGENTS,
  ...AWESOME_OPENCLAW_AGENTS,
  ...CLAWBOO_AGENTS,
]

/** Look up an agent by ID. */
export function getAgent(id: string): AgentCatalogEntry | undefined {
  return AGENT_CATALOG.find((a) => a.id === id)
}

/** Get all agents for a given domain. */
export function getAgentsByDomain(domain: AgentDomain): AgentCatalogEntry[] {
  return AGENT_CATALOG.filter((a) => a.domain === domain)
}

/** Get all agents from a given source. */
export function getAgentsBySource(source: TemplateSource): AgentCatalogEntry[] {
  return AGENT_CATALOG.filter((a) => a.source === source)
}

/**
 * Search agents by query — matches name, role, description, tags (case-insensitive).
 */
export function searchAgentCatalog(query: string): AgentCatalogEntry[] {
  if (!query.trim()) return AGENT_CATALOG
  const q = query.toLowerCase()
  return AGENT_CATALOG.filter(
    (a) =>
      a.name.toLowerCase().includes(q) ||
      a.role.toLowerCase().includes(q) ||
      a.description.toLowerCase().includes(q) ||
      a.tags.some((t) => t.includes(q)),
  )
}
`
}

main().catch((err) => {
  console.error('\n❌ Ingestion failed:', err)
  process.exit(1)
})
