// The Workspace tab's team folder: a Claude Code / Codex / Hermes agent with no
// task worktree shows the folder its team-chat and read-only runs start in, read
// from the agent-scoped routes; with a worktree too, the folder is one more pick;
// a host pinned to one task never offers it.

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { server } from '@/__vitest__/mswServer'
import type { AgentWorkspace, AgentWorkspaceList } from '@/lib/workspaceClient'

import { WorkspacePanel } from '../WorkspacePanel'

vi.mock('@/features/obs/useObsStream', () => ({
  useObsStream: () => ({ events: [], live: false, loading: false, error: null }),
}))

const FOLDER = '/home/me/.clawboo/workspaces/T'

const taskWorkspace: AgentWorkspace = {
  taskId: 'task-1',
  title: 'Fix the login bug',
  taskStatus: 'in_progress',
  branch: 'clawboo/task-1',
  repoPath: '/repo',
  worktreePath: '/home/me/.clawboo/worktrees/abc/task-1',
  workspaceStatus: 'active',
  onDisk: true,
  updatedAt: 1,
}

let list: AgentWorkspaceList
let folderTreeCalls = 0

beforeEach(() => {
  folderTreeCalls = 0
  list = { workspaces: [], teamFolder: { teamId: 'T', path: FOLDER, onDisk: true } }
  server.use(
    http.get('/api/agents/cx/workspaces', () => HttpResponse.json({ ok: true, ...list })),
    http.get('/api/agents/cx/team-folder/tree', () => {
      folderTreeCalls += 1
      return HttpResponse.json({
        dir: '',
        entries: [{ name: 'report.md', kind: 'file', size: 8 }],
        truncated: false,
      })
    }),
    http.get('/api/agents/cx/team-folder/file', ({ request }) => {
      const p = new URL(request.url).searchParams.get('path')
      return HttpResponse.json({
        ok: true,
        path: p,
        binary: false,
        size: 8,
        content: '# Report',
        truncated: false,
      })
    }),
    http.get('/api/board/task-1/workspace/tree', () =>
      HttpResponse.json({ dir: '', entries: [], truncated: false }),
    ),
    http.get('/api/board/task-1/workspace/status', () =>
      HttpResponse.json({ branch: 'clawboo/task-1', entries: [], truncated: false }),
    ),
  )
})

afterEach(() => cleanup())

describe('WorkspacePanel team folder', () => {
  it('shows the team folder for an agent with no task worktree and opens its files', async () => {
    render(<WorkspacePanel agentId="cx" />)

    expect(await screen.findByText('Team folder')).toBeTruthy()
    fireEvent.click(await screen.findByRole('button', { name: 'report.md' }))
    expect(await screen.findByText('# Report')).toBeTruthy()
    // No git checkout, so no change count.
    expect(screen.queryByText(/changed$/)).toBeNull()
  })

  it('says when the folder has not been created yet', async () => {
    list = { workspaces: [], teamFolder: { teamId: 'T', path: FOLDER, onDisk: false } }
    render(<WorkspacePanel agentId="cx" />)

    expect(await screen.findByText(/No files yet/)).toBeTruthy()
    expect(screen.getByText(FOLDER)).toBeTruthy()
    expect(folderTreeCalls).toBe(0)
  })

  it('offers the folder beside a task worktree, task first', async () => {
    list = {
      workspaces: [taskWorkspace],
      teamFolder: { teamId: 'T', path: FOLDER, onDisk: true },
    }
    render(<WorkspacePanel agentId="cx" />)

    const picker = (await screen.findByRole('combobox', {
      name: 'Workspace task',
    })) as HTMLSelectElement
    expect([...picker.options].map((o) => o.text)).toEqual(['Fix the login bug', 'Team folder'])
    expect(picker.value).toBe('task-1')

    fireEvent.change(picker, { target: { value: 'team-folder' } })
    expect(await screen.findByRole('button', { name: 'report.md' })).toBeTruthy()
  })

  it('never offers the folder to a host pinned to one task', async () => {
    list = {
      workspaces: [taskWorkspace],
      teamFolder: { teamId: 'T', path: FOLDER, onDisk: true },
    }
    render(<WorkspacePanel agentId="cx" pinnedTaskId="task-1" />)

    expect(await screen.findByText('clawboo/task-1')).toBeTruthy()
    expect(screen.queryByRole('combobox')).toBeNull()
    expect(screen.queryByText('Team folder')).toBeNull()
  })
})
