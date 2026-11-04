// Pasting a one-time sign-in link on the locked screen. The screen takes only the
// code, and only from a link for this dashboard, then posts it to its own page
// the way the server's sign-in page does. It never goes to the pasted address,
// never puts the code in the address bar, and stores nothing.

import { StrictMode } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { axe } from '@/__vitest__/axe'
import { server } from '@/__vitest__/mswServer'

import { AccessLock } from '../AccessLock'

const CODE = 'Wm9vbXpvb216b29tem9vbXpvb216b29t'

const GATE_401 = {
  error:
    'Clawboo access token required. Run `clawboo open` on the computer running Clawboo, ' +
    'or open /?access_token=<token> once to set a cookie.',
  gate: 'clawboo-access',
}

interface Submitted {
  method: string
  enctype: string
  /** Path and query of the resolved action. */
  target: string
  origin: string
}

let submitted: Submitted[]
let requests: string[]
const onRequest = ({ request }: { request: Request }) => {
  requests.push(new URL(request.url).pathname + new URL(request.url).search)
}

beforeEach(() => {
  submitted = []
  requests = []
  vi.spyOn(HTMLFormElement.prototype, 'submit').mockImplementation(function (
    this: HTMLFormElement,
  ) {
    const url = new URL(this.action)
    submitted.push({
      method: this.method,
      enctype: this.enctype,
      target: url.pathname + url.search,
      origin: url.origin,
    })
  })
  server.events.on('request:start', onRequest)
  window.history.replaceState(null, '', '/')
})

afterEach(() => {
  cleanup()
  // jsdom has no Navigation Timing; a test that needs it defines it.
  delete (window.performance as { getEntriesByType?: unknown }).getEntriesByType
  server.events.removeListener('request:start', onRequest)
  delete (globalThis as { __CLAWBOO_BASE__?: unknown }).__CLAWBOO_BASE__
  window.history.replaceState(null, '', '/')
  window.localStorage.clear()
  window.sessionStorage.clear()
})

/** This page load, as Navigation Timing reports it: `redirects` redirects brought it here. */
function arriveAfter(redirects: number) {
  Object.defineProperty(window.performance, 'getEntriesByType', {
    configurable: true,
    value: (type: string) => (type === 'navigation' ? [{ redirectCount: redirects }] : []),
  })
}

function locked() {
  server.use(http.get('/api/settings', () => HttpResponse.json(GATE_401, { status: 401 })))
}

async function renderLocked() {
  locked()
  const view = render(
    <AccessLock>
      <div data-testid="dashboard">dashboard</div>
    </AccessLock>,
  )
  await screen.findByTestId('access-locked')
  return view
}

function paste(text: string) {
  fireEvent.change(screen.getByLabelText('Paste a sign-in link'), { target: { value: text } })
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
}

function storedValues(): string[] {
  const out: string[] = []
  for (const store of [window.localStorage, window.sessionStorage]) {
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i)!
      out.push(key, store.getItem(key) ?? '')
    }
  }
  return out
}

describe('the locked screen: pasting a sign-in link', () => {
  it('has a field for the link and a Sign in button', async () => {
    await renderLocked()
    const field = screen.getByLabelText('Paste a sign-in link')
    expect(field).toHaveAttribute('autocomplete', 'off')
    expect(field).toHaveAttribute('autocapitalize', 'none')
    expect(field).toHaveAttribute('spellcheck', 'false')
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument()
  })

  it("posts a pasted link's code to this dashboard's own page, the way the sign-in page does", async () => {
    await renderLocked()
    const before = window.location.href
    paste(`${window.location.origin}/?access_code=${CODE}`)
    expect(submitted).toEqual([
      {
        method: 'post',
        enctype: 'application/x-www-form-urlencoded',
        target: `/?signin=pasted&access_code=${CODE}`,
        origin: window.location.origin,
      },
    ])
    // The code is never in the address bar, and nothing was fetched or stored.
    expect(window.location.href).toBe(before)
    expect(window.location.href).not.toContain(CODE)
    expect(requests).toEqual(['/api/settings'])
    expect(storedValues().join('\n')).not.toContain(CODE)
  })

  it('takes just the code too', async () => {
    await renderLocked()
    paste(`  ${CODE}\n`)
    expect(submitted.map((s) => s.target)).toEqual([`/?signin=pasted&access_code=${CODE}`])
  })

  it('posts under the mount when the dashboard is served under one', async () => {
    ;(globalThis as { __CLAWBOO_BASE__?: unknown }).__CLAWBOO_BASE__ = '/clawboo'
    await renderLocked()
    paste(`${window.location.origin}/clawboo/?access_code=${CODE}`)
    expect(submitted.map((s) => s.target)).toEqual([`/clawboo/?signin=pasted&access_code=${CODE}`])
  })

  it('refuses a link for another address with a plain message, and sends nothing', async () => {
    await renderLocked()
    paste(`https://evil.example/?access_code=${CODE}`)
    expect(screen.getByRole('alert')).toHaveTextContent(
      `That link is for https://evil.example, and this dashboard is at ${window.location.origin}.`,
    )
    expect(submitted).toEqual([])
    expect(requests).toEqual(['/api/settings'])
    expect(screen.getByLabelText('Paste a sign-in link')).toHaveAttribute('aria-invalid', 'true')
  })

  it('refuses a link for another dashboard at this address', async () => {
    ;(globalThis as { __CLAWBOO_BASE__?: unknown }).__CLAWBOO_BASE__ = '/clawboo'
    await renderLocked()
    paste(`${window.location.origin}/?access_code=${CODE}`)
    expect(screen.getByRole('alert')).toHaveTextContent(/another dashboard/i)
    expect(submitted).toEqual([])
  })

  it('refuses text that is not a sign-in link', async () => {
    await renderLocked()
    paste('https://example.com/some/page')
    expect(screen.getByRole('alert')).toHaveTextContent(/not a sign-in link/i)
    expect(submitted).toEqual([])
  })

  it('refuses a link that carries the access token, and never shows the token', async () => {
    await renderLocked()
    paste(`${window.location.origin}/?access_token=the-real-access-token`)
    expect(screen.getByRole('alert')).toHaveTextContent(/access token/i)
    expect(screen.getByRole('alert').textContent).not.toContain('the-real-access-token')
    expect(submitted).toEqual([])
  })

  it('asks for a link when the field is empty', async () => {
    await renderLocked()
    paste('')
    expect(screen.getByRole('alert')).toHaveTextContent('Paste a sign-in link first.')
    expect(submitted).toEqual([])
  })

  it('clears the message once the field changes', async () => {
    await renderLocked()
    paste('nope')
    expect(screen.getByRole('alert')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Paste a sign-in link'), { target: { value: 'n' } })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('has no accessibility violations, with or without a message', async () => {
    const { container } = await renderLocked()
    expect(await axe(container)).toHaveNoViolations()
    paste('nope')
    expect(await axe(container)).toHaveNoViolations()
  })
})

describe('the page after a pasted link was posted', () => {
  it('says the link did not sign in when the server refused it, and clears the mark', async () => {
    // A used or expired code: the gate redirects back without the cookie.
    window.history.replaceState(null, '', '/?signin=pasted')
    arriveAfter(1)
    await renderLocked()
    expect(screen.getByRole('alert')).toHaveTextContent(
      'That link did not sign you in. It had already been used, or its two minutes were up.',
    )
    expect(window.location.search).toBe('')
  })

  it('keeps that message under Strict Mode, which runs effects twice', async () => {
    window.history.replaceState(null, '', '/?signin=pasted')
    arriveAfter(1)
    locked()
    render(
      <StrictMode>
        <AccessLock>
          <div data-testid="dashboard">dashboard</div>
        </AccessLock>
      </StrictMode>,
    )
    await screen.findByTestId('access-locked')
    expect(screen.getByRole('alert')).toHaveTextContent(/did not sign you in/)
  })

  it('says nothing when no redirect brought the page here, as on a typed or shared address', async () => {
    // Only the gate's answer to the posted form arrives by a redirect, so an
    // address someone typed or sent with the mark in it says nothing.
    window.history.replaceState(null, '', '/?signin=pasted')
    arriveAfter(0)
    await renderLocked()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(window.location.search).toBe('')
  })

  it('says nothing where the browser cannot tell how the page arrived', async () => {
    window.history.replaceState(null, '', '/?signin=pasted')
    await renderLocked()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('loads the dashboard at a clean address when the link signed in', async () => {
    window.history.replaceState(null, '', '/?signin=pasted')
    arriveAfter(1)
    server.use(
      http.get('/api/settings', () => HttpResponse.json({ gatewayUrl: '', hasToken: false })),
    )
    render(
      <AccessLock>
        <div data-testid="dashboard">dashboard</div>
      </AccessLock>,
    )
    expect(await screen.findByTestId('dashboard')).toBeInTheDocument()
    expect(window.location.search).toBe('')
  })

  it('says nothing about a link on an ordinary locked screen', async () => {
    await renderLocked()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})
