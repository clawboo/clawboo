import type { ParsedBinding } from '../types'

// ─── Patterns ─────────────────────────────────────────────────────────────────

// @mention syntax: @agent-name or @"agent name"
const AT_MENTION_RE = /@["']?([\w][\w ._-]{0,60})["']?/g

// Routing verbs followed by an agent reference (optional @ before name)
const ROUTE_VERB_RE =
  /(?:route|forward|delegate|send|handoff|transfer|ask|call|use|ping|notify)\s+(?:to\s+)?@?["']?([\w][\w ._-]{1,60})["']?/gi

// ─── Resolution ──────────────────────────────────────────────────────────────

/**
 * Given a raw (possibly over-greedy) capture like "Doc Writer Boo for delegated
 * tasks", find the longest known agent name that matches a prefix.
 *
 * Returns the canonical name or null if no match.
 */
function resolveAgentName(rawCapture: string, knownNames: string[]): string | null {
  const lower = rawCapture.toLowerCase().trim()
  if (!lower) return null

  let best: string | null = null
  let bestLen = 0

  for (const name of knownNames) {
    const trimmed = name.trim()
    if (!trimmed) continue
    const nameLower = trimmed.toLowerCase()

    if (lower === nameLower) {
      // Exact match — always wins
      return trimmed
    }

    // Prefix match: name must be followed by a non-word char (space, period, etc.)
    if (
      lower.startsWith(nameLower) &&
      nameLower.length < lower.length &&
      !/\w/.test(lower[nameLower.length]!)
    ) {
      if (nameLower.length > bestLen) {
        best = trimmed
        bestLen = nameLower.length
      }
    }
  }

  return best
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
 * Two detection passes with name resolution:
 *   - Pass 1: `@agent-name` mentions — greedy capture resolved against known names.
 *   - Pass 2: Routing verbs ("route to @AgentName") — handles optional `@`, then
 *             resolves the greedy capture against known names.
 *
 * Does NOT do loose name matching against the entire file content. The Gateway
 * provides a large default AGENTS.md template containing common English words
 * (e.g. "main session") which would false-positive against agents with common
 * names like "main".
 *
 * @param content          Raw AGENTS.md text for the source agent.
 * @param knownAgentNames  Names of all agents currently in the fleet (excludes self).
 */
export function parseAgentsMd(content: string, knownAgentNames: string[]): ParsedBinding[] {
  const bindings: ParsedBinding[] = []

  // Pass 1: @mention patterns — resolve greedy captures
  for (const match of content.matchAll(AT_MENTION_RE)) {
    const raw = (match[1] ?? '').trim()
    if (!raw) continue
    const resolved = resolveAgentName(raw, knownAgentNames)
    if (resolved) {
      bindings.push({ targetAgentName: resolved })
    }
  }

  // Pass 2: routing verb + agent name patterns — resolve greedy captures
  for (const match of content.matchAll(ROUTE_VERB_RE)) {
    const raw = (match[1] ?? '').trim()
    if (!raw) continue
    const resolved = resolveAgentName(raw, knownAgentNames)
    if (resolved) {
      bindings.push({ targetAgentName: resolved })
    }
  }

  return dedupeBindings(bindings)
}
