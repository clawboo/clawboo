// What this panel is allowed to tell an operator.
//
// It is the only place a standing exec permission can be seen or taken back, so
// every test here is a sentence the screen must not print: an empty list over a
// policy it could not read, a revoke button on a grant it cannot revoke, a
// companion row offered as if it were separately deletable, or a permission shown
// as gone before the Gateway said so.

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { server } from '../../../__vitest__/mswServer'
import { ExecAllowlist } from '../ExecAllowlist'
import { useToastStore } from '@/stores/toast'

let confirmAnswer = true
vi.mock('@/stores/confirm', () => ({
  confirm: () => Promise.resolve(confirmAnswer),
}))

const GRANT = {
  key: 'grant-key',
  pattern: '/bin/echo',
  argPattern: 'sha256:cwd-argv:v1:f76b60c1',
  source: 'allow-always',
  classification: 'bound-grant' as const,
  bucket: 'agent' as const,
  lastUsedCommand: null,
  lastResolvedPath: '/bin/echo',
  lastUsedAt: 1789273436004,
}
const MARKER = {
  key: 'marker-key',
  pattern: '=node-command:769c1dbc',
  argPattern: null,
  source: 'allow-always',
  classification: 'node-marker' as const,
  bucket: 'agent' as const,
  lastUsedCommand: null,
  lastResolvedPath: null,
  lastUsedAt: null,
}

let revokeBodies: unknown[] = []

const serve = (body: unknown, status = 200) =>
  server.use(
    http.get('/api/exec-allowlist', () => HttpResponse.json(body, { status })),
    http.post('/api/exec-allowlist/revoke', async ({ request }) => {
      revokeBodies.push(await request.json())
      return HttpResponse.json({ outcome: 'revoked', removed: 2 })
    }),
  )

const okBody = (over: Record<string, unknown> = {}) => ({
  state: 'ok',
  entries: [GRANT, MARKER],
  wildcard: [],
  duplicatedInWildcard: [],
  storedAsk: 'on-miss',
  ...over,
})

beforeEach(() => {
  revokeBodies = []
  confirmAnswer = true
  useToastStore.setState({ toasts: [] })
})
afterEach(() => {
  cleanup()
  server.resetHandlers()
})

describe('ExecAllowlist', () => {
  it('shows one mint as ONE revocable card, not two rows', async () => {
    // A single "Always" writes a bound grant plus a companion the node-host path
    // requires. Listing both invites an operator to delete the half that looks
    // like litter, which silently breaks the grant.
    serve(okBody())
    render(<ExecAllowlist agentId="boo" />)

    await screen.findByText('/bin/echo')
    expect(screen.getAllByRole('listitem')).toHaveLength(1)
    expect(screen.getByText(/and its companion rule/i)).toBeInTheDocument()
  })

  it('revokes both halves of the mint together', async () => {
    serve(okBody())
    render(<ExecAllowlist agentId="boo" />)
    await screen.findByText('/bin/echo')

    await userEvent.setup().click(screen.getByRole('button', { name: /revoke/i }))
    await waitFor(() => expect(revokeBodies).toHaveLength(1))
    expect(revokeBodies[0]).toEqual({ agentId: 'boo', keys: ['grant-key', 'marker-key'] })
  })

  it('does not revoke when the confirmation is declined', async () => {
    confirmAnswer = false
    serve(okBody())
    render(<ExecAllowlist agentId="boo" />)
    await screen.findByText('/bin/echo')

    await userEvent.setup().click(screen.getByRole('button', { name: /revoke/i }))
    expect(revokeBodies).toHaveLength(0)
  })

  it('NEVER shows an empty list when the policy could not be read', async () => {
    // The worst sentence this screen could print. The grants are still on disk
    // and still enforced; "no standing permissions" would be a safety claim.
    serve({ state: 'unreadable', error: 'bad json', knownAllowlistCount: 7 }, 502)
    render(<ExecAllowlist agentId="boo" />)
    await screen.findByText(/could not read/i)
    expect(screen.queryByText(/no standing permissions/i)).not.toBeInTheDocument()
    expect(screen.getByText(/7 rules/i)).toBeInTheDocument()
  })

  it('says so plainly when the command behind a grant is unrecoverable', async () => {
    // OpenClaw keeps a hash of the argv and the directory, never the text. A
    // truncated digest rendered as if it were a command would be worse than this.
    serve(okBody())
    render(<ExecAllowlist agentId="boo" />)
    expect(await screen.findByText(/keeps only a fingerprint/i)).toBeInTheDocument()
  })

  it('refuses to offer a revoke for a grant that also covers every Boo', async () => {
    // Enforcement unions the wildcard bucket ahead of the agent's own, so
    // removing the agent copy would verify clean and change nothing.
    serve(okBody({ entries: [GRANT], duplicatedInWildcard: ['grant-key'] }))
    render(<ExecAllowlist agentId="boo" />)

    await screen.findByText('/bin/echo')
    expect(screen.getByRole('button', { name: /revoke/i })).toBeDisabled()
    expect(screen.getByText(/would not stop it/i)).toBeInTheDocument()
  })

  it('marks a row the matcher skips as not in effect', async () => {
    serve(
      okBody({
        entries: [
          { ...GRANT, key: 'dead', classification: 'inert-allow-always', argPattern: '^x$' },
        ],
      }),
    )
    render(<ExecAllowlist agentId="boo" />)
    expect(await screen.findByText(/not in effect/i)).toBeInTheDocument()
    expect(screen.getByText(/OpenClaw skips it/i)).toBeInTheDocument()
  })

  it('warns that a bare program rule is broader than a mint', async () => {
    serve(
      okBody({ entries: [{ ...GRANT, key: 'p', classification: 'path-rule', argPattern: null }] }),
    )
    render(<ExecAllowlist agentId="boo" />)
    expect(await screen.findByText(/any arguments, any folder/i)).toBeInTheDocument()
  })

  it('reports wildcard grants without offering to change them', async () => {
    serve(okBody({ wildcard: [{ ...GRANT, key: 'w', bucket: 'wildcard' }] }))
    render(<ExecAllowlist agentId="boo" />)
    expect(await screen.findByText(/applies to\s+every Boo/i)).toBeInTheDocument()
  })

  it('renders nothing at all for a runtime with no such store', async () => {
    // A native Boo has no Gateway policy. An empty card would imply it has one.
    serve({ state: 'not-applicable', runtime: 'clawboo-native' })
    const { container } = render(<ExecAllowlist agentId="native" />)
    await waitFor(() => expect(container).toBeEmptyDOMElement())
  })

  it('distinguishes a machine with no policy document from a Boo with no grants', async () => {
    serve({ state: 'absent' })
    render(<ExecAllowlist agentId="boo" />)
    expect(await screen.findByText(/nothing on this computer/i)).toBeInTheDocument()
  })
})
