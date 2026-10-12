// The team lead's roster: what each teammate does, not only what it is called.
//
// Boo Zero routes every delegation by teammate name, so with a names-only roster
// it could only guess a teammate's specialty from its name. On the lead's turn
// each teammate's line also carries its runtime and a one-line role read from its
// SOUL.md, the persona clawboo already stores:
//   - clawboo-native: `native-agent-file:<id>:SOUL.md`, else the stored
//     AgentConfig.systemPrompt (the same fallback the SOUL tab uses);
//   - codex, claude-code, hermes: `runtime-agent-file:<id>:SOUL.md`;
//   - openclaw: its files live on the Gateway, so it gets its runtime only.
// The catalog's `role` label is not used: it repeats the agent's name for nearly
// every catalog agent, and a deployed agent keeps no link back to its entry.
//
// Synchronous KV point reads, because buildServerTeamContext is synchronous. The
// block rides every lead turn in the volatile tier, so it is bounded.

import { DEFAULT_AGENT_CONFIG } from '@clawboo/adapter-native'
import type { ClawbooDb } from '@clawboo/db'

import { readRuntimeAgentFile } from '../agentSource/runtimeAgentFileStore'
import { loadAgentConfig, readNativeAgentFile } from '../runtimes/native/agentConfigStore'

export const ROSTER_LINE_MAX_CHARS = 100
export const ROSTER_BLOCK_MAX_CHARS = 1200
export const LEADER_ROSTER_HEADER =
  'Your teammates on this team (delegate by the name at the start of each line):'

/** A clipped role shorter than this says nothing, so the line keeps none. */
const ROLE_MIN_CHARS = 16

/** Where the Personality sliders' block starts. Mirrors
 *  apps/web/src/lib/soulPersonality.ts, which the server cannot import, and also
 *  matches its `-custom` variant. Everything after it is tone, not role. */
const PERSONALITY_MARKER = '<!-- clawboo:personality'

const RUNTIME_LABELS: Record<string, string> = {
  'clawboo-native': 'Clawboo Native',
  openclaw: 'OpenClaw',
  codex: 'Codex',
  'claude-code': 'Claude Code',
  hermes: 'Hermes',
}

/** Runtimes whose SOUL.md clawboo keeps in the runtime agent-file store. */
const RUNTIME_FILE_RUNTIMES = new Set(['codex', 'claude-code', 'hermes'])

export interface RosterMate {
  name: string
  runtime: string | null
  role: string | null
}

/** One line of plain text. Markdown emphasis and links are dropped, and brackets
 *  become parentheses so authored text cannot fake one of our `[Section]` markers. */
function plain(text: string): string {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*\*|__|[*`]/g, '')
    .replace(/\[/g, '(')
    .replace(/\]/g, ')')
    .replace(/\s+/g, ' ')
    .trim()
}

/** The first paragraph in `lines` (headings, comments and rules skipped). A list
 *  counts as its first item only. */
function firstParagraph(lines: readonly string[]): string | null {
  const out: string[] = []
  for (const raw of lines) {
    const line = raw.trim()
    const skippable = /^#/.test(line) || line.startsWith('<!--') || /^(?:-{3,}|\*{3,})$/.test(line)
    if (out.length === 0) {
      if (!line || skippable) continue
      if (/^[-*+]\s/.test(line)) return line.replace(/^[-*+]\s+/, '')
      out.push(line)
      continue
    }
    if (!line || skippable || /^[-*+]\s/.test(line)) break
    out.push(line)
  }
  return out.length > 0 ? out.join(' ') : null
}

/**
 * The one-line role a SOUL.md states, or null when it states none. Tried in
 * order: a `- **Role**:` bullet, the first paragraph under a Role or Mission
 * heading, the first prose paragraph. Null too when the role only repeats `name`.
 */
export function extractRoleSummary(soul: string, name?: string): string | null {
  const body = soul.replace(/\r\n?/g, '\n').split(PERSONALITY_MARKER)[0] ?? ''
  const lines = body.split('\n')
  let found = body.match(/^\s*[-*]\s*\*\*Role\*\*\s*:\s*(.+)$/im)?.[1] ?? null
  if (!found) {
    const at = lines.findIndex((l) => /^#{1,6}\s.*\b(?:role|mission)\b/i.test(l))
    if (at >= 0) found = firstParagraph(lines.slice(at + 1))
  }
  found ??= firstParagraph(lines)
  if (!found) return null
  const role = plain(found)
    .replace(/^you are\s+(?:an?\s+)?/i, '')
    .trim()
  if (!role) return null
  const bare = role.replace(/[.\s]+$/, '').toLowerCase()
  if (name && name.toLowerCase().startsWith(bare)) return null
  return role
}

/** A teammate's role from its own SOUL.md, or null (OpenClaw, no persona, the
 *  shipped default prompt, or a read that failed). */
export function readTeammateRole(
  db: ClawbooDb,
  mate: { id: string; name: string; runtime: string | null },
): string | null {
  try {
    let soul = ''
    if (mate.runtime === 'clawboo-native') {
      soul =
        readNativeAgentFile(db, mate.id, 'SOUL.md') ||
        loadAgentConfig(db, mate.id)?.systemPrompt ||
        ''
      if (soul.trim() === DEFAULT_AGENT_CONFIG.systemPrompt.trim()) return null
    } else if (mate.runtime && RUNTIME_FILE_RUNTIMES.has(mate.runtime)) {
      soul = readRuntimeAgentFile(db, mate.id, 'SOUL.md')
    }
    return soul.trim() ? extractRoleSummary(soul, mate.name) : null
  } catch {
    // A roster line without a role beats a lead turn that fails to build.
    return null
  }
}

function rosterLine(mate: RosterMate, withRole: boolean): string {
  const label = mate.runtime ? RUNTIME_LABELS[mate.runtime] : undefined
  const head = `- ${mate.name}${label ? ` (${label})` : ''}`
  if (!withRole || !mate.role) return head
  const full = `${head}: ${mate.role}`
  if (full.length <= ROSTER_LINE_MAX_CHARS) return full
  const room = ROSTER_LINE_MAX_CHARS - head.length - 3 // ": " plus the ellipsis
  if (room < ROLE_MIN_CHARS) return head
  const clipped = mate.role
    .slice(0, room)
    .replace(/[\uD800-\uDBFF]$/, '')
    .trimEnd()
  return `${head}: ${clipped}…`
}

/**
 * The lead's roster block, within ROSTER_BLOCK_MAX_CHARS. Roles are dropped from
 * the bottom up until it fits. Null when even the lines without roles overflow,
 * so the caller falls back to the names line and no teammate is ever dropped.
 */
export function formatLeaderRoster(mates: readonly RosterMate[]): string | null {
  if (mates.length === 0) return null
  const withRole = mates.map(() => true)
  const render = (): string =>
    [LEADER_ROSTER_HEADER, ...mates.map((m, i) => rosterLine(m, withRole[i]!))].join('\n')
  let block = render()
  for (let i = mates.length - 1; block.length > ROSTER_BLOCK_MAX_CHARS && i >= 0; i--) {
    withRole[i] = false
    block = render()
  }
  return block.length <= ROSTER_BLOCK_MAX_CHARS ? block : null
}
