import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { SelfVersionInfo, UseUpdateCheck } from '../useUpdateCheck'

// Mock the hook so the chip is driven by fixed props — no network / msw needed.
const hookState = vi.fn()
vi.mock('../useUpdateCheck', () => ({ useUpdateCheck: (): UseUpdateCheck => hookState() }))

// Mock the SSE client so clicking "Update now" doesn't hit a real endpoint.
const consumeApiSSE = vi.fn()
vi.mock('@clawboo/control-client', () => ({
  consumeApiSSE: (...args: unknown[]) => consumeApiSSE(...args),
}))

import { UpdateChip } from '../UpdateChip'

const writeText = vi.fn().mockResolvedValue(undefined)

beforeEach(() => {
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function info(over: Partial<SelfVersionInfo> = {}): SelfVersionInfo {
  return {
    current: '0.3.0',
    latest: '0.4.0',
    updateAvailable: true,
    updateCommand: 'npm install -g clawboo@latest',
    installMethod: 'global',
    applyable: true,
    isDeprecated: false,
    checkedAt: 1,
    ...over,
  }
}

function setHook(over: Partial<UseUpdateCheck> = {}): { dismiss: ReturnType<typeof vi.fn> } {
  const dismiss = vi.fn()
  hookState.mockReturnValue({ info: info(), shouldShow: true, dismiss, recheck: vi.fn(), ...over })
  return { dismiss }
}

describe('UpdateChip', () => {
  it('renders the pill with the label + target-only version + click-to-update CTA (global)', () => {
    setHook()
    render(<UpdateChip />)
    expect(screen.getByTestId('update-chip')).toBeInTheDocument()
    expect(screen.getByText('Update available')).toBeInTheDocument()
    const ver = screen.getByTestId('update-chip-version')
    expect(ver).toHaveTextContent('v0.4.0')
    expect(ver).toHaveTextContent(/click to update/i)
    // only the target version — never the current one
    expect(ver).not.toHaveTextContent('0.3.0')
  })

  it('renders nothing when shouldShow is false', () => {
    setHook({ shouldShow: false })
    const { container } = render(<UpdateChip />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows ONLY the newest version (accumulated releases collapse to latest)', () => {
    // Behind several releases → the endpoint returns npm's single `latest`.
    hookState.mockReturnValue({
      info: info({ latest: '0.9.0' }),
      shouldShow: true,
      dismiss: vi.fn(),
      recheck: vi.fn(),
    })
    render(<UpdateChip />)
    const ver = screen.getByTestId('update-chip-version')
    expect(ver).toHaveTextContent('v0.9.0')
    expect(ver).not.toHaveTextContent('0.3.0')
  })

  it('one click on a global install starts the in-app update (no popover)', async () => {
    const user = userEvent.setup()
    setHook()
    render(<UpdateChip />)
    await user.click(screen.getByTestId('update-chip-action'))
    // Fires the SSE apply directly — no intermediate confirm/popover.
    expect(consumeApiSSE).toHaveBeenCalledWith(
      '/api/system/self-update',
      { method: 'POST' },
      expect.anything(),
    )
    // The chip flips to an inline progress state.
    expect(screen.getByText(/installing update/i)).toBeInTheDocument()
  })

  it('one click on an npx install copies the command instead of self-updating', async () => {
    hookState.mockReturnValue({
      info: info({ installMethod: 'npx', applyable: false, updateCommand: 'npx clawboo@latest' }),
      shouldShow: true,
      dismiss: vi.fn(),
      recheck: vi.fn(),
    })
    render(<UpdateChip />)
    // npx path shows "Copy command", not "Click to update".
    expect(screen.getByTestId('update-chip-version')).toHaveTextContent(/copy command/i)
    fireEvent.click(screen.getByTestId('update-chip-action'))
    expect(writeText).toHaveBeenCalledWith('npx clawboo@latest')
    expect(consumeApiSSE).not.toHaveBeenCalled()
    expect(await screen.findByText(/copied/i)).toBeInTheDocument()
  })

  it('the × dismisses via the hook', async () => {
    const user = userEvent.setup()
    const { dismiss } = setHook()
    render(<UpdateChip />)
    await user.click(screen.getByTestId('update-chip-dismiss'))
    expect(dismiss).toHaveBeenCalledOnce()
  })
})
