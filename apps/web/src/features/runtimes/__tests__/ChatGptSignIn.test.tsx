// ChatGptSignIn — the one-click UI-driven sign-in. msw serves the SSE stream
// (static event-stream bodies, the OpenClawInlineSetup test pattern). Asserts:
// the device code renders BIG with the open/cancel affordances, a verified
// completion fires onLoggedIn, and the typed degrades (NOT_INSTALLED /
// UNSUPPORTED_PLATFORM) fall back to the manual copy-command.

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { server } from '../../../__vitest__/mswServer'
import { ChatGptSignIn } from '../ChatGptSignIn'

afterEach(() => cleanup())

const sse = (events: Record<string, unknown>[]) =>
  new HttpResponse(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''), {
    headers: { 'Content-Type': 'text/event-stream' },
  })

describe('ChatGptSignIn', () => {
  it('renders the device code BIG with Open + Cancel once the CLI surfaces it', async () => {
    server.use(
      http.post('/api/auth/cli-login/hermes', () =>
        sse([
          { type: 'progress', step: 'starting', message: 'Starting…' },
          { type: 'output', line: '2. Enter this code:' },
          { type: 'device-code', url: 'https://auth.openai.com/codex/device', code: 'KXTV-PQRS' },
          // no complete — the CLI is still polling; the UI stays in waiting.
        ]),
      ),
    )
    render(
      <ChatGptSignIn
        tool="hermes"
        loginCommand="hermes auth add openai-codex"
        onLoggedIn={vi.fn()}
      />,
    )
    await userEvent.click(screen.getByTestId('chatgpt-signin-hermes-start'))
    const code = await screen.findByTestId('chatgpt-signin-hermes-code')
    expect(code).toHaveTextContent('KXTV-PQRS')
    expect(screen.getByTestId('chatgpt-signin-hermes-open')).toBeInTheDocument()
    expect(screen.getByTestId('chatgpt-signin-hermes-cancel')).toBeInTheDocument()
  })

  it('browser flow (auth-url, no code): shows the quiet browser-wait row, never a code card', async () => {
    server.use(
      http.post('/api/auth/cli-login/openclaw', () =>
        sse([
          { type: 'output', line: 'Browser will open for OpenAI authentication.' },
          { type: 'auth-url', url: 'https://auth.openai.com/oauth/authorize?x=1' },
          // no complete — the CLI is waiting on its localhost callback.
        ]),
      ),
    )
    render(
      <ChatGptSignIn
        tool="openclaw"
        loginCommand="openclaw models auth login --provider openai-codex"
        onLoggedIn={vi.fn()}
      />,
    )
    await userEvent.click(screen.getByTestId('chatgpt-signin-openclaw-start'))
    await screen.findByTestId('chatgpt-signin-openclaw-browser-wait')
    expect(screen.getByTestId('chatgpt-signin-openclaw-open')).toBeInTheDocument()
    expect(screen.queryByTestId('chatgpt-signin-openclaw-code')).toBeNull()
    // The browser flow is NOT account-gated — no device remediation noise.
    expect(screen.queryByText(/device authorization/i)).toBeNull()
  })

  it('device flow (hermes) carries the ChatGPT Settings → Security remediation', async () => {
    server.use(
      http.post('/api/auth/cli-login/hermes', () =>
        sse([
          { type: 'device-code', url: 'https://auth.openai.com/codex/device', code: 'AB12-CD34' },
        ]),
      ),
    )
    render(
      <ChatGptSignIn
        tool="hermes"
        loginCommand="hermes auth add openai-codex"
        onLoggedIn={vi.fn()}
      />,
    )
    await userEvent.click(screen.getByTestId('chatgpt-signin-hermes-start'))
    await screen.findByTestId('chatgpt-signin-hermes-code')
    const link = screen.getByRole('link', { name: /ChatGPT Settings/i })
    expect(link).toHaveAttribute('href', expect.stringContaining('chatgpt.com'))
  })

  it('a PROBE-verified completion flips to done and fires onLoggedIn', async () => {
    const onLoggedIn = vi.fn()
    server.use(
      http.post('/api/auth/cli-login/codex', () =>
        sse([
          { type: 'auth-url', url: 'https://auth.openai.com/oauth/authorize?x=1' },
          { type: 'complete', success: true, loggedIn: true },
        ]),
      ),
    )
    render(<ChatGptSignIn tool="codex" loginCommand="codex login" onLoggedIn={onLoggedIn} />)
    await userEvent.click(screen.getByTestId('chatgpt-signin-codex-start'))
    await screen.findByTestId('chatgpt-signin-codex-done')
    expect(onLoggedIn).toHaveBeenCalledTimes(1)
  })

  it('exit-without-login is a failure with Retry + the manual command (never a false done)', async () => {
    const onLoggedIn = vi.fn()
    server.use(
      http.post('/api/auth/cli-login/codex', () =>
        sse([
          {
            type: 'complete',
            success: false,
            loggedIn: false,
            message: 'Sign-in did not complete.',
          },
        ]),
      ),
    )
    render(<ChatGptSignIn tool="codex" loginCommand="codex login" onLoggedIn={onLoggedIn} />)
    await userEvent.click(screen.getByTestId('chatgpt-signin-codex-start'))
    await screen.findByText(/did not complete/i)
    expect(onLoggedIn).not.toHaveBeenCalled()
    expect(screen.getByText('codex login')).toBeInTheDocument() // the manual fallback
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
  })

  it('UNSUPPORTED_PLATFORM degrades to the copy-command fallback (info tone, no Retry)', async () => {
    server.use(
      http.post('/api/auth/cli-login/openclaw', () =>
        sse([
          {
            type: 'error',
            code: 'UNSUPPORTED_PLATFORM',
            message: 'The OpenClaw sign-in needs a terminal on Windows.',
          },
        ]),
      ),
    )
    render(
      <ChatGptSignIn
        tool="openclaw"
        loginCommand="openclaw models auth login --provider openai-codex"
        onLoggedIn={vi.fn()}
      />,
    )
    await userEvent.click(screen.getByTestId('chatgpt-signin-openclaw-start'))
    await screen.findByText(/needs a terminal on Windows/i)
    expect(
      screen.getByText('openclaw models auth login --provider openai-codex'),
    ).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
  })

  it('Cancel returns to idle (the abort kills the server-side child)', async () => {
    server.use(
      http.post('/api/auth/cli-login/hermes', () =>
        sse([
          { type: 'device-code', url: 'https://auth.openai.com/codex/device', code: 'AAAA-BBBB' },
        ]),
      ),
    )
    render(
      <ChatGptSignIn
        tool="hermes"
        loginCommand="hermes auth add openai-codex"
        onLoggedIn={vi.fn()}
      />,
    )
    await userEvent.click(screen.getByTestId('chatgpt-signin-hermes-start'))
    await screen.findByTestId('chatgpt-signin-hermes-cancel')
    await userEvent.click(screen.getByTestId('chatgpt-signin-hermes-cancel'))
    await waitFor(() =>
      expect(screen.getByTestId('chatgpt-signin-hermes-start')).toBeInTheDocument(),
    )
  })
})
