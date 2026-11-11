// The commands a page tells a person to type name the full path of a runtime
// Clawboo installed into its runtimes folder, which is not on their PATH, and
// the bare name otherwise.

import { render, screen } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'

import { server } from '@/__vitest__/mswServer'
import { DevicePairingApproval } from '@/features/connection/DevicePairingApproval'

import { withTerminalName } from '../useTerminalCommand'

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

  it('swaps only a leading bare name', () => {
    expect(withTerminalName('codex login', 'codex', "'/a b/codex'")).toBe("'/a b/codex' login")
    expect(withTerminalName('run codex login', 'codex', '/x/codex')).toBe('run codex login')
  })
})
