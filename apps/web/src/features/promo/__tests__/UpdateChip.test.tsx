import type { EngineCapabilities, SSEHandlers } from '@clawboo/control-client'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { SelfVersionInfo, UseUpdateCheck } from '../useUpdateCheck'

// Mock the hook so the chip is driven by fixed props — no network / msw needed.
const hookState = vi.fn()
vi.mock('../useUpdateCheck', () => ({ useUpdateCheck: (): UseUpdateCheck => hookState() }))

// Mock the SSE client so clicking "Update now" doesn't hit a real endpoint, and
// the capabilities read the restart poll makes.
const consumeApiSSE = vi.fn()
const fetchEngineCapabilities = vi.fn<() => Promise<EngineCapabilities | null>>()
vi.mock('@clawboo/control-client', () => ({
  consumeApiSSE: (...args: unknown[]) => consumeApiSSE(...args),
  fetchEngineCapabilities: () => fetchEngineCapabilities(),
}))

import { UpdateChip } from '../UpdateChip'

const writeText = vi.fn().mockResolvedValue(undefined)

beforeEach(() => {
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.useRealTimers()
  vi.unstubAllGlobals()
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

  describe('after the server restarts into the update', () => {
    function caps(version: string): EngineCapabilities {
      return { version, apiRevision: 1, supportFloor: '0.3', features: {} }
    }

    /** Click update, then deliver the stream's `restarting` event. */
    function restart(): void {
      fireEvent.click(screen.getByTestId('update-chip-action'))
      const handlers = consumeApiSSE.mock.calls[0]?.[2] as SSEHandlers
      act(() => handlers.onEvent?.({ type: 'restarting', port: 18790, version: '0.4.0' }))
    }

    it('reloads only once an engine on a new version answers', async () => {
      vi.useFakeTimers()
      const reload = vi.fn()
      // jsdom's location.reload cannot be spied on; swap the object (see ErrorBoundary.test).
      vi.stubGlobal('location', { ...window.location, reload })
      fetchEngineCapabilities
        .mockResolvedValueOnce(null) // nothing listening yet
        .mockResolvedValueOnce(caps('0.3.0')) // the old server, still on its way out
        .mockResolvedValue(caps('0.4.0'))
      setHook()
      render(<UpdateChip />)
      restart()

      await vi.advanceTimersByTimeAsync(2_000)
      expect(reload).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1_000)
      expect(reload).toHaveBeenCalledOnce()
    })

    it('asks for a manual restart when no new version ever answers', async () => {
      vi.useFakeTimers()
      const reload = vi.fn()
      vi.stubGlobal('location', { ...window.location, reload })
      fetchEngineCapabilities.mockResolvedValue(caps('0.3.0'))
      setHook()
      render(<UpdateChip />)
      restart()

      await act(async () => {
        await vi.advanceTimersByTimeAsync(91_000)
      })
      expect(reload).not.toHaveBeenCalled()
      expect(screen.getByText(/restart clawboo to finish/i)).toBeInTheDocument()
    })
  })

  it('says it is waiting for agent runs, and Restart now asks the server to stop waiting', () => {
    setHook()
    render(<UpdateChip />)
    fireEvent.click(screen.getByTestId('update-chip-action'))
    const handlers = consumeApiSSE.mock.calls[0]?.[2] as SSEHandlers
    act(() => handlers.onEvent?.({ type: 'installed', version: '0.4.0' }))
    act(() =>
      handlers.onEvent?.({
        type: 'progress',
        step: 'waiting',
        running: 2,
        message: 'Waiting for 2 agent runs to finish before restarting.',
      }),
    )
    expect(screen.getByTestId('update-chip-waiting')).toHaveTextContent(
      'Waiting for 2 agent runs to finish before restarting.',
    )

    fireEvent.click(screen.getByTestId('update-chip-restart-now'))
    expect(consumeApiSSE).toHaveBeenCalledTimes(2)
    expect(consumeApiSSE.mock.calls[1]?.[0]).toBe('/api/system/self-update')
    expect(consumeApiSSE.mock.calls[1]?.[1]).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ force: true }),
    })

    // The first stream reports the restart, as it does without a wait.
    act(() => handlers.onEvent?.({ type: 'restarting', port: 18790, version: '0.4.0' }))
    expect(screen.getByText(/restarting/i)).toBeInTheDocument()
    expect(screen.queryByTestId('update-chip-restart-now')).not.toBeInTheDocument()
  })

  it('keeps watching for the new version when the stream drops while it waits', async () => {
    vi.useFakeTimers()
    const reload = vi.fn()
    vi.stubGlobal('location', { ...window.location, reload })
    fetchEngineCapabilities
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ version: '0.4.0', apiRevision: 1, supportFloor: '0.3', features: {} })
    setHook()
    render(<UpdateChip />)
    fireEvent.click(screen.getByTestId('update-chip-action'))
    const handlers = consumeApiSSE.mock.calls[0]?.[2] as SSEHandlers
    act(() =>
      handlers.onEvent?.({
        type: 'progress',
        step: 'waiting',
        running: 1,
        message: 'Waiting for 1 agent run to finish before restarting.',
      }),
    )
    act(() => handlers.onError?.({ type: 'error', message: 'network error' }))
    expect(screen.queryByText(/network error/i)).not.toBeInTheDocument()
    expect(screen.getByText(/restarting/i)).toBeInTheDocument()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000)
    })
    expect(reload).toHaveBeenCalledOnce()
  })

  it('the × dismisses via the hook', async () => {
    const user = userEvent.setup()
    const { dismiss } = setHook()
    render(<UpdateChip />)
    await user.click(screen.getByTestId('update-chip-dismiss'))
    expect(dismiss).toHaveBeenCalledOnce()
  })
})
