// The update chip's data. A browser keeps the last answer for an hour, and that
// answer can say "update available" after an administrator turned in-app updates
// off, so the chip waits for this page load's own answer.

import { cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { SelfVersionInfo } from '../useUpdateCheck'

const apiFetch = vi.hoisted(() => vi.fn())
vi.mock('@clawboo/control-client', () => ({ apiFetch }))

import { useUpdateCheck } from '../useUpdateCheck'

function info(over: Partial<SelfVersionInfo> = {}): SelfVersionInfo {
  return {
    current: '0.5.0',
    latest: '0.6.0',
    updateAvailable: true,
    updateCommand: 'npm install -g clawboo@latest',
    installMethod: 'global',
    applyable: true,
    isDeprecated: false,
    checkedAt: 1,
    ...over,
  }
}

const cache = (value: SelfVersionInfo) =>
  window.localStorage.setItem(
    'clawboo.updateCheck',
    JSON.stringify({ info: value, fetchedAt: Date.now() }),
  )

beforeEach(() => window.localStorage.clear())
afterEach(() => {
  cleanup()
  apiFetch.mockReset()
})

describe('useUpdateCheck', () => {
  it('does not show a cached update the server no longer offers', async () => {
    cache(info())
    // Updates were turned off since: the server answers as `?local=1` does.
    apiFetch.mockResolvedValue(
      new Response(
        JSON.stringify(info({ latest: null, updateAvailable: false, applyable: false })),
      ),
    )
    const { result } = renderHook(() => useUpdateCheck())

    expect(result.current.shouldShow).toBe(false)
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(result.current.info?.updateAvailable).toBe(false))
    expect(result.current.shouldShow).toBe(false)
  })

  it('shows an update once this page load has confirmed it', async () => {
    cache(info())
    apiFetch.mockResolvedValue(new Response(JSON.stringify(info())))
    const { result } = renderHook(() => useUpdateCheck())

    await waitFor(() => expect(result.current.shouldShow).toBe(true))
  })

  it('reuses a cached "no update" without asking again', async () => {
    cache(info({ updateAvailable: false }))
    const { result } = renderHook(() => useUpdateCheck())

    await new Promise((r) => setTimeout(r, 0))
    expect(apiFetch).not.toHaveBeenCalled()
    expect(result.current.shouldShow).toBe(false)
  })
})
