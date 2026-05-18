// fanOutDetector — pure helper used by `useTeamOrchestration` to detect
// when the leader's response prose claims "I'll ask all teammates" /
// "Got responses from all three" / "Let me route to each" WITHOUT
// emitting any structured routing primitive (`<delegate>`, `<plan>`,
// `sessions_send`). When matched, Clawboo synthesizes a workstreams
// batch with all team members as targets so the existing WorkstreamCard
// pipeline renders the same DONE pills + preview lines + 2-col grid as
// an explicit delegation.
//
// All patterns are anchored to a ROUTING VERB (ask / route / delegate /
// hand off / got responses from / fan out) within ~10 words of a plural
// marker (all / each / every / both / everyone / teammates / agents /
// three / four / etc.). Bare plural mentions like "all teammates are
// great" do NOT match — only plural ROUTING intent does.
//
// Round 13. Used by `useTeamOrchestration.processNewEntries` after
// Round 8B / Round 10B detection passes have ruled out an explicit
// structured trigger.

const FAN_OUT_PATTERNS: ReadonlyArray<RegExp> = [
  // 1. "ask all/each/every teammates" / "asking each of you"
  /\bask(?:ing)?\s+(?:all|each|every|both)\s+(?:the\s+)?(?:teammates?|agents?|of\s+(?:you|them|us|the\s+team))/i,

  // 2. "I'll ask all teammates" / "let me route this to everyone" /
  //    "going to delegate to each" / "gonna fan out to the whole team"
  /\b(?:I'?ll|let\s+me|going\s+to|gonna)\s+(?:ask|route|delegate|hand\s+off|fan\s+(?:this\s+)?out)\s+(?:this\s+)?(?:to\s+)?(?:all|each|every|both|everyone|the\s+(?:whole\s+)?team)/i,

  // 3. "all teammates will weigh in" / "each agent should chime in".
  //    Action verb is constrained to ROUTING-flavored verbs (no bare
  //    "are" — that would match "all teammates are great").
  /\b(?:all|each|every|both)\s+(?:teammates?|agents?|of\s+(?:them|the\s+team(?:mates?)?))\s+(?:will\s+(?:reply|respond|chime|weigh|answer|share|give)|should\s+(?:reply|respond|chime|weigh|answer|share|give)|chime\s+in|weigh\s+in|to\s+(?:reply|respond|chime|weigh|answer|share))/i,

  // 4. "got responses from all three" / "got fresh takes from each" /
  //    "got their answers from everyone" — allows ONE optional
  //    adjective ("fresh", "their", "the", "some") between the verb
  //    and the response noun.
  /\bgot\s+(?:\w+\s+)?(?:responses?|answers?|takes?|input|thoughts?|opinions?|feedback)\s+from\s+(?:all|each|every|both|every\s*(?:one|body)|everyone|the\s+team)\b/i,

  // 5. "route this to all teammates" / "delegate to each" / "hand off
  //    to everyone" / "fan out to the team"
  /\b(?:route|delegate|hand\s+off|hand\s+over|fan(?:\s+|-)?out)\s+(?:this\s+)?(?:to\s+)?(?:all|each|every|both|everyone|the\s+(?:whole\s+)?team)/i,

  // 6a. "all three teammates weighed in" / "every four agents already".
  //     Numbered plural BEFORE the noun; the routing verb confirms it.
  /\b(?:all|every|each)\s+(?:three|four|five|six|seven|eight|nine|ten)(?:\s+(?:teammates?|agents?))?\s+(?:weighed|gave|chimed|wrote|said|replied|already)/i,

  // 6b. "all teammates already weighed" / "every agent already chimed".
  //     Same pattern but with bare plural noun (no number).
  /\b(?:all|every|each)\s+(?:teammates?|agents?)\s+(?:already\s+)?(?:weighed|gave|chimed|wrote|said|replied)/i,

  // 7. "all three teammates are aligned" / "all three agree" / "all
  //     teammates aligned on this". Synthesis prose after fan-out —
  //     implies fan-out happened. Anchored to agreement verbs to avoid
  //     bare plural mentions like "all teammates are great".
  /\b(?:all|every|each)\s+(?:three|four|five|six|seven|eight|nine|ten)?(?:\s+(?:teammates?|agents?))?\s+(?:are\s+aligned|are\s+in\s+agreement|agree(?:\s+on)?|aligned\s+on)/i,

  // 8. "Here's the roundup/recap/summary" — LLM's go-to phrase when
  //     synthesizing across multiple teammate responses. Strong signal
  //     of post-fan-out aggregation.
  /\bhere'?s\s+(?:the\s+)?(?:roundup|recap|summary|aggregate|takeaway|takeaways|consensus|aggregated\s+takes?)\b/i,
]

/**
 * Returns `true` when the leader's response text contains plural-routing
 * prose suggesting fan-out to multiple teammates. Always false for empty
 * strings.
 */
export function detectFanOutIntent(text: string | null | undefined): boolean {
  if (!text) return false
  return FAN_OUT_PATTERNS.some((rx) => rx.test(text))
}
