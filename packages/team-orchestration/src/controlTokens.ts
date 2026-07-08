// Render-time defensive filters for broken-shape assistant turns — shared by the
// browser renderer (chatComponents.groupEntriesToBlocks, via the @/lib/teamProtocol
// re-export) AND the server-side single chat writer (persistTeamChatEntry), so a
// thin client that doesn't run the render filter (npm/mobile) still never persists
// a control-token turn. Pure string logic, zero deps.
//
// Production showed three distinct families of broken-shape assistant turns leaking
// into the visible chat:
//
//   1. OpenClaw protocol control tokens — `ANNOUNCE_SKIP`, `NO_REPLY`, and the
//      stripped variant `NO`. Emitted by the Gateway's agent-to-agent coordination
//      layer; the Gateway does NOT pre-filter them — Clawboo reads raw event streams.
//   2. Clawboo control tokens — `__resumed__` (resume-ack) and `__skipped__` (the
//      canonical "no substantive contribution" signal agents are told to emit).
//   3. Short refusal-shape responses from team agents — bare "Sorry", "Nope",
//      "Cannot", "Unable". (Bare "NO" is covered by category 1, not this regex.)
//
// `shouldDropAssistantTurn` is the single entry point.

/**
 * The literal token an agent emits in response to a resume wake-up. Filtered out
 * of the visible chat so it never pollutes the transcript.
 */
export const RESUME_ACK_TOKEN = '__resumed__'

/**
 * Canonical Clawboo "no substantive contribution" token. Agents are instructed
 * (in `buildTeamAgentsMd`) to emit ONLY this string when they have nothing to add
 * to a delegation or relay. Filtered out of the visible chat.
 */
export const SKIP_ACK_TOKEN = '__skipped__'

const OPENCLAW_CONTROL_TOKENS = new Set<string>(['ANNOUNCE_SKIP', 'NO_REPLY', 'NO'])

// OpenClaw Gateway has a known truncation bug that strips `NO_REPLY` to variable
// lengths — `NO_REPLY`, the fully-stripped `NO`, and partial prefixes like `NO_RE`
// can all appear. This regex matches any underscore-form prefix:
//   NO_, NO_R, NO_RE, NO_REP, NO_REPL, NO_REPLY
// Natural language doesn't write these underscore-form prefixes, so the false-
// positive risk is zero. Bare `NO` is still matched by the canonical set entry
// above to keep the existing semantics.
const NO_REPLY_PREFIX_RE = /^NO_R?E?P?L?Y?$/i

export function isOpenclawControlToken(text: string): boolean {
  const trimmed = text.trim()
  if (OPENCLAW_CONTROL_TOKENS.has(trimmed.toUpperCase())) return true
  if (NO_REPLY_PREFIX_RE.test(trimmed)) return true
  return false
}

export function isClawbooControlToken(text: string): boolean {
  const t = text.trim()
  return t === RESUME_ACK_TOKEN || t === SKIP_ACK_TOKEN
}

// Refusal regex used for short bare refusals in normal team turns. NOTE: the
// onboarding-time regex in `TeamOnboardingGate.tsx` ALSO matches `no|nope`; here we
// only match the longer refusal openers because bare `NO` is already covered by
// `isOpenclawControlToken` (the stripped `NO_REPLY` variant). Matching `no` here
// would over-trigger on legitimate sentences starting with "No problem".
const REFUSAL_RE = /^(nope|sorry|can'?t|cannot|unable)\b/i

/** Threshold below which a refusal-shape text is treated as a leak. */
export const MIN_SUBSTANTIVE_LENGTH = 25

/**
 * True when the text is a short refusal-shape response (likely a leak from a
 * confused agent). The length floor (`MIN_SUBSTANTIVE_LENGTH`) prevents over-
 * triggering on legitimate longer responses that begin with the same opener
 * (e.g., "Sorry — I think we should re-frame this; ...").
 */
export function isLikelyRefusal(text: string): boolean {
  const t = text.trim()
  return t.length < MIN_SUBSTANTIVE_LENGTH && REFUSAL_RE.test(t)
}

/**
 * Single gate for dropping broken-shape assistant turns. Returns true if the turn
 * should be skipped entirely (control tokens AND short refusal-shape leaks). Wired
 * into both the render path (`chatComponents.groupEntriesToBlocks`) and the server
 * write path (`persistTeamChatEntry`) — both apply it ONLY to assistant-role turns.
 */
export function shouldDropAssistantTurn(text: string): boolean {
  return isOpenclawControlToken(text) || isClawbooControlToken(text) || isLikelyRefusal(text)
}
