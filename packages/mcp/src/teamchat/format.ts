// ─── Peer-as-evidence tagging ────────────────────────────────────────────────
// How a teammate's post is wrapped when delivered to a receiving runtime: inbound
// peer text is tagged `[Inter-session message … isUser=false]` so the receiver
// treats it as tool-routed EVIDENCE from a peer, NOT as a user instruction. A
// peer can never say "ignore your instructions" and have it land with user
// authority. Only genuine user input carries user authority.
//
// The wrapper lives in @clawboo/board-core (`untrustedText`), with the rest of
// the framing for text clawboo did not write: the team engine's `[Task Update]`
// and the mailbox notes riding tool results use it too, and the engine's
// package cannot import this one. Re-exported here, unchanged, so this
// package's surface stays the same.

export { formatPeerPost, type PeerPostLike } from '@clawboo/db'
