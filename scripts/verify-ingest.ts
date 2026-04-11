#!/usr/bin/env tsx
/**
 * Verify that committed agent catalog files are up to date with the source repos.
 *
 * Regenerates all auto-generated content in-memory and diffs against committed files.
 * Exits 0 if all files match; exits 1 if any file is out of date.
 *
 * Covers both agency-agents and awesome-openclaw pipelines, plus the combined
 * agents/index.ts shell. Does NOT check `clawboo/builtin.ts` or `clawboo/index.ts`
 * because those are hand-written (extracted once from templates/builtin/*.ts).
 *
 * Usage: pnpm verify:ingest
 */

import * as fs from 'node:fs/promises'
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
} from './lib/ingest-helpers.js'

// ─── agents/index.ts renderer (duplicated from ingest script for shared use) ─
// Must match scripts/ingest-marketplace-content.ts `renderAgentsIndex()` exactly.

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

// ─── Diff utility ─────────────────────────────────────────────────────────────

function shortDiff(expected: string, actual: string): string {
  const expectedLines = expected.split('\n')
  const actualLines = actual.split('\n')
  const diffs: string[] = []

  const maxLines = Math.max(expectedLines.length, actualLines.length)
  for (let i = 0; i < maxLines && diffs.length < 20; i++) {
    const exp = expectedLines[i] ?? '(missing)'
    const act = actualLines[i] ?? '(missing)'
    if (exp !== act) {
      diffs.push(`  Line ${i + 1}:`)
      diffs.push(`  - expected: ${exp.slice(0, 120)}`)
      diffs.push(`  + actual:   ${act.slice(0, 120)}`)
    }
  }
  return diffs.join('\n')
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`\n🔍 Clawboo marketplace verify-ingest (dry-run)`)
  console.log(`   Agency commit:  ${AGENCY_AGENTS_SHA}`)
  console.log(`   Awesome commit: ${AWESOME_OPENCLAW_SHA}\n`)

  // ─── Agency pipeline ───────────────────────────────────────────────────────
  console.log('Fetching agency git tree...')
  const tree = await fetchAgentTree()
  const agentFiles = filterAgentFiles(tree)
  console.log(`Found ${agentFiles.length} agent files\n`)

  console.log('Fetching agency raw file content...')
  const fileContents = new Map<string, string>()
  const fetchTasks = agentFiles.map((item) => async () => {
    process.stdout.write('.')
    const content = await fetchRawFile(item.path)
    fileContents.set(item.path, content)
  })
  await pLimit(fetchTasks, 10)
  console.log(`\nFetched ${fileContents.size} files\n`)

  const domainAgents = new Map<AgencyDomain, ProcessedAgent[]>()
  for (const domain of TARGET_DOMAINS) {
    domainAgents.set(domain, [])
  }
  for (const [filePath, content] of fileContents) {
    const agent = processAgentFile(filePath, content)
    domainAgents.get(agent.domain)?.push(agent)
  }
  for (const agents of domainAgents.values()) {
    agents.sort((a, b) => a.id.localeCompare(b.id))
  }

  // ─── Awesome-openclaw pipeline ─────────────────────────────────────────────
  console.log('Fetching awesome-openclaw git tree...')
  const awesomeTree = await fetchAwesomeOpenclawTree()
  const usecaseFiles = filterUsecaseFiles(awesomeTree)
  console.log(`Found ${usecaseFiles.length} usecase files\n`)

  console.log('Fetching awesome-openclaw raw content...')
  const usecaseContents = new Map<string, string>()
  const usecaseFetchTasks = usecaseFiles.map((item) => async () => {
    process.stdout.write('.')
    const content = await fetchAwesomeOpenclawRawFile(item.path)
    usecaseContents.set(item.path, content)
  })
  await pLimit(usecaseFetchTasks, 10)
  console.log(`\nFetched ${usecaseContents.size} files\n`)

  const awesomeAgents: AwesomeOpenclawAgent[] = []
  for (const [filePath, content] of usecaseContents) {
    const entries = processUsecaseFile(filePath, content)
    awesomeAgents.push(...entries)
  }
  awesomeAgents.sort((a, b) => a.id.localeCompare(b.id))

  // ─── Compare generated vs committed ────────────────────────────────────────
  const filesToCheck: Array<{ label: string; path: string; expected: string }> = []

  for (const domain of TARGET_DOMAINS) {
    const agents = domainAgents.get(domain) ?? []
    filesToCheck.push({
      label: `agency/${domain}.ts`,
      path: domainFilePath(domain),
      expected: renderDomainFile(domain, agents),
    })
  }
  filesToCheck.push({
    label: 'agency/index.ts',
    path: agencyIndexPath(),
    expected: renderAgencyIndex(),
  })
  filesToCheck.push({
    label: 'awesome-openclaw/usecases.ts',
    path: awesomeOpenclawFilePath(),
    expected: renderAwesomeOpenclawFile(awesomeAgents),
  })
  filesToCheck.push({
    label: 'awesome-openclaw/index.ts',
    path: awesomeOpenclawIndexPath(),
    expected: renderAwesomeOpenclawIndex(),
  })
  filesToCheck.push({
    label: 'agents/index.ts',
    path: agentsIndexPath(),
    expected: renderAgentsIndex(),
  })

  const failures: string[] = []
  for (const { label, path: filePath, expected } of filesToCheck) {
    let actual: string
    try {
      actual = await fs.readFile(filePath, 'utf8')
    } catch {
      failures.push(`  ❌ ${label}: FILE MISSING`)
      continue
    }
    if (actual !== expected) {
      failures.push(`  ❌ ${label}: content differs\n${shortDiff(expected, actual)}`)
    } else {
      console.log(`  ✓ ${label}`)
    }
  }

  if (failures.length > 0) {
    console.error('\n\nDrift detected — run `pnpm ingest:marketplace` to regenerate:\n')
    for (const f of failures) {
      console.error(f)
    }
    process.exit(1)
  }

  console.log(`\n✅ All ${filesToCheck.length} agent catalog files are up to date`)
  console.log(`   (clawboo/builtin.ts + clawboo/index.ts are hand-written — not verified)\n`)
}

main().catch((err) => {
  console.error('\n❌ Verify failed:', err)
  process.exit(1)
})
