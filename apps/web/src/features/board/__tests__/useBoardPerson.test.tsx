// Who "you" is decides what Mine shows, on the Board and in the Inbox. A read that fails
// must not leave that list wrong until someone reloads the page.

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fetchBoardPerson = vi.hoisted(() => vi.fn())
vi.mock('@/lib/boardClient', () => ({ fetchBoardPerson }))

const { BOARD_PERSON_RETRY_MS, resetBoardPerson, useBoardPerson } =
  await import('../useBoardPerson')

const PRIYA = { id: 'p-priya', name: 'Priya', role: null }

beforeEach(() => {
  vi.useFakeTimers()
  resetBoardPerson()
  fetchBoardPerson.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('useBoardPerson', () => {
  it('tries a failed read again while something still asks', async () => {
    fetchBoardPerson.mockResolvedValueOnce(null).mockResolvedValueOnce(PRIYA)
    const { result } = renderHook(() => useBoardPerson())
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(result.current.id).not.toBe(PRIYA.id)

    await act(() => vi.advanceTimersByTimeAsync(BOARD_PERSON_RETRY_MS))
    expect(result.current).toEqual(PRIYA)
    expect(fetchBoardPerson).toHaveBeenCalledTimes(2)

    // Known now, so that was the last read.
    await act(() => vi.advanceTimersByTimeAsync(BOARD_PERSON_RETRY_MS * 3))
    expect(fetchBoardPerson).toHaveBeenCalledTimes(2)
  })

  it('stops trying once nothing asks', async () => {
    fetchBoardPerson.mockResolvedValue(null)
    const { unmount } = renderHook(() => useBoardPerson())
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(fetchBoardPerson).toHaveBeenCalledTimes(1)

    unmount()
    await vi.advanceTimersByTimeAsync(BOARD_PERSON_RETRY_MS * 3)
    expect(fetchBoardPerson).toHaveBeenCalledTimes(1)
  })

  it('reads nothing for a card that never asks who you are', async () => {
    renderHook(() => useBoardPerson(false))
    await act(() => vi.advanceTimersByTimeAsync(BOARD_PERSON_RETRY_MS))
    expect(fetchBoardPerson).not.toHaveBeenCalled()
  })
})
