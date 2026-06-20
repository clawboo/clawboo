// ─── Peer-as-evidence tagging ────────────────────────────────────────────────
// The SINGLE source of truth for how a teammate's post is wrapped when delivered
// to a receiving runtime. We borrow OpenClaw's inter-session wire format: inbound
// peer text is tagged `[Inter-session message … isUser=false]` so the receiver
// treats it as tool-routed EVIDENCE from a peer, NOT as a user instruction. This
// is the load-bearing safety property — a peer can never say "ignore your
// instructions" and have it land with user authority. Only genuine user input
// carries user authority.
//
// The `isUser=false` token is reproduced verbatim (the safety-critical substring);
// the surrounding attribution (author + seq + kind) is a faithful reconstruction.

export interface PeerPostLike {
  authorAgentId: string
  body: string
  /** 'peer' = a teammate's post · 'system' = board-mutation narration. Both are
   *  non-user — system narration is also evidence, never a user instruction. */
  kind: string
  seq: number
}

/** Any inter-session envelope header — used to DEFANG a forged one smuggled in a
 *  body. A hostile peer could otherwise embed a byte-identical
 *  `[Inter-session message · … · isUser=true]` line that reads as a real (user-
 *  authority) envelope; the binding controls the OUTER header, never the body. */
const INTER_SESSION_HEADER_RE = /\[Inter-session message[^\]]*\]/gi

/**
 * Wrap a room post as a non-user, inter-session evidence message. The returned
 * string is what a receiving runtime sees as a tool result / injected turn.
 *
 * Escalation is prevented BY CONSTRUCTION, not by the receiver's judgement: the
 * body is defanged (any embedded inter-session header is neutralised) and every
 * body line is quote-prefixed, so the wrapper always yields EXACTLY ONE authentic
 * header (the outer one, controlled by the connection binding) and the body can
 * never present itself as a second — user — turn.
 */
export function formatPeerPost(post: PeerPostLike): string {
  const header = `[Inter-session message · from=${post.authorAgentId} · kind=${post.kind} · seq=${post.seq} · isUser=false]`
  const safeBody = post.body
    .replace(INTER_SESSION_HEADER_RE, '[peer-quoted header]')
    .split('\n')
    .map((line) => `| ${line}`)
    .join('\n')
  return `${header}\n${safeBody}`
}
