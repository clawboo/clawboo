// The commands a page tells a person to type name the full path of a runtime
// Clawboo installed into its runtimes folder, which is not on their PATH, and
// the bare name otherwise.

import { render, renderHook, screen, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'

import { server } from '@/__vitest__/mswServer'
import { DevicePairingApproval } from '@/features/connection/DevicePairingApproval'

import { useTerminalCommand, withTerminalName } from '../useTerminalCommand'

const LAUNCHER = '/Users/me/clawboo-runtimes/bin/openclaw'

describe('terminal commands', () => {
  it('the pairing card names the launcher when Clawboo installed OpenClaw', async () => {
    server.use(
      http.get('/api/system/status', () =>
        HttpResponse.json({ openclaw: { installed: true, command: LAUNCHER } }),
      ),
    )
    render(<DevicePairingApproval onApproved={() => {}} />)
    expect(await screen.findByText(`${LAUNCHER} devices approve --latest`)).toBeInTheDocument()
  })

  it('the pairing card keeps the bare name for a copy on PATH', async () => {
    render(<DevicePairingApproval onApproved={() => {}} />)
    expect(await screen.findByText('openclaw devices approve --latest')).toBeInTheDocument()
  })

  it('reads the command again when its refresh key changes, as after an install in the same row', async () => {
    let command = 'openclaw' // not installed yet: the bare name
    let reads = 0
    server.use(
      http.get('/api/system/status', () => {
        reads += 1
        return HttpResponse.json({ openclaw: { installed: command !== 'openclaw', command } })
      }),
    )
    const { result, rerender } = renderHook(
      ({ connected }: { connected: boolean }) => useTerminalCommand('openclaw', connected),
      { initialProps: { connected: false } },
    )
    await waitFor(() => expect(reads).toBe(1))
    expect(result.current).toBe('openclaw')

    command = LAUNCHER // the setup in the row installed it into the runtimes folder
    rerender({ connected: false })
    rerender({ connected: true })
    await waitFor(() => expect(result.current).toBe(LAUNCHER))
    expect(reads).toBe(2)
  })

  it('swaps only a leading bare name', () => {
    expect(withTerminalName('codex login', 'codex', "'/a b/codex'")).toBe("'/a b/codex' login")
    expect(withTerminalName('run codex login', 'codex', '/x/codex')).toBe('run codex login')
  })
})
