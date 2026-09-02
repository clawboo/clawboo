// The persona channel for runtimes that have none of their own.
//
// OpenClaw reads SOUL.md on the Gateway side, and clawboo-native turns it into
// `AgentConfig.systemPrompt` (ClawbooNativeAgentSource.writeFile re-derives it),
// so both already carry the user's persona AND the Personality sliders, which
// merge their text into SOUL.md on save. The three coding runtimes read no
// agent file at all. contextPreamble.ts calls them "persona-inert … they read
// no SOUL/systemPrompt", so their only instruction channel is the volatile
// context assembled per turn. Without this block, editing Personality or
// SOUL.md for a codex / claude-code / hermes agent changed nothing at all.
//
// This is deliberately ONE block from ONE file. SOUL.md is the persona surface;
// the other agent files stay unwired rather than quietly becoming a second,
// undocumented prompt channel.

import type { ClawbooDb } from '@clawboo/db'

import { readRuntimeAgentFile } from '../agentSource/runtimeAgentFileStore'

/**
 * Runtimes with NO persona channel of their own. OpenClaw and clawboo-native are
 * absent on purpose: they already deliver SOUL.md, and adding it here would put
 * the same persona in the prompt twice.
 */
const RUNTIMES_WITHOUT_NATIVE_PERSONA = new Set(['codex', 'claude-code', 'hermes'])

/**
 * Cap on the injected persona. This rides EVERY turn for these runtimes, so an
 * unbounded SOUL.md would tax every message for the life of the agent. Generous
 * enough for a real persona plus the full slider block, which is ~600 chars.
 */
export const PERSONA_MAX_CHARS = 4000

/** Section markers a body could smuggle in to fake a boundary in our own prompt. */
const SECTION_MARKER_RE =
  /^[ \t]*\[(?:end\s+)?(?:your persona|ambient|addressed to you)\b[^\]]*\][ \t]*$/gim

/** True when this runtime needs clawboo to hand it the persona explicitly. */
export function needsPersonaInjection(runtime: string | null | undefined): boolean {
  return !!runtime && RUNTIMES_WITHOUT_NATIVE_PERSONA.has(runtime)
}

/**
 * The `[Your persona]` block for one agent, or null when there is nothing to
 * say or the runtime already has its own persona channel.
 *
 * SOUL.md here is operator-authored, but a marketplace-imported agent ships
 * with authored content too, so markers are defanged exactly as
 * `buildTurnEnvelope` defangs message bodies: the section boundaries in our
 * prompt must be ours, never the content's.
 */
export function buildPersonaBlock(
  db: ClawbooDb,
  agentId: string,
  runtime: string | null | undefined,
): string | null {
  if (!needsPersonaInjection(runtime)) return null

  const soul = readRuntimeAgentFile(db, agentId, 'SOUL.md').trim()
  if (!soul) return null

  const clipped = soul.length > PERSONA_MAX_CHARS ? `${soul.slice(0, PERSONA_MAX_CHARS)}\n…` : soul
  const safe = clipped.replace(SECTION_MARKER_RE, '(quoted section marker)')
  return `[Your persona: how you should sound]\n${safe}\n[End your persona]`
}
