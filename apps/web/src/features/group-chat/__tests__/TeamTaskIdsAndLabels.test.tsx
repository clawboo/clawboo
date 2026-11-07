// The two Team settings sections this team's board reads: the letters on its task
// ids, and its labels. Plus the label picker in a task's drawer.

import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { TaskLabelsSelect } from '@/features/board/TaskLabelsSelect'

import { server } from '../../../__vitest__/mswServer'
import { TeamLabelsEditor } from '../TeamLabelsEditor'
import { TeamTaskPrefixEditor } from '../TeamTaskPrefixEditor'

afterEach(() => cleanup())

describe('TeamTaskPrefixEditor', () => {
  const servePrefix = (state: Record<string, unknown>, onPut?: () => Response) => {
    const puts: unknown[] = []
    server.use(
      http.get('/api/teams/t1/task-prefix', () => HttpResponse.json(state)),
      http.put('/api/teams/t1/task-prefix', async ({ request }) => {
        puts.push(await request.json())
        return onPut ? onPut() : HttpResponse.json({ prefix: 'CLB' })
      }),
    )
    return puts
  }

  it('offers the letters the first task would take, and saves a change', async () => {
    const puts = servePrefix({ prefix: null, suggested: 'CLA', locked: false })
    const user = userEvent.setup()
    render(<TeamTaskPrefixEditor teamId="t1" />)
    const field = await screen.findByLabelText("Letters on this team's task ids")
    expect(field).toHaveValue('CLA')
    await user.clear(field)
    await user.type(field, 'clb')
    expect(screen.getByText(/CLB-12/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /save/i }))
    await waitFor(() => expect(puts).toEqual([{ prefix: 'clb' }]))
  })

  it('says why the server refused', async () => {
    servePrefix({ prefix: null, suggested: 'CLA', locked: false }, () =>
      HttpResponse.json({ error: 'taken' }, { status: 409 }),
    )
    const user = userEvent.setup()
    render(<TeamTaskPrefixEditor teamId="t1" />)
    const field = await screen.findByLabelText("Letters on this team's task ids")
    await user.clear(field)
    await user.type(field, 'OTH')
    await user.click(screen.getByRole('button', { name: /save/i }))
    expect(await screen.findByText(/Another team uses these letters/)).toBeInTheDocument()
  })

  it('shows the letters as fixed once the team has a task, with nothing to edit', async () => {
    servePrefix({ prefix: 'CLA', suggested: 'CLA', locked: true })
    render(<TeamTaskPrefixEditor teamId="t1" />)
    expect(await screen.findByText(/fixed now that it has tasks/)).toBeInTheDocument()
    expect(screen.queryByRole('textbox')).toBeNull()
  })
})

describe('TeamLabelsEditor', () => {
  it('lists, adds, renames and removes', async () => {
    const calls: string[] = []
    server.use(
      http.get('/api/teams/t1/labels', () =>
        HttpResponse.json({ labels: [{ id: 'l1', name: 'Bug' }] }),
      ),
      http.post('/api/teams/t1/labels', async ({ request }) => {
        const { name } = (await request.json()) as { name: string }
        calls.push(`add ${name}`)
        return HttpResponse.json({ label: { id: 'l2', name } }, { status: 201 })
      }),
      http.patch('/api/teams/t1/labels/l1', async ({ request }) => {
        const { name } = (await request.json()) as { name: string }
        calls.push(`rename ${name}`)
        return HttpResponse.json({ label: { id: 'l1', name } })
      }),
      http.delete('/api/teams/t1/labels/l2', () => {
        calls.push('remove l2')
        return HttpResponse.json({ ok: true })
      }),
    )
    const user = userEvent.setup()
    render(<TeamLabelsEditor teamId="t1" />)
    const rename = await screen.findByLabelText('Rename label Bug')
    await user.type(screen.getByLabelText('New label'), 'Idea{Enter}')
    await screen.findByLabelText('Rename label Idea')
    await user.clear(rename)
    await user.type(rename, 'Defect{Enter}')
    await waitFor(() => expect(calls).toContain('rename Defect'))
    await user.click(screen.getByRole('button', { name: 'Remove label Idea' }))
    await waitFor(() => expect(screen.queryByLabelText('Rename label Idea')).toBeNull())
    expect(calls).toEqual(['add Idea', 'rename Defect', 'remove l2'])
  })

  it('says when a name is taken', async () => {
    server.use(
      http.get('/api/teams/t1/labels', () => HttpResponse.json({ labels: [] })),
      http.post('/api/teams/t1/labels', () =>
        HttpResponse.json({ error: 'taken' }, { status: 409 }),
      ),
    )
    const user = userEvent.setup()
    render(<TeamLabelsEditor teamId="t1" />)
    await user.type(await screen.findByLabelText('New label'), 'Bug{Enter}')
    expect(await screen.findByText(/already has a label/)).toBeInTheDocument()
  })
})

describe('TaskLabelsSelect', () => {
  const serve = (saved: unknown[]) =>
    server.use(
      http.get('/api/teams/t1/labels', () =>
        HttpResponse.json({
          labels: [
            { id: 'l1', name: 'Bug' },
            { id: 'l2', name: 'Idea' },
          ],
        }),
      ),
      http.put('/api/board/task1/labels', async ({ request }) => {
        const body = (await request.json()) as { labelIds: string[] }
        saved.push(body.labelIds)
        return HttpResponse.json({
          labels: body.labelIds.map((id) => ({ id, name: id === 'l1' ? 'Bug' : 'Idea' })),
        })
      }),
    )

  it('adds and takes off a label, saving each change', async () => {
    const saved: unknown[] = []
    serve(saved)
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(
      <TaskLabelsSelect
        taskId="task1"
        teamId="t1"
        labels={[{ id: 'l1', name: 'Bug' }]}
        onChange={onChange}
      />,
    )
    await user.click(screen.getByTestId('task-labels-edit'))
    const menu = await screen.findByTestId('task-labels-menu')
    await user.click(await within(menu).findByRole('menuitemcheckbox', { name: 'Idea' }))
    await waitFor(() => expect(saved).toEqual([['l1', 'l2']]))
  })

  it('puts the old labels back when the save is refused', async () => {
    server.use(
      http.get('/api/teams/t1/labels', () =>
        HttpResponse.json({ labels: [{ id: 'l2', name: 'Idea' }] }),
      ),
      http.put('/api/board/task1/labels', () =>
        HttpResponse.json({ error: 'person_only' }, { status: 403 }),
      ),
    )
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(<TaskLabelsSelect taskId="task1" teamId="t1" labels={[]} onChange={onChange} />)
    await user.click(screen.getByTestId('task-labels-edit'))
    const menu = await screen.findByTestId('task-labels-menu')
    await user.click(await within(menu).findByRole('menuitemcheckbox', { name: 'Idea' }))
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(2))
    expect(onChange).toHaveBeenLastCalledWith([])
  })
})
