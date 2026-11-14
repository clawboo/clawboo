// Notification deep links from an app that shows the dashboard in its own
// window. The app raises a notification (a task needs the person, an agent
// waits for an approval), and a click on it reaches the dashboard through the
// app's bridge (`onOpenTarget`). This opens what the notification was about.
//
// Approvals have no view of their own: they are answered in Needs you on the
// board, where they are listed first, and in the agents' chats. So both
// approval targets open Needs you, as the dashboard's own browser alerts do,
// and one approval also brings its card into view. Needs you shows every team
// unless the approval belongs to one team, so a board narrowed to another team
// never hides what the person clicked.

import { apiFetch } from '@clawboo/control-client'

import { boardClient } from '@/lib/boardClient'
import { useApprovalsStore } from '@/stores/approvals'
import { useFleetStore } from '@/stores/fleet'
import { useSettingsModalStore } from '@/stores/settingsModal'
import { useToastStore } from '@/stores/toast'
import { useViewStore } from '@/stores/view'

import { embedderBridge, parseOpenTarget, type EmbedderBridge, type OpenTarget } from './bridge'

/** What a pending approval says about itself, for choosing the team to show. */
export type ApprovalLookup =
  /** Still waiting, for this agent (null: one nobody can be attributed to). */
  | { agentId: string | null }
  /** Not waiting any more: answered, or expired. */
  | 'gone'
  /** The list could not be read. */
  | null

export interface OpenTargetDeps {
  /** The task's team (null: it has none), or undefined when it could not be read. */
  taskTeam(taskId: string): Promise<string | null | undefined>
  findApproval(approvalId: string): Promise<ApprovalLookup>
  /** The agent's team (null: teamless), or undefined for an agent this tab does not know. */
  teamOfAgent(agentId: string): string | null | undefined
  toast(message: string): void
}

export const APPROVAL_GONE_MESSAGE = 'That approval was already answered or has expired.'

async function readTaskTeam(taskId: string): Promise<string | null | undefined> {
  const detail = await boardClient.getTask(taskId)
  if (!detail) return undefined
  const teamId = detail.task.teamId
  return typeof teamId === 'string' && teamId ? teamId : null
}

async function readApproval(approvalId: string): Promise<ApprovalLookup> {
  // A shell approval the Gateway delivered, which the server may not have
  // mirrored yet.
  const live = useApprovalsStore.getState().pendingApprovals.get(approvalId)
  if (live) return { agentId: live.agentId ?? null }
  try {
    const res = await apiFetch('/api/tools/approvals?status=pending')
    if (!res.ok) return null
    const body = (await res.json()) as {
      approvals?: Array<{ id?: unknown; agentId?: unknown }>
    }
    const row = (body.approvals ?? []).find((a) => a.id === approvalId)
    if (!row) return 'gone'
    return { agentId: typeof row.agentId === 'string' && row.agentId ? row.agentId : null }
  } catch {
    return null
  }
}

const defaultDeps: OpenTargetDeps = {
  taskTeam: readTaskTeam,
  findApproval: readApproval,
  teamOfAgent: (agentId) => {
    const agent = useFleetStore.getState().agents.find((a) => a.id === agentId)
    return agent ? agent.teamId : undefined
  },
  toast: (message) => useToastStore.getState().addToast({ message, type: 'info' }),
}

/**
 * The team Needs you shows for an approval: none to change (an approval nobody
 * can be attributed to shows on every team), the agent's team, or every team
 * for an agent outside one, or one this tab does not know yet.
 */
export function approvalTeam(
  agentId: string | null,
  teamOfAgent: OpenTargetDeps['teamOfAgent'],
): string | null {
  if (agentId === null) return null
  return teamOfAgent(agentId) ?? 'all'
}

// The newest click wins: a slower read for an older one changes nothing.
let latest = 0

/** Take the person to what the notification was about. */
export async function openEmbedderTarget(
  target: OpenTarget,
  deps: OpenTargetDeps = defaultDeps,
): Promise<void> {
  const mine = ++latest
  const current = (): boolean => mine === latest
  useSettingsModalStore.getState().close()
  const view = useViewStore.getState()
  switch (target.kind) {
    case 'task': {
      // The board must show the task's team, or the drawer would open over a
      // board without its card. A task it cannot read opens all the same, and
      // its drawer says what became of it.
      const teamId = await deps.taskTeam(target.taskId)
      if (current()) useViewStore.getState().openBoardTask(target.taskId, teamId ?? null)
      return
    }
    case 'needs-you':
    case 'approvals':
      view.openBoardNeedsYou('all')
      return
    case 'approval': {
      const found = await deps.findApproval(target.approvalId)
      if (!current()) return
      const open = useViewStore.getState().openBoardNeedsYou
      if (found === 'gone') {
        open('all')
        deps.toast(APPROVAL_GONE_MESSAGE)
        return
      }
      // Unreadable: show every team, and the card if it turns up.
      const teamId = found ? approvalTeam(found.agentId, deps.teamOfAgent) : 'all'
      open(teamId, target.approvalId)
      return
    }
  }
}

// One subscription per bridge for the life of the page. Not tied to a React
// effect: StrictMode runs effects twice, and a pending click is delivered once,
// to whichever subscription takes it.
const subscribed = new WeakSet<object>()

/**
 * Subscribe to the app's deep links, once. A no-op in a browser, and for an app
 * from before deep links. Returns whether it subscribed now.
 */
export function startEmbedderLinks(
  bridge: EmbedderBridge | null = embedderBridge(),
  open: (target: OpenTarget) => Promise<void> = openEmbedderTarget,
): boolean {
  if (!bridge || typeof bridge.onOpenTarget !== 'function' || subscribed.has(bridge)) return false
  subscribed.add(bridge)
  try {
    bridge.onOpenTarget((raw) => {
      const target = parseOpenTarget(raw)
      if (target) void open(target).catch(() => undefined)
    })
  } catch {
    // The app refused the subscription; a click then only brings its window up.
    return false
  }
  return true
}
