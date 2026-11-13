// What the Website logins panel may and may not show.
//
// A saved login goes in once and never comes back: the list names a site, its
// label and two markers, the edit form starts empty, and a password, one-time
// code key or 1Password token is gone from the page (and from component state)
// once its request is over. Every failure reads as plain words from a fixed map,
// never as the server's code or its own text.

import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { server } from '@/__vitest__/mswServer'
import { useToastStore } from '@/stores/toast'

import { WebsiteLoginsPanel } from '../WebsiteLoginsPanel'

let confirmAnswer = true
vi.mock('@/stores/confirm', () => ({
  confirm: () => Promise.resolve(confirmAnswer),
}))

const USERNAME = 'ada@example.com'
const PASSWORD = 'hunter2-Very-Secret'
const NEW_PASSWORD = 'correct-horse-battery'
const OTP = 'JBSWY3DPEHPK3PXPJBSWY3DP'
const TOKEN = 'ops_SECRETtokenVALUE123'

const GITHUB = {
  id: 'a1',
  origin: 'https://github.com',
  label: 'Work account',
  hasUsername: true,
  hasOneTimeCode: true,
  createdAt: 1,
  updatedAt: 1,
}
const LOCAL = {
  id: 'b2',
  origin: 'http://localhost:3000',
  label: null,
  hasUsername: false,
  hasOneTimeCode: false,
  createdAt: 2,
  updatedAt: 2,
}

type Snapshot = {
  ok: true
  logins: (typeof GITHUB | typeof LOCAL)[]
  onePassword: {
    connected: boolean
    connectedAt: number | null
    sdkInstalled: boolean
    sdkInstalling: boolean
  }
  fillAvailable: boolean
}

const snapshot = (over: Partial<Snapshot> = {}): Snapshot => ({
  ok: true,
  logins: [GITHUB, LOCAL],
  onePassword: { connected: false, connectedAt: null, sdkInstalled: true, sdkInstalling: false },
  fillAvailable: true,
  ...over,
})

interface Sent {
  method: string
  path: string
  body: unknown
}
let sent: Sent[] = []

/** Serves the list. A successful write switches it to `after` when given. */
function serveList(initial: Snapshot, after?: Snapshot) {
  let current = initial
  server.use(http.get('/api/website-logins', () => HttpResponse.json(current)))
  return () => {
    if (after) current = after
  }
}

async function record(request: Request): Promise<void> {
  const text = await request.text()
  sent.push({
    method: request.method,
    path: new URL(request.url).pathname,
    body: text ? (JSON.parse(text) as unknown) : null,
  })
}

/** Nothing typed as a value is anywhere on the page, in an input or as text. */
function expectNowhereOnPage(...values: string[]) {
  for (const value of values) {
    expect(screen.queryByDisplayValue(value)).toBeNull()
    expect(screen.queryByText(value, { exact: false })).toBeNull()
    expect(document.body.innerHTML).not.toContain(value)
    for (const t of useToastStore.getState().toasts) expect(t.message).not.toContain(value)
  }
}

beforeEach(() => {
  sent = []
  confirmAnswer = true
  useToastStore.setState({ toasts: [] })
})
afterEach(() => {
  cleanup()
})

describe('WebsiteLoginsPanel', () => {
  it('lists each login by site and label, with markers and no values', async () => {
    serveList(snapshot())
    render(<WebsiteLoginsPanel />)

    const github = await screen.findByTestId('website-login-a1')
    expect(within(github).getByText('github.com')).toBeInTheDocument()
    expect(within(github).getByText('Work account')).toBeInTheDocument()
    expect(within(github).getByText('username set')).toBeInTheDocument()
    expect(within(github).getByText('one-time code')).toBeInTheDocument()

    const local = screen.getByTestId('website-login-b2')
    expect(within(local).getByText('http://localhost:3000')).toBeInTheDocument()
    expect(within(local).queryByText('username set')).toBeNull()
    expect(within(local).queryByText('one-time code')).toBeNull()

    expect(screen.getByText('A CAPTCHA, passkey or card check still needs you.')).toBeVisible()
    expect(screen.queryByTestId('website-logins-fill-unavailable')).toBeNull()
  })

  it('says calmly when agents cannot be filled on this install', async () => {
    serveList(snapshot({ fillAvailable: false }))
    render(<WebsiteLoginsPanel />)
    expect(await screen.findByTestId('website-logins-fill-unavailable')).toHaveTextContent(
      "No browser connector is connected, so agents can't sign in with these yet. Connect Playwright or Chrome DevTools under Connectors.",
    )
    // Saving is still offered.
    expect(screen.getByRole('button', { name: 'Add login' })).toBeEnabled()
  })

  it('saving POSTs the typed values once, then they are gone from the page', async () => {
    const created = {
      id: 'c3',
      origin: 'https://example.com',
      label: 'Personal',
      hasUsername: true,
      hasOneTimeCode: true,
      createdAt: 3,
      updatedAt: 3,
    }
    const advance = serveList(snapshot({ logins: [] }), snapshot({ logins: [created] }))
    server.use(
      http.post('/api/website-logins', async ({ request }) => {
        await record(request)
        advance()
        // The real answer carries no value, so neither does this one.
        return HttpResponse.json({ ok: true, login: created }, { status: 201 })
      }),
    )
    const consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m),
    )
    const user = userEvent.setup()
    render(<WebsiteLoginsPanel />)

    expect(await screen.findByText('No website logins yet')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Add login' }))
    const form = screen.getByRole('form', { name: 'Add a login' })
    const password = within(form).getByLabelText('Password')
    expect(password).toHaveAttribute('type', 'password')
    expect(password).toHaveAttribute('autocomplete', 'new-password')
    expect(within(form).getByLabelText('One-time code key (optional)')).toHaveAttribute(
      'type',
      'password',
    )

    await user.type(within(form).getByLabelText('Site address'), 'example.com')
    await user.type(within(form).getByLabelText('Label (optional)'), 'Personal')
    await user.type(within(form).getByLabelText('Username'), USERNAME)
    await user.type(password, PASSWORD)
    await user.type(within(form).getByLabelText('One-time code key (optional)'), OTP)
    await user.click(within(form).getByRole('button', { name: 'Save login' }))

    await waitFor(() => expect(sent).toHaveLength(1))
    expect(sent[0]).toEqual({
      method: 'POST',
      path: '/api/website-logins',
      body: {
        site: 'example.com',
        username: USERNAME,
        password: PASSWORD,
        oneTimeCodeSecret: OTP,
        label: 'Personal',
      },
    })

    const row = await screen.findByTestId('website-login-c3')
    expect(within(row).getByText('example.com')).toBeInTheDocument()
    expect(screen.queryByRole('form', { name: 'Add a login' })).toBeNull()
    expectNowhereOnPage(PASSWORD, OTP, USERNAME)
    for (const spy of consoleSpies) {
      for (const call of spy.mock.calls) {
        expect(JSON.stringify(call)).not.toContain(PASSWORD)
      }
    }
  })

  it('shows plain words for an error code, never the code or the server text, and clears the password', async () => {
    serveList(snapshot({ logins: [] }))
    let answer: { status: number; body: Record<string, unknown> } = {
      status: 400,
      body: { ok: false, error: 'insecure_site' },
    }
    server.use(
      http.post('/api/website-logins', async ({ request }) => {
        await record(request)
        return HttpResponse.json(answer.body, { status: answer.status })
      }),
    )
    const user = userEvent.setup()
    render(<WebsiteLoginsPanel />)

    await user.click(await screen.findByRole('button', { name: 'Add login' }))
    const form = screen.getByRole('form', { name: 'Add a login' })
    const password = within(form).getByLabelText('Password')
    await user.type(within(form).getByLabelText('Site address'), 'http://example.com')
    await user.type(password, PASSWORD)
    await user.click(within(form).getByRole('button', { name: 'Save login' }))

    expect(
      await within(form).findByText('Use an https address. Only localhost may use http.'),
    ).toBeInTheDocument()
    expect(screen.queryByText(/insecure_site/)).toBeNull()
    // The password left the field the moment the request was over, even though it failed.
    expect(password).toHaveValue('')
    expect(within(form).getByLabelText('Site address')).toHaveValue('http://example.com')
    expectNowhereOnPage(PASSWORD)

    // A refusal whose body is the server's own sentence still reads from the map.
    answer = {
      status: 429,
      body: { error: 'Too many requests for this operation. Wait a moment and retry.' },
    }
    await user.type(password, PASSWORD)
    await user.click(within(form).getByRole('button', { name: 'Save login' }))
    expect(
      await within(form).findByText('Too many changes at once. Wait a moment and try again.'),
    ).toBeInTheDocument()
    expect(screen.queryByText(/Too many requests for this operation/)).toBeNull()
    expect(password).toHaveValue('')
  })

  it('the edit form never pre-fills a value, and sends only what was typed', async () => {
    serveList(snapshot())
    server.use(
      http.patch('/api/website-logins/:id', async ({ request }) => {
        await record(request)
        return HttpResponse.json({ ok: true, login: GITHUB })
      }),
    )
    const user = userEvent.setup()
    render(<WebsiteLoginsPanel />)

    await user.click(await screen.findByRole('button', { name: 'Edit the login for github.com' }))
    const form = screen.getByRole('form', { name: 'Change the login for github.com' })
    // The site and label are already on screen; nothing else starts filled.
    expect(within(form).getByLabelText('Site address')).toHaveValue('https://github.com')
    expect(within(form).getByLabelText('Label (optional)')).toHaveValue('Work account')
    const password = within(form).getByLabelText('Password')
    expect(password).toHaveValue('')
    expect(password).toHaveAttribute('type', 'password')
    expect(password).toHaveAttribute('placeholder', 'Leave empty to keep')
    expect(within(form).getByLabelText('Username')).toHaveValue('')
    expect(within(form).getByLabelText('One-time code key (optional)')).toHaveValue('')

    await user.type(password, NEW_PASSWORD)
    await user.click(within(form).getByRole('button', { name: 'Save changes' }))

    await waitFor(() => expect(sent).toHaveLength(1))
    expect(sent[0]).toEqual({
      method: 'PATCH',
      path: '/api/website-logins/a1',
      body: { password: NEW_PASSWORD },
    })
    await waitFor(() =>
      expect(screen.queryByRole('form', { name: 'Change the login for github.com' })).toBeNull(),
    )
    expectNowhereOnPage(NEW_PASSWORD)
  })

  it('removing the one-time code sends null, not an empty key', async () => {
    serveList(snapshot())
    server.use(
      http.patch('/api/website-logins/:id', async ({ request }) => {
        await record(request)
        return HttpResponse.json({ ok: true, login: GITHUB })
      }),
    )
    const user = userEvent.setup()
    render(<WebsiteLoginsPanel />)

    await user.click(await screen.findByRole('button', { name: 'Edit the login for github.com' }))
    const form = screen.getByRole('form', { name: 'Change the login for github.com' })
    await user.click(within(form).getByLabelText('Remove the one-time code'))
    await user.click(within(form).getByRole('button', { name: 'Save changes' }))

    await waitFor(() => expect(sent).toHaveLength(1))
    expect(sent[0]!.body).toEqual({ oneTimeCodeSecret: null })
  })

  it('remove asks first, then DELETEs the login', async () => {
    const advance = serveList(snapshot(), snapshot({ logins: [LOCAL] }))
    server.use(
      http.delete('/api/website-logins/:id', async ({ request }) => {
        await record(request)
        advance()
        return HttpResponse.json({ ok: true })
      }),
    )
    const user = userEvent.setup()
    render(<WebsiteLoginsPanel />)

    confirmAnswer = false
    await user.click(await screen.findByRole('button', { name: 'Remove the login for github.com' }))
    expect(sent).toHaveLength(0)

    confirmAnswer = true
    await user.click(screen.getByRole('button', { name: 'Remove the login for github.com' }))
    await waitFor(() => expect(screen.queryByTestId('website-login-a1')).toBeNull())
    expect(sent).toEqual([{ method: 'DELETE', path: '/api/website-logins/a1', body: null }])
  })

  it('connects 1Password without ever showing the token, then shows Connected and Disconnect', async () => {
    const connectedAt = Date.UTC(2026, 10, 2, 12)
    const advance = serveList(
      snapshot(),
      snapshot({
        onePassword: { connected: true, connectedAt, sdkInstalled: true, sdkInstalling: false },
      }),
    )
    let reply: { status: number; body: Record<string, unknown> } = {
      status: 400,
      body: { ok: false, error: 'rejected' },
    }
    server.use(
      http.put('/api/website-logins/sources/1password', async ({ request }) => {
        await record(request)
        if (reply.status === 200) advance()
        return HttpResponse.json(reply.body, { status: reply.status })
      }),
    )
    const user = userEvent.setup()
    render(<WebsiteLoginsPanel />)

    const card = await screen.findByTestId('website-logins-1password')
    expect(within(card).getByText('Connect 1Password')).toBeInTheDocument()
    expect(
      within(card).getByText(
        "The token lives in Clawboo's encrypted vault and only your own runs use it.",
      ),
    ).toBeInTheDocument()
    const input = within(card).getByLabelText('Service account token')
    expect(input).toHaveAttribute('type', 'password')

    await user.type(input, TOKEN)
    await user.click(within(card).getByRole('button', { name: 'Connect' }))
    expect(
      await within(card).findByText(
        "1Password didn't accept that token, or it can't read any vault.",
      ),
    ).toBeInTheDocument()
    expect(input).toHaveValue('')

    reply = { status: 200, body: { ok: true, vaults: 2 } }
    await user.type(input, TOKEN)
    await user.click(within(card).getByRole('button', { name: 'Connect' }))

    expect(await within(card).findByText('Connected')).toBeInTheDocument()
    expect(within(card).getByRole('button', { name: 'Disconnect' })).toBeInTheDocument()
    expect(within(card).queryByLabelText('Service account token')).toBeNull()
    expect(sent.map((s) => s.body)).toEqual([{ token: TOKEN }, { token: TOKEN }])
    expectNowhereOnPage(TOKEN)
  })

  it('installs 1Password support on the first Connect, then connects', async () => {
    const advance = serveList(
      snapshot({
        onePassword: {
          connected: false,
          connectedAt: null,
          sdkInstalled: false,
          sdkInstalling: false,
        },
      }),
      snapshot({
        onePassword: { connected: true, connectedAt: 1, sdkInstalled: true, sdkInstalling: false },
      }),
    )
    let release: () => void = () => undefined
    const installDone = new Promise<void>((r) => (release = r))
    server.use(
      http.post('/api/website-logins/sources/1password/install', async ({ request }) => {
        await record(request)
        await installDone
        return HttpResponse.json({ ok: true })
      }),
      http.put('/api/website-logins/sources/1password', async ({ request }) => {
        await record(request)
        advance()
        return HttpResponse.json({ ok: true, vaults: 1 })
      }),
    )
    const user = userEvent.setup()
    render(<WebsiteLoginsPanel />)
    const card = await screen.findByTestId('website-logins-1password')
    await user.type(within(card).getByLabelText('Service account token'), TOKEN)
    await user.click(within(card).getByRole('button', { name: 'Connect' }))
    expect(
      await within(card).findByText(
        'Installing 1Password support. This happens once and can take a minute.',
      ),
    ).toBeInTheDocument()
    release()
    expect(await within(card).findByText('Connected')).toBeInTheDocument()
    expect(sent.map((x) => x.path)).toEqual([
      '/api/website-logins/sources/1password/install',
      '/api/website-logins/sources/1password',
    ])
    expect(sent[0]?.body).toEqual({})
    expectNowhereOnPage(TOKEN)
  })

  it('says plainly when the download fails, and sends no token', async () => {
    serveList(
      snapshot({
        onePassword: {
          connected: false,
          connectedAt: null,
          sdkInstalled: false,
          sdkInstalling: false,
        },
      }),
    )
    server.use(
      http.post('/api/website-logins/sources/1password/install', async ({ request }) => {
        await record(request)
        return HttpResponse.json({ ok: false, error: 'install_offline' }, { status: 502 })
      }),
      http.put('/api/website-logins/sources/1password', async ({ request }) => {
        await record(request)
        return HttpResponse.json({ ok: true, vaults: 1 })
      }),
    )
    const user = userEvent.setup()
    render(<WebsiteLoginsPanel />)
    const card = await screen.findByTestId('website-logins-1password')
    const input = within(card).getByLabelText('Service account token')
    await user.type(input, TOKEN)
    await user.click(within(card).getByRole('button', { name: 'Connect' }))
    expect(
      await within(card).findByText(
        "Couldn't download 1Password support. Check this computer's internet connection or proxy, then try again.",
      ),
    ).toBeInTheDocument()
    expect(input).toHaveValue('')
    expect(sent.map((x) => x.path)).toEqual(['/api/website-logins/sources/1password/install'])
    expectNowhereOnPage(TOKEN)
  })
})
