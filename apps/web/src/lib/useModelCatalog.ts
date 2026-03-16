import { useState, useEffect } from 'react'
import { MODEL_GROUPS, type ModelGroup } from './modelCatalog'

let dynamicCache: ModelGroup[] | null = null
let fetchPromise: Promise<void> | null = null

async function fetchDynamic(): Promise<void> {
  try {
    const res = await fetch('/api/system/models')
    const data = (await res.json()) as { groups: ModelGroup[] | null }
    if (data.groups && data.groups.length > 0) {
      dynamicCache = data.groups
    }
  } catch {
    // Use static fallback
  }
}

export function useModelCatalog(): ModelGroup[] {
  const [groups, setGroups] = useState<ModelGroup[]>(dynamicCache ?? MODEL_GROUPS)

  useEffect(() => {
    if (dynamicCache) {
      setGroups(dynamicCache)
      return
    }
    if (!fetchPromise) {
      fetchPromise = fetchDynamic()
    }
    void fetchPromise.then(() => {
      if (dynamicCache) setGroups(dynamicCache)
    })
  }, [])

  return groups
}
