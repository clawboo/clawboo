// The Computer tab's task folders: a task with no worktree runs in a folder of
// its own, and its files show here, read from the task-scoped folder routes. The
// picker lists the task folders and worktrees newest first, then the team folder,
// and a host pinned to one task (the task drawer) shows that task's folder alone.

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { server } from '@/__vitest__/mswServer'
import type { AgentTaskFolder, AgentWorkspace, AgentWorkspaceList } from '@/lib/workspaceClient'

import { WorkspacePanel } from '../WorkspacePanel'

vi.mock('@/features/obs/useObsStream', () => ({
  useObsStream: () => ({ events: [], live: false, loading: false, error: null }),
}))

const TEAM_FOLDER = '/home/me/clawboo-work/teams/T'

const brief: AgentTaskFolder = {
  taskId: 'task-2',
  title: 'Write the launch brief',
  taskStatus: 'in_progress',
  path: `${TEAM_FOLDER}/tasks/task-2`,
  updatedAt: 30,
}

const olderWorktree: AgentWorkspace = {
  taskId: 'task-1',
  title: 'Fix the login bug',
  taskStatus: 'done',
  branch: 'clawboo/task-1',
  repoPath: '/repo',
  worktreePath: '/home/me/clawboo-work/worktrees/abc/task-1',
  workspaceStatus: 'active',
  onDisk: true,
  updatedAt: 10,
}

let list: AgentWorkspaceList
const fileReads: string[] = []

beforeEach(() => {
  fileReads.length = 0
  list = {
    workspaces: [olderWorktree],
    taskFolders: [brief],
    teamFolder: { teamId: 'T', path: TEAM_FOLDER, onDisk: true },
  }
  server.use(
    http.get('/api/agents/cx/workspaces', () => HttpResponse.json({ ok: true, ...list })),
    http.get('/api/board/task-2/folder/tree', () =>
      HttpResponse.json({
        dir: '',
        entries: [{ name: 'brief.md', kind: 'file', size: 12 }],
        truncated: false,
      }),
    ),
    http.get('/api/board/task-2/folder/file', ({ request }) => {
      fileReads.push(new URL(request.url).pathname)
      return HttpResponse.json({
        ok: true,
        path: new URL(request.url).searchParams.get('path'),
        binary: false,
        size: 12,
        content: '# Launch brief',
        truncated: false,
      })
    }),
    http.get('/api/board/task-1/workspace/tree', () =>
      HttpResponse.json({ dir: '', entries: [], truncated: false }),
    ),
    http.get('/api/board/task-1/workspace/status', () =>
      HttpResponse.json({ branch: 'clawboo/task-1', entries: [], truncated: false }),
    ),
    http.get('/api/agents/cx/team-folder/tree', () =>
      HttpResponse.json({ dir: '', entries: [], truncated: false }),
    ),
  )
})

afterEach(() => cleanup())

describe('WorkspacePanel task folders', () => {
  it("shows the newest task's own folder first and opens its files from the folder routes", async () => {
    render(<WorkspacePanel agentId="cx" />)

    const picker = (await screen.findByRole('combobox', { name: 'Folder' })) as HTMLSelectElement
    expect([...picker.options].map((o) => o.text)).toEqual([
      'Write the launch brief',
      'Fix the login bug',
      'Team folder',
    ])
    expect(picker.value).toBe('task-2')

    fireEvent.click(await screen.findByRole('button', { name: 'brief.md' }))
    expect(await screen.findByText('# Launch brief')).toBeTruthy()
    expect(fileReads).toEqual(['/api/board/task-2/folder/file'])
  })

  it('switches from a worktree to a task folder and lists the folder from its own route', async () => {
    // The worktree is newer, so it opens first.
    list = { ...list, workspaces: [{ ...olderWorktree, updatedAt: 99 }] }
    render(<WorkspacePanel agentId="cx" />)

    const picker = (await screen.findByRole('combobox', { name: 'Folder' })) as HTMLSelectElement
    expect(picker.value).toBe('task-1')
    expect(screen.queryByRole('button', { name: 'brief.md' })).toBeNull()

    fireEvent.change(picker, { target: { value: 'task-2' } })
    fireEvent.click(await screen.findByRole('button', { name: 'brief.md' }))
    expect(await screen.findByText('# Launch brief')).toBeTruthy()
  })

  it('shows a pinned task folder the agent list leaves out', async () => {
    list = { workspaces: [], taskFolders: [], teamFolder: null }
    render(<WorkspacePanel agentId="cx" pinnedTaskId="task-2" pinnedTaskFolder={brief} />)

    expect(await screen.findByRole('button', { name: 'brief.md' })).toBeTruthy()
    expect(screen.queryByText('No files for this task yet.')).toBeNull()
  })

  it("shows only the pinned task's folder in the task drawer", async () => {
    render(<WorkspacePanel agentId="cx" pinnedTaskId="task-2" />)

    expect(await screen.findByRole('button', { name: 'brief.md' })).toBeTruthy()
    expect(screen.queryByRole('combobox')).toBeNull()
    expect(screen.queryByText('Team folder')).toBeNull()
  })

  it('says so when a pinned task has no files yet', async () => {
    list = { workspaces: [], taskFolders: [], teamFolder: null }
    render(<WorkspacePanel agentId="cx" pinnedTaskId="task-9" />)

    expect(await screen.findByText('No files for this task yet.')).toBeTruthy()
  })
})
