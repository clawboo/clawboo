// TeamVerifyCommandEditor: the team's work check in the team settings sheet.
// Reads and writes /api/team-verify-command/:teamId; an empty save clears it.

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { axe } from '@/__vitest__/axe'
import { useToastStore } from '@/stores/toast'

import { server } from '../../../__vitest__/mswServer'
import { TeamVerifyCommandEditor } from '../TeamVerifyCommandEditor'

afterEach(() => cleanup())

beforeEach(() => {
  useToastStore.setState({ toasts: [] })
})

/** A GET that answers `command`, and a PUT that records each body and trims like the server. */
function serveCommand(command: string) {
  const puts: unknown[] = []
  server.use(
    http.get('/api/team-verify-command/:teamId', () => HttpResponse.json({ command })),
    http.put('/api/team-verify-command/:teamId', async ({ request }) => {
      const body = (await request.json()) as { command: string }
      puts.push(body)
      return HttpResponse.json({ command: body.command.trim() })
    }),
  )
  return puts
}

const lastToast = () => useToastStore.getState().toasts.at(-1)

describe('TeamVerifyCommandEditor', () => {
  it("says what the check is, and that the agent's own runs when none is set", async () => {
    serveCommand('')
    render(<TeamVerifyCommandEditor teamId="t1" />)
    expect(await screen.findByRole('textbox', { name: 'Work check command' })).toHaveValue('')
    expect(screen.getByText(/A task reaches Done only when the command succeeds/)).toBeVisible()
    expect(screen.getByTestId('work-check-active')).toHaveTextContent(
      "Active check: each agent's own, written by the agent in its task folder.",
    )
  })

  it("shows the team's stored command as the active check, set for the team", async () => {
    serveCommand('npm test')
    render(<TeamVerifyCommandEditor teamId="t1" />)
    expect(await screen.findByRole('textbox', { name: 'Work check command' })).toHaveValue(
      'npm test',
    )
    expect(screen.getByTestId('work-check-active')).toHaveTextContent(
      'Active check: npm test, set for the team.',
    )
    expect(screen.getByRole('button', { name: 'Save check' })).toBeDisabled()
  })

  it('keeps the active check on the saved value while a draft is unsaved', async () => {
    const user = userEvent.setup()
    serveCommand('npm test')
    render(<TeamVerifyCommandEditor teamId="t1" />)
    const input = await screen.findByRole('textbox', { name: 'Work check command' })
    await user.clear(input)
    await user.type(input, 'pnpm test')
    expect(screen.getByTestId('work-check-active')).toHaveTextContent(
      'Active check: npm test, set for the team.',
    )
  })

  it('saves a new command and shows the trimmed value the server stored', async () => {
    const user = userEvent.setup()
    const puts = serveCommand('')
    render(<TeamVerifyCommandEditor teamId="t1" />)
    const input = await screen.findByRole('textbox', { name: 'Work check command' })
    await user.type(input, '  pnpm test  ')
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Save check' }))

    await waitFor(() => expect(lastToast()?.message).toBe('Work check saved.'))
    expect(puts).toEqual([{ command: '  pnpm test  ' }])
    expect(input).toHaveValue('pnpm test')
    expect(screen.getByTestId('work-check-active')).toHaveTextContent(
      'Active check: pnpm test, set for the team.',
    )
    expect(screen.queryByText('Unsaved changes')).toBeNull()
    expect(screen.getByRole('button', { name: 'Save check' })).toBeDisabled()
  })

  it('saves on Enter', async () => {
    const user = userEvent.setup()
    const puts = serveCommand('')
    render(<TeamVerifyCommandEditor teamId="t1" />)
    await user.type(
      await screen.findByRole('textbox', { name: 'Work check command' }),
      'npm test{Enter}',
    )
    await waitFor(() => expect(puts).toEqual([{ command: 'npm test' }]))
  })

  it('clears the command with an empty save', async () => {
    const user = userEvent.setup()
    const puts = serveCommand('npm test')
    render(<TeamVerifyCommandEditor teamId="t1" />)
    const input = await screen.findByRole('textbox', { name: 'Work check command' })
    await user.clear(input)
    await user.click(screen.getByRole('button', { name: 'Save check' }))

    await waitFor(() => expect(lastToast()?.message).toBe('Work check cleared.'))
    expect(puts).toEqual([{ command: '' }])
    expect(screen.getByTestId('work-check-active')).toHaveTextContent(
      "Active check: each agent's own",
    )
  })

  it('treats spaces alone as no change', async () => {
    const user = userEvent.setup()
    serveCommand('npm test')
    render(<TeamVerifyCommandEditor teamId="t1" />)
    await user.type(await screen.findByRole('textbox', { name: 'Work check command' }), '   ')
    expect(screen.getByRole('button', { name: 'Save check' })).toBeDisabled()
    expect(screen.queryByText('Unsaved changes')).toBeNull()
  })

  it('keeps the edit and says so when the save fails', async () => {
    const user = userEvent.setup()
    server.use(
      http.get('/api/team-verify-command/:teamId', () => HttpResponse.json({ command: '' })),
      http.put('/api/team-verify-command/:teamId', () =>
        HttpResponse.json({ error: 'team not found' }, { status: 404 }),
      ),
    )
    render(<TeamVerifyCommandEditor teamId="t1" />)
    const input = await screen.findByRole('textbox', { name: 'Work check command' })
    await user.type(input, 'npm test')
    await user.click(screen.getByRole('button', { name: 'Save check' }))

    await waitFor(() =>
      expect(lastToast()).toMatchObject({
        message: 'Could not save the work check.',
        type: 'error',
      }),
    )
    expect(input).toHaveValue('npm test')
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument()
  })

  it('says so when the stored command could not be read, instead of showing none set', async () => {
    server.use(
      http.get('/api/team-verify-command/:teamId', () =>
        HttpResponse.json({ error: 'boom' }, { status: 500 }),
      ),
    )
    render(<TeamVerifyCommandEditor teamId="t1" />)
    expect(await screen.findByRole('alert')).toHaveTextContent(
      "Could not load this team's work check.",
    )
    expect(screen.queryByTestId('work-check-active')).toBeNull()
  })

  it('lets an empty save clear a command that could not be read', async () => {
    const user = userEvent.setup()
    const puts: unknown[] = []
    server.use(
      http.get('/api/team-verify-command/:teamId', () =>
        HttpResponse.json({ error: 'boom' }, { status: 500 }),
      ),
      http.put('/api/team-verify-command/:teamId', async ({ request }) => {
        puts.push(await request.json())
        return HttpResponse.json({ command: '' })
      }),
    )
    render(<TeamVerifyCommandEditor teamId="t1" />)
    await screen.findByRole('alert')
    await user.click(screen.getByRole('button', { name: 'Save check' }))

    await waitFor(() => expect(lastToast()?.message).toBe('Work check cleared.'))
    expect(puts).toEqual([{ command: '' }])
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('button', { name: 'Save check' })).toBeDisabled()
  })

  it('caps the command at the server limit', async () => {
    serveCommand('')
    render(<TeamVerifyCommandEditor teamId="t1" />)
    expect(await screen.findByRole('textbox', { name: 'Work check command' })).toHaveAttribute(
      'maxLength',
      '2000',
    )
  })

  it('has no level-A/AA a11y violations', async () => {
    serveCommand('npm test')
    const { container } = render(<TeamVerifyCommandEditor teamId="t1" />)
    await screen.findByRole('textbox', { name: 'Work check command' })
    expect(await axe(container)).toHaveNoViolations()
  })
})
