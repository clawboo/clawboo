// Team Rules — user-captured rules persisted per-team and injected into the
// preamble of every team-chat message + every agent-to-agent delegation.
//
// Why this exists
// ---------------
// The user's corrections ("they are not sub agents", "don't do work
// yourself") sit only in chat history. After a long gap they're outside
// the last-8-messages window in `buildTeamContextPreamble` and effectively
// gone. Without a durable persistence layer, the user has to repeat the
// same correction every session — and the team makes the same mistake.
//
// Source of truth: SQLite settings row keyed `team-rules:<teamId>`.
// Editable from two places:
//   1. The Boo Zero brief panel ("Team Rules" textarea) — Maintenance view.
//   2. The team chat composer slash command `/rule <text>` — appends a
//      line to the team's rules in one click.

const CACHE_TTL_MS = 5_000

interface CacheEntry {
  content: string
  fetchedAt: number
}

const cache = new Map<string, CacheEntry>()

/**
 * Parse a draft message for the `/rule` slash command. Returns the rule
 * text (sans the `/rule ` prefix) when matched; otherwise `null`. The
 * prefix MUST be followed by whitespace + non-empty body to avoid
 * misfiring on `/rule` alone or on `/ruleX`.
 */
export function parseRuleCommand(draft: string): string | null {
  const trimmed = draft.trim()
  // Require a space (not just any whitespace) after `/rule` so `/rules`
  // or `/rule:` doesn't accidentally trigger.
  if (!/^\/rule(\s|$)/i.test(trimmed)) return null
  const rest = trimmed.replace(/^\/rule\s*/i, '').trim()
  if (rest.length === 0) return null
  return rest
}

/** Append a single rule line to existing content, deduping exact duplicates. */
export function appendRule(existing: string, newRule: string): string {
  const trimmedNew = newRule.trim()
  if (!trimmedNew) return existing
  const lines = existing
    .split('\n')
    .map((l) => l.replace(/^[-•*]\s*/, '').trim())
    .filter((l) => l.length > 0)
  if (lines.some((l) => l.toLowerCase() === trimmedNew.toLowerCase())) {
    // Already there — no duplicate
    return existing
  }
  const next = [...lines, trimmedNew].map((l) => `- ${l}`).join('\n')
  return next
}

/**
 * Fetch the current rules content for a team. Cached for 5 seconds so
 * back-to-back sends don't hammer the API. Returns empty string on any
 * failure — rules are an optional preamble, not a blocker.
 */
export async function fetchTeamRules(teamId: string): Promise<string> {
  const cached = cache.get(teamId)
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.content
  }
  try {
    const res = await fetch(`/api/team-rules/${encodeURIComponent(teamId)}`)
    if (!res.ok) return ''
    const body = (await res.json()) as { content?: string | null }
    const content = typeof body.content === 'string' ? body.content : ''
    cache.set(teamId, { content, fetchedAt: Date.now() })
    return content
  } catch {
    return ''
  }
}

/** PUT new rules content for a team. Invalidates the local cache. */
export async function saveTeamRules(teamId: string, content: string): Promise<boolean> {
  try {
    const res = await fetch(`/api/team-rules/${encodeURIComponent(teamId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    })
    if (!res.ok) return false
    cache.set(teamId, { content, fetchedAt: Date.now() })
    return true
  } catch {
    return false
  }
}

/** Wrap rules content in the envelope agents recognize. Returns null when empty. */
export function buildTeamRulesBlock(content: string): string | null {
  const trimmed = content.trim()
  if (!trimmed) return null
  return `[Team Rules — set by the user, authoritative]\n${trimmed}\n[End Team Rules]`
}

/** Test-only: clear the in-memory cache between test cases. */
export function _resetTeamRulesCache(): void {
  cache.clear()
}
