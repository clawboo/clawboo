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
  TARGET_DOMAINS,
  type AgencyDomain,
  type ProcessedAgent,
  fetchAgentTree,
  filterAgentFiles,
  fetchRawFile,
  pLimit,
  processAgentFile,
  renderDomainFile,
  renderAgencyIndex,
  domainFilePath,
  agencyIndexPath,
  agentsIndexPath,
  AGENTS_DIR,
  AGENCY_DIR,
} from './lib/ingest-helpers.js'

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`\n🦞 Clawboo marketplace ingestion`)
  console.log(`   Source: github.com/msitarzewski/agency-agents`)
  console.log(`   Commit: ${AGENCY_AGENTS_SHA}\n`)

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

  // 7. Write agents/index.ts
  const agentsIndex = renderAgentsIndex()
  await fs.writeFile(agentsIndexPath(), agentsIndex, 'utf8')
  console.log(`  Wrote ${path.relative(process.cwd(), agentsIndexPath())}`)

  console.log(`\n✅ Done — ${total} agents written to apps/web/src/features/marketplace/agents/\n`)
}

function renderAgentsIndex(): string {
  return `// AUTO-GENERATED — do not edit manually.
// Regenerate: pnpm ingest:marketplace

import type { AgentCatalogEntry } from '@/features/teams/types'
import type { AgentDomain, TemplateSource } from '@/features/teams/types'
import { AGENCY_AGENTS } from './agency'

export { AGENCY_AGENTS } from './agency'

/** All agents in the catalog. Sessions 2+ will append awesome-openclaw + clawboo entries. */
export const AGENT_CATALOG: AgentCatalogEntry[] = [...AGENCY_AGENTS]

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
