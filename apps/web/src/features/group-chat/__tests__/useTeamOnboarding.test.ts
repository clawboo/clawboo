// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useTeamOnboarding } from '../useTeamOnboarding'

// Mock the global fetch — we never want real network requests in unit tests.
const mockFetch = vi.fn()

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch)
  mockFetch.mockReset()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response
}

describe('useTeamOnboarding', () => {
  it('hydrates state from GET /api/teams/:id/onboarding on mount', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ agentsIntroduced: true, userIntroduced: false }))

    const { result } = renderHook(() => useTeamOnboarding('team-1'))

    expect(result.current.isLoading).toBe(true)

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })

    expect(result.current.agentsIntroduced).toBe(true)
    expect(result.current.userIntroduced).toBe(false)
    expect(mockFetch).toHaveBeenCalledWith('/api/teams/team-1/onboarding')
  })

  it('defaults to false/false when teamId is null and never fetches', async () => {
    const { result } = renderHook(() => useTeamOnboarding(null))

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })

    expect(result.current.agentsIntroduced).toBe(false)
    expect(result.current.userIntroduced).toBe(false)
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('markAgentsIntroduced PATCHes the endpoint and updates state', async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ agentsIntroduced: false, userIntroduced: false }))
      .mockResolvedValueOnce(jsonResponse({ agentsIntroduced: true, userIntroduced: false }))

    const { result } = renderHook(() => useTeamOnboarding('team-1'))

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })

    await act(async () => {
      await result.current.markAgentsIntroduced()
    })

    expect(result.current.agentsIntroduced).toBe(true)
    expect(mockFetch).toHaveBeenLastCalledWith('/api/teams/team-1/onboarding', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentsIntroduced: true }),
    })
  })

  it('markUserIntroduced PATCHes the endpoint with intro text and updates state', async () => {
    mockFetch
      .mockResolvedValueOnce(
        jsonResponse({ agentsIntroduced: true, userIntroduced: false, userIntroText: '' }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          agentsIntroduced: true,
          userIntroduced: true,
          userIntroText: 'Hi I am Sanju',
        }),
      )

    const { result } = renderHook(() => useTeamOnboarding('team-1'))

    await waitFor(() => expect(result.current.isLoading).toBe(false))

    await act(async () => {
      await result.current.markUserIntroduced('Hi I am Sanju')
    })

    expect(result.current.userIntroduced).toBe(true)
    // Critical regression guard: the intro text MUST be sent to the server.
    // Previously markUserIntroduced took no arg and the user's actual intro
    // never made it into SQLite, so it never landed in the context preamble.
    expect(result.current.userIntroText).toBe('Hi I am Sanju')
    expect(mockFetch).toHaveBeenLastCalledWith('/api/teams/team-1/onboarding', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userIntroduced: true, userIntroText: 'Hi I am Sanju' }),
    })
  })

  it('records error and falls back to defaults on fetch failure', async () => {
    mockFetch.mockRejectedValueOnce(new Error('network down'))

    const { result } = renderHook(() => useTeamOnboarding('team-1'))

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })

    expect(result.current.error).toBe('network down')
    expect(result.current.agentsIntroduced).toBe(false)
    expect(result.current.userIntroduced).toBe(false)
  })

  it('reload re-fetches state from the server', async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ agentsIntroduced: false, userIntroduced: false }))
      .mockResolvedValueOnce(jsonResponse({ agentsIntroduced: true, userIntroduced: true }))

    const { result } = renderHook(() => useTeamOnboarding('team-1'))

    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.agentsIntroduced).toBe(false)

    await act(async () => {
      await result.current.reload()
    })

    expect(result.current.agentsIntroduced).toBe(true)
    expect(result.current.userIntroduced).toBe(true)
  })
})
