import { useState, useEffect } from 'react'
import { MODEL_GROUPS, type ModelGroup } from './modelCatalog'

export interface ModelCatalogResult {
  groups: ModelGroup[]
  configuredProviders: Set<string>
}

let dynamicCache: ModelGroup[] | null = null
let configuredCache: Set<string> = new Set()
let fetchPromise: Promise<void> | null = null

async function fetchDynamic(): Promise<void> {
  try {
    const res = await fetch('/api/system/models')
    const data = (await res.json()) as {
      groups: ModelGroup[] | null
      configuredProviders?: string[]
    }
    if (data.groups && data.groups.length > 0) {
      dynamicCache = data.groups
    }
    if (Array.isArray(data.configuredProviders)) {
      configuredCache = new Set(data.configuredProviders)
    }
  } catch {
    // Use static fallback
  }
}

export function useModelCatalog(): ModelCatalogResult {
  const [groups, setGroups] = useState<ModelGroup[]>(dynamicCache ?? MODEL_GROUPS)
  const [configured, setConfigured] = useState<Set<string>>(configuredCache)

  useEffect(() => {
    if (dynamicCache) {
      setGroups(dynamicCache)
      setConfigured(configuredCache)
      return
    }
    if (!fetchPromise) {
      fetchPromise = fetchDynamic()
    }
    void fetchPromise.then(() => {
      if (dynamicCache) setGroups(dynamicCache)
      setConfigured(configuredCache)
    })
  }, [])

  return { groups, configuredProviders: configured }
}
