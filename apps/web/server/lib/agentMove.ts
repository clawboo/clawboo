// Move an agent to another team, in one transaction.
//
// A team is more than `agents.team_id`. Its board tasks, its routines, its chat
// rooms and the leader's resume pointers all name the team, so changing the
// column alone left the agent's old work pointing at a team it had left: a task
// still bound to it would fire into the old team's chat, and its routines would
// keep posting work there. Everything below changes together or not at all.
//
// What stays where it is, on purpose:
// - Finished and in-review tasks stay on the old team's board, with the agent
//   still named on them, as the record of who did the work.
// - The team's folder on disk. The agent starts in the new team's folder from
//   its next run; files it saved in the old one stay with that team.
// - Memory and budgets scoped to the old team. Budgets set on the agent itself
//   follow it, since they are keyed on the agent.

import {
  agents,
  immediateWrite,
  roomMembers,
  rooms,
  scheduledRuns,
  settings,
  tasks,
  teams,
  type ClawbooDb,
} from '@clawboo/db'
import { delegationTargetOf } from '@clawboo/board-core'
import { and, eq, inArray, like, or } from 'drizzle-orm'

import { nativeTeamSessionSettingKey } from './teamChat/nativeTeamSession'

export type MoveAgentResult =
  | {
      ok: true
      fromTeamId: string | null
      toTeamId: string
      /** Open tasks unbound from the agent and left on the old team's board. */
      tasksHandedBack: number
      /** The agent's own routines, now posting to the new team. */
      routinesMoved: number
    }
  | {
      ok: false
      status: 400 | 404 | 409
      error:
        | 'agent_not_found'
        | 'team_not_found'
        | 'team_archived'
        | 'same_team'
        | 'agent_is_boo_zero'
        | 'agent_leads_team'
        | 'agent_busy'
    }

/** Statuses of a task nobody is working yet. In progress refuses the move;
 *  in review and finished stay as the old team's record. */
const OPEN_STATUSES = ['backlog', 'todo', 'blocked']

export function moveAgentToTeam(
  db: ClawbooDb,
  input: { agentId: string; toTeamId: string; booZeroId: string | null },
): MoveAgentResult {
  const { agentId, toTeamId } = input
  return immediateWrite(db, (tx): MoveAgentResult => {
    const agent = tx.select().from(agents).where(eq(agents.id, agentId)).get()
    if (!agent || agent.archivedAt) return { ok: false, status: 404, error: 'agent_not_found' }
    // Boo Zero leads every team from outside them all; putting it in one would
    // make it a member of the team it presides over.
    if (input.booZeroId === agentId) return { ok: false, status: 409, error: 'agent_is_boo_zero' }

    const target = tx.select().from(teams).where(eq(teams.id, toTeamId)).get()
    if (!target) return { ok: false, status: 404, error: 'team_not_found' }
    if (target.isArchived) return { ok: false, status: 409, error: 'team_archived' }

    const fromTeamId = agent.teamId ?? null
    if (fromTeamId === toTeamId) return { ok: false, status: 400, error: 'same_team' }

    if (fromTeamId) {
      const from = tx.select().from(teams).where(eq(teams.id, fromTeamId)).get()
      // A team's lead routes its work; moving it would leave the team leaderless
      // mid-plan. Change the lead first.
      if (from?.leaderAgentId === agentId)
        return { ok: false, status: 409, error: 'agent_leads_team' }
    }

    // A run in flight reports to the team it started in. Wait for it to finish.
    const running = tx
      .select({ id: tasks.id })
      .from(tasks)
      .where(
        and(
          eq(tasks.assigneeAgentId, agentId),
          eq(tasks.status, 'in_progress'),
          eq(tasks.dropped, 0),
        ),
      )
      .get()
    if (running) return { ok: false, status: 409, error: 'agent_busy' }

    const now = Date.now()
    let tasksHandedBack = 0
    if (fromTeamId) {
      // Unbind the agent's not-yet-started tasks on the old team. They stay on
      // that board, unassigned, for someone there to pick up; left bound, the
      // dispatch pump would fire them at an agent that is no longer a member.
      // Matched with the board's own reading of the binding, not a LIKE, so an
      // agent whose id is a prefix of another's cannot take that one's tasks.
      const handBack = tx
        .select({
          id: tasks.id,
          assigneeAgentId: tasks.assigneeAgentId,
          sourceDelegationId: tasks.sourceDelegationId,
        })
        .from(tasks)
        .where(
          and(
            eq(tasks.teamId, fromTeamId),
            eq(tasks.dropped, 0),
            inArray(tasks.status, OPEN_STATUSES),
          ),
        )
        .all()
        .filter(
          (t) =>
            t.assigneeAgentId === agentId || delegationTargetOf(t.sourceDelegationId) === agentId,
        )
        .map((t) => t.id)
      if (handBack.length > 0) {
        tasksHandedBack = tx
          .update(tasks)
          .set({
            sourceDelegationId: null,
            assigneeAgentId: null,
            assigneeRuntime: null,
            updatedAt: now,
          })
          .where(inArray(tasks.id, handBack))
          .run().changes
      }

      // Its room memberships in the old team. Rooms already intersect with the
      // team's members, so this is hygiene, not correctness.
      const oldRoomIds = tx
        .select({ id: rooms.id })
        .from(rooms)
        .where(eq(rooms.teamId, fromTeamId))
        .all()
        .map((r) => r.id)
      if (oldRoomIds.length > 0) {
        tx.delete(roomMembers)
          .where(and(eq(roomMembers.agentId, agentId), inArray(roomMembers.roomId, oldRoomIds)))
          .run()
      }

      // Its leader resume pointers for the old team and its rooms.
      const pointer = nativeTeamSessionSettingKey(agentId, fromTeamId)
      tx.delete(settings)
        .where(or(eq(settings.key, pointer), like(settings.key, `${pointer}:room:%`)))
        .run()
    }

    // The agent's own routines follow it: an agent routine's fire is a board
    // task for that agent on its own team. Team routines name no agent.
    const routinesMoved = tx
      .update(scheduledRuns)
      .set({ teamId: toTeamId, updatedAt: now })
      .where(eq(scheduledRuns.agentId, agentId))
      .run().changes

    tx.update(agents).set({ teamId: toTeamId, updatedAt: now }).where(eq(agents.id, agentId)).run()

    return { ok: true, fromTeamId, toTeamId, tasksHandedBack, routinesMoved }
  })
}
