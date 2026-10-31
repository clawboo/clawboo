// The working folder an agent starts in when it has no git worktree: a team-chat
// run, or a task run of read-only work. Without one, a spawned runtime inherits
// the server's own working directory, which is clawboo's state dir (the database
// and the secrets vault live there), and Clawboo Native gets no file tools.
//
// ONE folder per team, shared by every member and every room of that team and by
// its read-only task runs, so a file one teammate writes is where the next
// teammate looks for it. For Claude Code, Codex and Hermes it only sets where the
// run starts: they keep the user's full file access. Clawboo Native's file tools
// are confined to it, and its shell (when switched on for that Boo) starts there
// and asks a person before every command.
//
// A task run that changes files still runs in its own per-task git worktree
// (executorRunner); this folder is only its fallback when there is no worktree.

import { mkdir } from 'node:fs/promises'
import path from 'node:path'

import { resolveClawbooDir } from '@clawboo/config'

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
const NO_TEAM_SEGMENT = '_no-team'

/**
 * `<clawboo home>/workspaces/<sanitized teamId>`, stable across runs.
 *
 * Pinned under the workspaces root with the same single startsWith test as
 * `runtimeIdentityHomePath`, so the folder can never be the clawboo home itself,
 * its secrets/ dir, or anywhere outside the root.
 */
export function teamWorkdirPath(teamId: string, env: NodeJS.ProcessEnv = process.env): string {
  const root = path.resolve(resolveClawbooDir(env), 'workspaces')
  const prefix = root.endsWith(path.sep) ? root : root + path.sep
  const dir = path.resolve(root, sanitizeAgentId(teamId))
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
 * The folder a task run with no worktree starts in: its team's folder, or the
 * shared `_no-team` folder for a task with no team. null for a runtime that does
 * not get one.
 */
export function taskRunWorkdirFor(
  runtime: string | null | undefined,
  teamId: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (!runtime || !TEAM_WORKDIR_RUNTIMES.has(runtime)) return null
  return teamWorkdirPath(teamId || NO_TEAM_SEGMENT, env)
}

/** Create the folder owner-only (0700), parents included. Throws on failure. */
export async function ensureTeamWorkdir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 })
}
