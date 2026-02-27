import type { ParsedBinding } from '../types'

// ─── Patterns ─────────────────────────────────────────────────────────────────

// @mention syntax: @agent-name or @"agent name"
const AT_MENTION_RE = /@["']?([\w][\w ._-]{0,60})["']?/g

// Routing verbs followed by an agent reference
const ROUTE_VERB_RE =
  /(?:route|forward|delegate|send|handoff|transfer|ask|call|use|ping|notify)\s+(?:to\s+)?["']?([\w][\w ._-]{1,60})["']?/gi

// Escape a string for use in a RegExp
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// ─── Deduplication ────────────────────────────────────────────────────────────

function dedupeBindings(bindings: ParsedBinding[]): ParsedBinding[] {
  const seen = new Set<string>()
  const result: ParsedBinding[] = []
  for (const b of bindings) {
    const key = b.targetAgentName.toLowerCase().trim()
    if (!key || seen.has(key)) continue
    seen.add(key)
    result.push(b)
  }
  return result
}

// ─── Parser ───────────────────────────────────────────────────────────────────

/**
 * Parse AGENTS.md content for references to other agents.
 *
 * @param content   Raw AGENTS.md text for the source agent.
 * @param knownAgentNames  Names of all agents currently in the fleet (excludes self).
 */
export function parseAgentsMd(content: string, knownAgentNames: string[]): ParsedBinding[] {
  const bindings: ParsedBinding[] = []

  // Pass 1: @mention patterns
  for (const match of content.matchAll(AT_MENTION_RE)) {
    const name = (match[1] ?? '').trim()
    if (name) bindings.push({ targetAgentName: name })
  }

  // Pass 2: routing verb + agent name patterns
  for (const match of content.matchAll(ROUTE_VERB_RE)) {
    const name = (match[1] ?? '').trim()
    if (name) bindings.push({ targetAgentName: name })
  }

  // Pass 3: exact match of known agent names anywhere in the file
  for (const agentName of knownAgentNames) {
    const trimmed = agentName.trim()
    if (!trimmed) continue
    const re = new RegExp(`\\b${escapeRe(trimmed)}\\b`, 'i')
    if (re.test(content)) {
      bindings.push({ targetAgentName: trimmed })
    }
  }

  return dedupeBindings(bindings)
}
