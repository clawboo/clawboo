// The working folder an agent starts in when it has no git worktree: a team-chat
// run, its own chat, or a task run. Without one, a spawned runtime inherits the
// server's own working directory, which can be clawboo's state dir (the database
// and the secrets vault live there), and Clawboo Native gets no file tools.
//
// ONE folder per team, shared by every member and every room of that team, so a
// file the lead or a teammate writes outside a task is where the next one looks
// for it. For Claude Code, Codex and Hermes it only sets where the run starts:
// they keep the user's full file access. Clawboo Native's file tools are confined
// to the folder its run starts in, and its shell (when switched on for that Boo)
// starts there and asks a person before every command.
//
// A task run starts in a folder of its own inside its team folder,
// `<team folder>/tasks/<task id>` (see taskFolderPath), so the files it makes are
// tied to the task and show on it. A task run that changes a repository runs in
// its own per-task git worktree instead (executorRunner). The task folders sit in
// the team folder on purpose: the team-chat work check, the folder's run record
// (teamFolderActivity) and deleting a team all cover them with the team folder.
//
// The folders live in the work folder (`workDir.ts`), outside the data folder,
// so `../..` from one is not the database. Older versions kept them under
// `<clawboo home>/workspaces`; the boot move leaves a link there.

import { lstat, mkdir } from 'node:fs/promises'
import path from 'node:path'

import { resolveClawbooDir } from '@clawboo/config'
import { assertSafeTaskId } from '@clawboo/worktrees'

import { agentMkdir } from '../agentUser/agentFs'
import { isAgentUserMode } from '../agentUser/config'
import { stayingTeamFolder } from '../workDirJournal'
import { workDirInUse, workLayout } from '../workDir'
import { sanitizeAgentId } from './identityHome'

/**
 * The runtimes that get the team folder. OpenClaw works in its Gateway's own
 * workspace; the mock harness touches no files.
 */
const TEAM_WORKDIR_RUNTIMES: ReadonlySet<string> = new Set([
  'claude-code',
  'codex',
  'hermes',
  'clawboo-native',
])

/** The shared folder for task runs that belong to no team. The leading `_` keeps
 *  it apart from real team ids. */
export const NO_TEAM_SEGMENT = '_no-team'

/** Where team folders go: `<work folder>/teams`, by its real path, or the old
 *  `<clawboo home>/workspaces` when the install keeps the old layout. */
export function teamFoldersRoot(env: NodeJS.ProcessEnv = process.env): string {
  return workLayout() === 'work'
    ? path.join(workDirInUse(env), 'teams')
    : path.resolve(resolveClawbooDir(env), 'workspaces')
}

/** The old place, `<clawboo home>/workspaces`: a link to the new folder stays
 *  there after the move, for older versions and for tools that saved the path. */
export function legacyTeamFoldersRoot(env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(resolveClawbooDir(env), 'workspaces')
}

/** `<clawboo home>/workspaces/<sanitized teamId>`, the old place of a team's
 *  folder, pinned under that root with the same test as {@link teamWorkdirPath}. */
export function legacyTeamFolderPath(teamId: string, env: NodeJS.ProcessEnv = process.env): string {
  const root = legacyTeamFoldersRoot(env)
  const prefix = root.endsWith(path.sep) ? root : root + path.sep
  const dir = path.resolve(root, sanitizeAgentId(teamId))
  if (!dir.startsWith(prefix)) {
    throw new Error(`team working folder escapes ${root}: ${dir}`)
  }
  return dir
}

/**
 * `<work folder>/teams/<sanitized teamId>`, stable across runs. A folder the
 * work folder move kept at the old place (another volume, or something already
 * at the new path) stays there until a later boot moves it.
 *
 * Pinned under the root with the same single startsWith test as
 * `runtimeIdentityHomePath`, so the folder can never be the root itself, the
 * clawboo home, its secrets/ dir, or anywhere outside the root.
 */
export function teamWorkdirPath(teamId: string, env: NodeJS.ProcessEnv = process.env): string {
  const name = sanitizeAgentId(teamId)
  const staying = stayingTeamFolder(name)
  const root = staying ? path.dirname(staying) : teamFoldersRoot(env)
  const prefix = root.endsWith(path.sep) ? root : root + path.sep
  const dir = path.resolve(root, name)
  if (!dir.startsWith(prefix)) {
    throw new Error(`team working folder escapes ${root}: ${dir}`)
  }
  return dir
}

/** The team folder for a team-chat run, or null for a runtime that does not get one. */
export function teamWorkdirFor(
  runtime: string | null | undefined,
  teamId: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (!runtime || !TEAM_WORKDIR_RUNTIMES.has(runtime) || !teamId) return null
  return teamWorkdirPath(teamId, env)
}

/**
 * An agent's team folder: its team's, or the shared `_no-team` folder for an
 * agent with no team. Its own chat starts there; a task run starts in the task's
 * folder inside it ({@link taskRunFolderFor}). null for a runtime that does not
 * get one.
 */
export function taskRunWorkdirFor(
  runtime: string | null | undefined,
  teamId: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (!runtime || !TEAM_WORKDIR_RUNTIMES.has(runtime)) return null
  return teamWorkdirPath(teamId || NO_TEAM_SEGMENT, env)
}

/** The folder inside a team folder that holds its task folders. */
export const TASK_FOLDERS_SEGMENT = 'tasks'

/**
 * `<team folder>/tasks/<task id>`: the folder of one task's files. The team is
 * the task's own (the shared `_no-team` folder for a task with no team), so the
 * path follows from the task's row alone, never from a request. Pinned under the
 * team folder's `tasks/` with the same single startsWith test as
 * {@link teamWorkdirPath}, and the task id must be one path segment.
 */
export function taskFolderPath(
  teamId: string | null | undefined,
  taskId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const root = path.join(teamWorkdirPath(teamId || NO_TEAM_SEGMENT, env), TASK_FOLDERS_SEGMENT)
  const prefix = root.endsWith(path.sep) ? root : root + path.sep
  const dir = path.resolve(root, assertSafeTaskId(taskId))
  if (!dir.startsWith(prefix)) {
    throw new Error(`task folder escapes ${root}: ${dir}`)
  }
  return dir
}

/** What a run that starts in its task's folder is told about it. */
export const TASK_FOLDER_NOTE =
  "You are working in this task's own folder (your working directory). Save the files you make for this task there: they show on the task for the person and your team. Your team's shared folder is two levels up (`../..`): files the team shares are there, and its `tasks/` folder holds the other tasks' own folders."

/** Where a task run with no worktree starts, and the team folder that holds it. */
export interface TaskRunFolder {
  /** The task's own folder: the run's working directory. */
  dir: string
  /** The team folder it sits in: where the run reports that it is working
   *  (teamFolderActivity), since the team-chat work check measures that folder. */
  teamFolder: string
}

/**
 * The folder a task run with no worktree starts in: the task's own folder inside
 * its team folder. null for a runtime that does not get one (OpenClaw works in its
 * Gateway's own workspace).
 */
export function taskRunFolderFor(
  runtime: string | null | undefined,
  task: { id: string; teamId?: string | null },
  env: NodeJS.ProcessEnv = process.env,
): TaskRunFolder | null {
  if (!runtime || !TEAM_WORKDIR_RUNTIMES.has(runtime)) return null
  return {
    dir: taskFolderPath(task.teamId, task.id, env),
    teamFolder: teamWorkdirPath(task.teamId || NO_TEAM_SEGMENT, env),
  }
}

/**
 * Create a run's folder owner-only (0700), parents included: a team folder or a
 * task folder. The one place either is made. Throws on failure.
 *
 * With agents on their own OS user the folder is theirs, so the agent host makes
 * it (the server cannot write there). Without the setting it stays the
 * asynchronous mkdir it was: the agent-space verbs run synchronously then, and
 * that moves when a chat turn's follow-up timers are set.
 */
export async function ensureTeamWorkdir(dir: string): Promise<void> {
  if (isAgentUserMode()) {
    await agentMkdir(dir, { mode: 0o700 })
    return
  }
  await mkdir(dir, { recursive: true, mode: 0o700 })
  // `mkdir` succeeds on a link to a folder. A run's folder must be a real one:
  // a teammate could swap a task's folder for a link, and a run's write jail
  // would then follow it out (agentMkdir checks the same).
  const st = await lstat(dir)
  if (!st.isDirectory()) {
    throw Object.assign(new Error(`${dir} is not a folder of its own (a link or a file)`), {
      code: 'ENOTDIR',
    })
  }
}
