// The chat models the local Ollama has pulled, via GET /api/providers/ollama/models
// (the server reads Ollama's /api/tags and drops embedding-only models). No module
// cache, unlike the keyed providers' lists: the answer changes the moment the user
// runs `ollama pull`, and asking a local daemon is cheap, so a surface asks when it
// opens and again whenever the user checks again.

import { useCallback, useEffect, useRef, useState } from 'react'

import { fetchOllamaModels, type OllamaModelList } from '@clawboo/control-client'

export interface OllamaModelsState extends OllamaModelList {
  /** False until the first answer lands. */
  loaded: boolean
  /** True while a request is in flight. */
  checking: boolean
  /** Ask again, after an `ollama pull`. */
  refresh: () => Promise<void>
}

const EMPTY: OllamaModelList = { reachable: null, models: [], recommendedModel: null }

/** The pulled Ollama models. Asks only while `enabled`, so a surface where Ollama
 *  isn't in play never probes the local daemon. */
export function useOllamaModels(enabled: boolean): OllamaModelsState {
  const [list, setList] = useState<OllamaModelList>(EMPTY)
  const [loaded, setLoaded] = useState(false)
  const [checking, setChecking] = useState(false)
  // Only the newest request may land, so a slow first answer can't overwrite
  // the one a later "check again" already showed.
  const seq = useRef(0)

  const refresh = useCallback(async (): Promise<void> => {
    const mine = ++seq.current
    setChecking(true)
    const next = await fetchOllamaModels()
    if (mine !== seq.current) return
    setList(next)
    setLoaded(true)
    setChecking(false)
  }, [])

  useEffect(() => {
    if (enabled) void refresh()
  }, [enabled, refresh])

  return { ...list, loaded, checking, refresh }
}
