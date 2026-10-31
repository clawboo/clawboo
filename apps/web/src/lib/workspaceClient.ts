// Client for the read-only workspace filesystem view (the agent-detail
// Workspace tab). Same conventions as boardClient: thin fetchers over
// `apiFetch`, null/[] on failure, no throwing into render paths.

import { apiFetch } from '@clawboo/control-client'

export interface AgentWorkspace {
  taskId: string
  title: string
  taskStatus: string
  branch: string | null
  repoPath: string
  worktreePath: string | null
  workspaceStatus: string
  /** False when the checkout was paused or reaped (the branch survives). */
  onDisk: boolean
  updatedAt: number
}

/** The folder an agent starts in when it has no worktree (team chat, read-only
 *  tasks). No git, so no change badges. */
export interface AgentTeamFolder {
  /** null for an agent with no team (the shared `_no-team` folder). */
  teamId: string | null
  path: string
  /** False until the first run creates it. */
  onDisk: boolean
}

export interface AgentWorkspaceList {
  workspaces: AgentWorkspace[]
  /** null for a runtime that gets no folder (OpenClaw). */
  teamFolder: AgentTeamFolder | null
}

/** `null` means the request FAILED, which is not the same as "this agent has no
 *  workspaces". Collapsing the two let one failed poll wipe the panel and show
 *  the empty state over a live worktree. */
export async function getAgentWorkspaces(agentId: string): Promise<AgentWorkspaceList | null> {
  try {
    const r = await apiFetch(`/api/agents/${encodeURIComponent(agentId)}/workspaces`)
    if (!r.ok) return null
    const body = (await r.json()) as {
      workspaces?: AgentWorkspace[]
      teamFolder?: AgentTeamFolder | null
    }
    return { workspaces: body.workspaces ?? [], teamFolder: body.teamFolder ?? null }
  } catch {
    return null
  }
}

export interface WorkspaceTreeEntry {
  name: string
  kind: 'file' | 'dir'
  size?: number
}

export interface WorkspaceTreeListing {
  dir: string
  entries: WorkspaceTreeEntry[]
  truncated: boolean
}

export async function getWorkspaceTree(
  taskId: string,
  dir: string,
): Promise<WorkspaceTreeListing | null> {
  try {
    const r = await apiFetch(
      `/api/board/${encodeURIComponent(taskId)}/workspace/tree?dir=${encodeURIComponent(dir)}`,
    )
    if (!r.ok) return null
    return (await r.json()) as WorkspaceTreeListing
  } catch {
    return null
  }
}

export type WorkspaceFileContent =
  | { binary: true; size: number }
  | { binary: false; size: number; content: string; truncated: boolean }

export async function getWorkspaceFile(
  taskId: string,
  path: string,
): Promise<WorkspaceFileContent | null> {
  try {
    const r = await apiFetch(
      `/api/board/${encodeURIComponent(taskId)}/workspace/file?path=${encodeURIComponent(path)}`,
    )
    if (!r.ok) return null
    return (await r.json()) as WorkspaceFileContent
  } catch {
    return null
  }
}

/** One directory level of the agent's team folder. */
export async function getTeamFolderTree(
  agentId: string,
  dir: string,
): Promise<WorkspaceTreeListing | null> {
  try {
    const r = await apiFetch(
      `/api/agents/${encodeURIComponent(agentId)}/team-folder/tree?dir=${encodeURIComponent(dir)}`,
    )
    if (!r.ok) return null
    return (await r.json()) as WorkspaceTreeListing
  } catch {
    return null
  }
}

export async function getTeamFolderFile(
  agentId: string,
  path: string,
): Promise<WorkspaceFileContent | null> {
  try {
    const r = await apiFetch(
      `/api/agents/${encodeURIComponent(agentId)}/team-folder/file?path=${encodeURIComponent(path)}`,
    )
    if (!r.ok) return null
    return (await r.json()) as WorkspaceFileContent
  } catch {
    return null
  }
}

export interface WorkspaceStatusEntry {
  path: string
  x: string
  y: string
  origPath?: string
}

export interface WorkspaceStatusResult {
  branch: string | null
  entries: WorkspaceStatusEntry[]
  truncated: boolean
}

export type WorkspaceStatusOutcome =
  | { ok: true; status: WorkspaceStatusResult }
  /** git could not read the checkout. Distinct from a clean tree. */
  | { ok: false; unreadable: boolean }

export async function getWorkspaceStatus(taskId: string): Promise<WorkspaceStatusOutcome> {
  try {
    const r = await apiFetch(`/api/board/${encodeURIComponent(taskId)}/workspace/status`)
    if (!r.ok) return { ok: false, unreadable: r.status === 409 }
    return { ok: true, status: (await r.json()) as WorkspaceStatusResult }
  } catch {
    return { ok: false, unreadable: false }
  }
}

export async function getWorkspaceFileDiff(
  taskId: string,
  path: string,
): Promise<{ diff: string; truncated: boolean } | null> {
  try {
    const r = await apiFetch(
      `/api/board/${encodeURIComponent(taskId)}/workspace/file-diff?path=${encodeURIComponent(path)}`,
    )
    if (!r.ok) return null
    return (await r.json()) as { diff: string; truncated: boolean }
  } catch {
    return null
  }
}

/** The single-letter change badge for a status entry: the worktree column when
 *  set, else the index column; untracked ('??') renders as 'A' since from the
 *  task's point of view the file is an addition. */
export function statusBadge(entry: WorkspaceStatusEntry): string {
  if (entry.x === '?' || entry.y === '?') return 'A'
  const c = entry.y !== ' ' && entry.y !== '' ? entry.y : entry.x
  return c === ' ' || c === '' ? 'M' : c
}
