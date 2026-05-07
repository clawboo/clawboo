// useTeamOnboarding — fetches and mutates per-team onboarding state from the
// /api/teams/:id/onboarding endpoint. Used by GroupChatView to gate the
// normal chat composer behind the "Know Your Team" + user introduction flow.

import { useCallback, useEffect, useRef, useState } from 'react'

export interface TeamOnboardingState {
  agentsIntroduced: boolean
  userIntroduced: boolean
  userIntroText: string
}

export interface UseTeamOnboardingResult extends TeamOnboardingState {
  isLoading: boolean
  error: string | null
  markAgentsIntroduced: () => Promise<void>
  markUserIntroduced: (introText: string) => Promise<void>
  reload: () => Promise<void>
}

const DEFAULT_STATE: TeamOnboardingState = {
  agentsIntroduced: false,
  userIntroduced: false,
  userIntroText: '',
}

export function useTeamOnboarding(teamId: string | null): UseTeamOnboardingResult {
  const [state, setState] = useState<TeamOnboardingState>(DEFAULT_STATE)
  const [isLoading, setIsLoading] = useState<boolean>(true)
  const [error, setError] = useState<string | null>(null)

  // Track whether the component is still mounted to avoid setState after unmount
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const fetchState = useCallback(async (id: string) => {
    setIsLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/teams/${encodeURIComponent(id)}/onboarding`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = (await res.json()) as TeamOnboardingState
      if (mountedRef.current) {
        setState({
          agentsIntroduced: Boolean(data.agentsIntroduced),
          userIntroduced: Boolean(data.userIntroduced),
          userIntroText: typeof data.userIntroText === 'string' ? data.userIntroText : '',
        })
      }
    } catch (err) {
      if (mountedRef.current) {
        setError(err instanceof Error ? err.message : String(err))
        setState(DEFAULT_STATE)
      }
    } finally {
      if (mountedRef.current) setIsLoading(false)
    }
  }, [])

  // Hydrate on teamId change
  useEffect(() => {
    if (!teamId) {
      setState(DEFAULT_STATE)
      setIsLoading(false)
      return
    }
    void fetchState(teamId)
  }, [teamId, fetchState])

  const patch = useCallback(
    async (body: Partial<TeamOnboardingState>): Promise<void> => {
      if (!teamId) return
      try {
        const res = await fetch(`/api/teams/${encodeURIComponent(teamId)}/onboarding`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const next = (await res.json()) as TeamOnboardingState
        if (mountedRef.current) {
          setState({
            agentsIntroduced: Boolean(next.agentsIntroduced),
            userIntroduced: Boolean(next.userIntroduced),
            userIntroText: typeof next.userIntroText === 'string' ? next.userIntroText : '',
          })
        }
      } catch (err) {
        if (mountedRef.current) {
          setError(err instanceof Error ? err.message : String(err))
        }
      }
    },
    [teamId],
  )

  const markAgentsIntroduced = useCallback(() => patch({ agentsIntroduced: true }), [patch])
  const markUserIntroduced = useCallback(
    (introText: string) => patch({ userIntroduced: true, userIntroText: introText }),
    [patch],
  )
  const reload = useCallback(async () => {
    if (teamId) await fetchState(teamId)
  }, [teamId, fetchState])

  return {
    agentsIntroduced: state.agentsIntroduced,
    userIntroduced: state.userIntroduced,
    userIntroText: state.userIntroText,
    isLoading,
    error,
    markAgentsIntroduced,
    markUserIntroduced,
    reload,
  }
}
