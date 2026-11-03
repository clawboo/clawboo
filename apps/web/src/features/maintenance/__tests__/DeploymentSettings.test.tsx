// The Deployment card in Settings > System: a setting an administrator pinned
// reads "Set by your administrator" and cannot be changed, and one they did not
// pin can be.

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { DeploymentSettings, type EffectiveSetting } from '../DeploymentSettings'

const apiFetch = vi.hoisted(() => vi.fn())
vi.mock('@clawboo/control-client', () => ({ apiFetch }))

const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status }))

function settings(overrides: Partial<Record<string, Partial<EffectiveSetting>>> = {}) {
  const base: EffectiveSetting[] = [
    {
      key: 'disableSelfUpdate',
      value: false,
      source: 'default',
      pinned: false,
      userEditable: false,
      env: 'CLAWBOO_DISABLE_SELF_UPDATE',
    },
    {
      key: 'disableBrowserAutostart',
      value: false,
      source: 'default',
      pinned: false,
      userEditable: true,
      env: 'CLAWBOO_DISABLE_BROWSER_AUTOSTART',
    },
    {
      key: 'catalogIndexUrl',
      value: null,
      source: 'default',
      pinned: false,
      userEditable: false,
      env: 'CLAWBOO_CATALOG_INDEX_URL',
    },
  ]
  return { settings: base.map((s) => ({ ...s, ...overrides[s.key] })) }
}

afterEach(() => {
  cleanup()
  apiFetch.mockReset()
})

describe('DeploymentSettings', () => {
  it('shows a pinned setting as set by the administrator, with no way to change it', async () => {
    apiFetch.mockImplementation(() =>
      json(
        settings({
          disableBrowserAutostart: { value: true, source: 'environment', pinned: true },
          disableSelfUpdate: { value: true, source: 'file', pinned: true },
          catalogIndexUrl: {
            value: 'https://mirror.example.com/i.json',
            source: 'file',
            pinned: true,
          },
        }),
      ),
    )
    render(<DeploymentSettings />)

    const toggle = await screen.findByRole('switch', {
      name: 'Start the browsers on a new install',
    })
    expect(toggle).toBeDisabled()
    expect(toggle).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByTestId('pinned-disableBrowserAutostart')).toHaveTextContent(
      'Set by your administrator',
    )
    expect(screen.getByTestId('pinned-disableSelfUpdate')).toBeInTheDocument()
    expect(screen.getByTestId('deployment-disableSelfUpdate')).toHaveTextContent('Off')
    expect(screen.getByTestId('deployment-catalogIndexUrl')).toHaveTextContent(
      'https://mirror.example.com/i.json',
    )
  })

  it('lets a person change a setting nobody pinned, and shows what the server saved', async () => {
    apiFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        expect(url).toBe('/api/system/operator-settings/disableBrowserAutostart')
        expect(JSON.parse(String(init.body))).toEqual({ value: true })
        return json({
          setting: {
            ...settings().settings[1],
            value: true,
            source: 'user',
          },
        })
      }
      return json(settings())
    })
    render(<DeploymentSettings />)

    const toggle = await screen.findByRole('switch', {
      name: 'Start the browsers on a new install',
    })
    expect(toggle).toBeEnabled()
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    expect(screen.queryByText('Set by your administrator')).toBeNull()

    await userEvent.click(toggle)
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'false'))
  })

  it('renders nothing when the server does not offer these settings', async () => {
    apiFetch.mockImplementation(() => json({ error: 'not found' }, 404))
    const { container } = render(<DeploymentSettings />)
    await waitFor(() => expect(apiFetch).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
  })
})
