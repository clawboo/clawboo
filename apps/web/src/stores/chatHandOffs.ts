// The cards of the tasks handed off from a one-to-one chat: the same read-only
// projection as the board store, one set per agent, fed by that chat's stream. The
// stream sends every card on connect and each one that changes, so nothing here is
// loaded separately. Consumed in RENDER only, like the board store.

import { create } from 'zustand'

import { mergeTask, type BoardChangeFrame, type BoardTaskView } from './board'

export type ChatHandOffFrame = BoardChangeFrame & { teamId?: string | null }

interface ChatHandOffState {
  tasksByAgent: Map<string, Map<string, BoardTaskView>>
  /** Whether each agent's chat acts on a hand-off, as its stream last said. A chat
   *  whose stream has said nothing does not: only the server knows. */
  handsOffByAgent: Map<string, boolean>
  applyFrame: (agentId: string, frame: ChatHandOffFrame) => void
  setHandsOff: (agentId: string, on: boolean) => void
}

export const useChatHandOffStore = create<ChatHandOffState>((set) => ({
  tasksByAgent: new Map(),
  handsOffByAgent: new Map(),
  setHandsOff: (agentId, on) =>
    set((state) => ({ handsOffByAgent: new Map(state.handsOffByAgent).set(agentId, on) })),
  applyFrame: (agentId, frame) =>
    set((state) => {
      const byAgent = new Map(state.tasksByAgent)
      const tasks = new Map(byAgent.get(agentId) ?? [])
      const existing = tasks.get(frame.id)
      const merged = mergeTask(existing, frame)
      tasks.set(frame.id, {
        ...merged,
        // This stream sends the whole row, so a null means the task has no agent now: a
        // hand-off back in To do. `mergeTask` keeps the last one, for sparser frames. An
        // older frame it turned away changes nothing.
        ...(merged !== existing && frame.assigneeAgentId === null ? { assigneeAgentId: null } : {}),
        teamId: frame.teamId ?? existing?.teamId ?? null,
      })
      byAgent.set(agentId, tasks)
      return { tasksByAgent: byAgent }
    }),
}))

/** Apply one `board` frame of a 1:1 chat's stream. Null when it is not one. */
export function applyChatHandOffFrame(agentId: string, raw: string): ChatHandOffFrame | null {
  let frame: ChatHandOffFrame
  try {
    frame = JSON.parse(raw) as ChatHandOffFrame
  } catch {
    return null
  }
  if (!frame || typeof frame.id !== 'string') return null
  useChatHandOffStore.getState().applyFrame(agentId, frame)
  return frame
}

/** Apply one `handOffs` frame of a 1:1 chat's stream. */
export function applyChatHandsOffFrame(agentId: string, raw: string): void {
  try {
    const frame = JSON.parse(raw) as { on?: unknown }
    if (typeof frame?.on === 'boolean')
      useChatHandOffStore.getState().setHandsOff(agentId, frame.on)
  } catch {
    // A frame it cannot read says nothing.
  }
}
