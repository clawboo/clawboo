// Thin typed wrapper over the team-chat REST surface (server/api/teamChat.ts) —
// the UI-facing read of the durable peer-chat room (every team member as a named
// author). Mirrors the defensive boardClient/memoryClient pattern: best-effort,
// resolves to a safe empty value on network/parse failure, never throws. The SPA
// never imports server packages, so the row shape is mirrored locally.
//
// NOTE: the polished room panel (interleaving these named-peer rows into the team
// view) is a future UX coherence lap; this is the data layer it builds on.

export interface TeamChatPost {
  id: string
  roomId: string
  teamId: string
  authorAgentId: string
  body: string
  /** 'peer' = a teammate's post · 'system' = board-mutation narration · 'user'. */
  kind: string
  createdAt: number
  seq: number
}

export interface TeamChatRoom {
  roomId: string
  posts: TeamChatPost[]
  nextSeq: number
}

/** Read a team's room (cursor-based). Defensive — never throws. */
export async function fetchTeamChat(teamId: string, sinceSeq = 0): Promise<TeamChatRoom> {
  const empty: TeamChatRoom = { roomId: `team:${teamId}`, posts: [], nextSeq: sinceSeq }
  try {
    const res = await fetch(
      `/api/team-chat?teamId=${encodeURIComponent(teamId)}&sinceSeq=${sinceSeq}`,
    )
    if (!res.ok) return empty
    const data = (await res.json()) as Partial<TeamChatRoom>
    return {
      roomId: typeof data.roomId === 'string' ? data.roomId : empty.roomId,
      posts: Array.isArray(data.posts) ? (data.posts as TeamChatPost[]) : [],
      nextSeq: typeof data.nextSeq === 'number' ? data.nextSeq : sinceSeq,
    }
  } catch {
    return empty
  }
}
