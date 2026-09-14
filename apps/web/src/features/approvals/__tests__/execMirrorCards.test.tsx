// One card per command, and it says what the command is.
//
// A shell approval can now reach the UI twice: live over the Gateway socket, and
// again from the server's mirror through the poll. Both halves are needed (the
// socket carries the fuller request, the mirror survives a tab that was closed
// or opened late), but rendering both put the same command on screen as two
// cards with different wording. The generic renderer described it from the
// stored class, so the second card read "wants to run Exec", chipped "Deletes
// your data", under a button saying "Delete it", over an `echo`.
//
// These pin the two properties that fix it: the shell approval appears once as a
// shell card, and where the generic renderer still draws one (the governance
// queue reads the raw poll) it describes a command rather than a deletion.

import { render, renderHook, screen, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { server } from '../../../__vitest__/mswServer'
import { useApprovalsStore, type ApprovalRequest } from '@/stores/approvals'
import { ToolApprovalCard } from '../ToolApprovalCard'
import {
  execRequestFromMirror,
  usePendingApprovals,
  type ToolApproval,
} from '../usePendingApprovals'

vi.mock('@/lib/useVisiblePolling', () => ({ useVisiblePolling: () => {} }))

const mirrored = (over: Partial<ToolApproval> = {}): ToolApproval => ({
  id: 'ap-1',
  kind: 'exec',
  toolName: 'exec',
  agentId: 'boo-1',
  argsSummary: JSON.stringify({ command: 'echo hello', cwd: '/tmp/work' }),
  reason: 'this command is not on the trusted list',
  toolClass: 'destructive',
  toolSummary: 'echo hello',
  neverRemember: 0,
  createdAt: 1000,
  expiresAt: Date.now() + 1_800_000,
  ...over,
})

describe('execRequestFromMirror', () => {
  it('reads the command and folder back out of the mirror', () => {
    expect(execRequestFromMirror(mirrored())).toMatchObject({
      id: 'ap-1',
      command: 'echo hello',
      cwd: '/tmp/work',
      agentId: 'boo-1',
    })
  })

  it('falls back to the stored summary when the args blob is unreadable', () => {
    // The command is the one thing the card cannot do without, and it is kept in
    // two places. Dropping the card over a malformed blob would leave the Gateway
    // holding a command with nothing on screen to answer it.
    const req = execRequestFromMirror(mirrored({ argsSummary: '{not json' }))
    expect(req?.command).toBe('echo hello')
  })

  it('refuses a row with no command at all rather than rendering a blank card', () => {
    expect(execRequestFromMirror(mirrored({ argsSummary: '{}', toolSummary: null }))).toBeNull()
  })
})

describe('the generic card, drawing a shell command', () => {
  const show = (over: Partial<ToolApproval> = {}) => {
    const onResolve = vi.fn()
    render(<ToolApprovalCard approval={mirrored(over)} onResolve={onResolve} />)
    return onResolve
  }

  it('names the action a command, not a deletion', () => {
    show()
    expect(screen.getByRole('heading')).toHaveTextContent(/wants to run a command/i)
    expect(screen.getByRole('button', { name: 'Run it' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Delete it' })).not.toBeInTheDocument()
  })

  it('shows the command itself without expanding anything', () => {
    // It is the only field that decides anything here, so it cannot sit behind a
    // disclosure triangle.
    show()
    expect(screen.getByText('echo hello')).toBeInTheDocument()
  })

  it('does not claim to know what the command does', () => {
    show()
    expect(screen.queryByText(/deletes your data/i)).not.toBeInTheDocument()
    expect(screen.getByText('Runs a command')).toBeInTheDocument()
  })

  it('offers Always when the Gateway said it would take it', () => {
    // No grantId is involved: an exec grant lives in OpenClaw's allowlist, and
    // requiring clawboo's would retire the button on every shell approval.
    show()
    expect(screen.getByText(/always allow this command in this folder/i)).toBeInTheDocument()
  })

  it('withholds Always when the Gateway would refuse it', () => {
    // `neverRemember` here is the Gateway's own answer, recorded at mirror time.
    // Offering it anyway produces "allow-always is unavailable for this command".
    show({ neverRemember: 1 })
    expect(screen.queryByText(/always allow/i)).not.toBeInTheDocument()
  })

  it('sends allow_always only once the box is ticked', async () => {
    const userEvent = (await import('@testing-library/user-event')).default
    const onResolve = show()
    const user = userEvent.setup()
    await user.click(screen.getByRole('checkbox'))
    await user.click(screen.getByRole('button', { name: 'Run it' }))
    expect(onResolve).toHaveBeenCalledWith('ap-1', 'allow_always')
  })
})

describe('usePendingApprovals, with both sources live', () => {
  const socketEntry = (id: string): ApprovalRequest => ({
    id,
    agentId: 'boo-1',
    sessionKey: 'main',
    command: 'echo hello',
    cwd: '/tmp/work',
    host: 'node',
    security: 'allowlist',
    ask: 'on-miss',
    resolvedPath: '/bin/echo',
    createdAtMs: 1000,
    expiresAtMs: Date.now() + 1_800_000,
    resolving: false,
    error: null,
  })

  // THE POLL HAS TO HAVE LANDED BEFORE ANY ASSERTION.
  //
  // Both of the merge tests below start with the socket entry already in the
  // store, so the hook's FIRST render already looks correct (one exec card, no
  // tool cards) while the fetch is still in flight. Asserting there passes
  // whatever the merge does with the mirrored row, which is exactly what
  // happened: deleting the dedupe and deleting the exec exclusion both left
  // these tests green. `polls` counts deliveries so the wait is on the state
  // under test rather than on a render that predates it.
  let polls = 0
  const servePoll = (approvals: ToolApproval[]) =>
    server.use(
      http.get('/api/tools/approvals', () => {
        polls += 1
        return HttpResponse.json({ ok: true, approvals })
      }),
    )

  beforeEach(() => {
    polls = 0
    useApprovalsStore.setState({ pendingApprovals: new Map() })
  })
  afterEach(() => server.resetHandlers())

  it('shows a command once when the socket and the mirror both carry it', async () => {
    useApprovalsStore.getState().addPending(socketEntry('ap-1'))
    servePoll([mirrored()])

    const { result } = renderHook(() => usePendingApprovals({ agentId: 'boo-1' }))
    await waitFor(() => expect(polls).toBeGreaterThan(0))
    await waitFor(() => expect(result.current.total).toBe(1))
    expect(result.current.exec).toHaveLength(1)
    // Never as a tool card: that renderer would describe it from the stored class.
    expect(result.current.tool).toHaveLength(0)
  })

  it('keeps the socket copy on a tie, because it carries more of the request', async () => {
    useApprovalsStore.getState().addPending(socketEntry('ap-1'))
    servePoll([mirrored()])

    const { result } = renderHook(() => usePendingApprovals({ agentId: 'boo-1' }))
    await waitFor(() => expect(polls).toBeGreaterThan(0))
    // The mirror keeps neither the session nor the resolved path, so a merge that
    // let it win would quietly strip fields the card and the followup rely on.
    expect(result.current.exec).toHaveLength(1)
    expect(result.current.exec[0]?.sessionKey).toBe('main')
    expect(result.current.exec[0]?.resolvedPath).toBe('/bin/echo')
  })

  it('still shows the command when only the mirror has it', async () => {
    // The case the mirror exists for: a tab opened partway through the window,
    // so this connection never received the frame.
    servePoll([mirrored()])

    const { result } = renderHook(() => usePendingApprovals({ agentId: 'boo-1' }))
    await waitFor(() => expect(result.current.exec).toHaveLength(1))
    expect(result.current.exec[0]?.command).toBe('echo hello')
  })

  it('leaves a genuine tool approval on the tool side', async () => {
    servePoll([
      mirrored(),
      { ...mirrored({ id: 'tc-9' }), kind: 'tool', toolName: 'write_file', toolSummary: null },
    ])

    const { result } = renderHook(() => usePendingApprovals({ agentId: 'boo-1' }))
    await waitFor(() => expect(polls).toBeGreaterThan(0))
    await waitFor(() => expect(result.current.total).toBe(2))
    expect(result.current.exec.map((a) => a.id)).toEqual(['ap-1'])
    expect(result.current.tool.map((a) => a.id)).toEqual(['tc-9'])
  })
})

describe("clawboo's own native shell", () => {
  it('describes run_command with the same card as the Gateway shell', () => {
    // The two are named apart so the audit trail can tell them apart. To the
    // person being asked they are the same question, and an unrecognised name
    // would fall through to the generic renderer: "wants to run Run command",
    // chipped from the stored class, under a button saying "Delete it".
    const onResolve = vi.fn()
    render(
      <ToolApprovalCard
        approval={mirrored({ kind: 'tool', toolName: 'run_command' })}
        onResolve={onResolve}
      />,
    )
    expect(screen.getByRole('heading')).toHaveTextContent(/wants to run a command/i)
    expect(screen.getByRole('button', { name: 'Run it' })).toBeInTheDocument()
    expect(screen.getByText('echo hello')).toBeInTheDocument()
  })
})
