// A pause as a person's screen shows it: with what it is called. Board rows, the
// chat's change frames and the routes all read it from here.

import {
  agents,
  getTask,
  isTerminal,
  liftPause,
  listPauses,
  pauseForTask,
  teams,
  type ClawbooDb,
  type DbTask,
  type Pause,
  type PauseKind,
  type TaskStatus,
} from '@clawboo/db'
import { eq } from 'drizzle-orm'

/** What it is called, or null when it no longer exists. */
export function pauseTargetName(db: ClawbooDb, kind: PauseKind, id: string): string | null {
  if (kind === 'agent') {
    return (
      db.select({ name: agents.name }).from(agents).where(eq(agents.id, id)).get()?.name ?? null
    )
  }
  if (kind === 'team') {
    return db.select({ name: teams.name }).from(teams).where(eq(teams.id, id)).get()?.name ?? null
  }
  return getTask(db, id)?.title ?? null
}

export interface PauseView extends Pause {
  /** The agent's or team's name, or the root task's title. */
  name: string
}

/** Every pause whose target still exists. A row left behind by a deleted agent or team
 *  covers nothing and is not shown. It goes now, so an agent made later under a reused
 *  id does not start out paused. */
export function pauseViews(db: ClawbooDb): PauseView[] {
  return listPauses(db).flatMap((p) => {
    const name = pauseTargetName(db, p.kind, p.id)
    if (name === null) {
      liftPause(db, p.kind, p.id)
      return []
    }
    return [{ ...p, name }]
  })
}

/** What a card shows of the pause covering its task, or null. A finished task has
 *  nothing a pause can hold back. */
export function pauseViewOfTask(
  db: ClawbooDb,
  task: DbTask,
  views: PauseView[] = pauseViews(db),
): PauseView | null {
  // A pause holds back runs. A person's turn is not one, so their card does not read
  // as paused, even with the agent it came from paused.
  if (isTerminal(task.status as TaskStatus) || task.assigneePersonId) return null
  const pause = views.length > 0 ? pauseForTask(db, task) : null
  if (!pause) return null
  return views.find((p) => p.kind === pause.kind && p.id === pause.id) ?? null
}
