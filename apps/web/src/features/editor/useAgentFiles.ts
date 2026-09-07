import { apiFetch, readAgentFile, writeAgentFile } from '@clawboo/control-client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { AGENT_FILE_NAMES, type AgentFileName } from '@clawboo/protocol'
import { useEditorStore } from '@/stores/editor'
import { useToastStore } from '@/stores/toast'
import { useGraphStore } from '@/features/graph/store'
import { mutationQueue } from '@/lib/mutationQueue'
import {
  stripPersonalityBlock,
  mergeSoulWithPersonality,
  isPersonalityValues,
} from '@/lib/soulPersonality'

// ─── Types ───────────────────────────────────────────────────────────────────

export interface FileState {
  content: string
  clean: string
}

export type FilesMap = Record<string, FileState>

/** The 4 core files that always appear as tabs (even when empty). */
export const CORE_FILE_TABS = [
  'SOUL.md',
  'IDENTITY.md',
  'TOOLS.md',
  'AGENTS.md',
] as const satisfies readonly AgentFileName[]

/** All 7 OpenClaw agent files. Extra files appear as tabs only when non-empty. */
export const ALL_FILE_TABS: readonly AgentFileName[] = [...AGENT_FILE_NAMES]

/** @deprecated Use CORE_FILE_TABS or ALL_FILE_TABS instead */
export const EDITOR_TABS = CORE_FILE_TABS

// ─── Hook ────────────────────────────────────────────────────────────────────

export interface UseAgentFilesReturn {
  files: FilesMap
  loading: boolean
  saving: boolean
  isDirty: (tab: AgentFileName) => boolean
  anyDirty: boolean
  /** Returns true if the file has non-empty content (loaded from the API). */
  fileExists: (tab: AgentFileName) => boolean
  handleSave: (tab: AgentFileName) => Promise<void>
  saveAllDirty: () => Promise<void>
  updateFileContent: (tab: AgentFileName, content: string) => void
}

export function useAgentFiles(agentId: string): UseAgentFilesReturn {
  const [files, setFiles] = useState<FilesMap>(() => {
    const init: FilesMap = {}
    for (const name of ALL_FILE_TABS) {
      init[name] = { content: '', clean: '' }
    }
    return init
  })
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  const loadIdRef = useRef(0)
  const filesRef = useRef(files)
  filesRef.current = files

  // ─── File loading ──────────────────────────────────────────────────────────

  // No Gateway gate here. readAgentFile / writeAgentFile are apiFetch calls to
  // clawboo's own /api/agents/:id/files/:name, which every agent source serves.
  // Gating them on a connected GatewayClient left every file tab blank and every
  // save a silent no-op on any install without OpenClaw attached.
  useEffect(() => {
    const loadId = ++loadIdRef.current
    setLoading(true)

    Promise.all(ALL_FILE_TABS.map((name) => readAgentFile(agentId, name).catch(() => ''))).then(
      async (results) => {
        if (loadId !== loadIdRef.current) return // stale

        const next: FilesMap = {}
        ALL_FILE_TABS.forEach((name, i) => {
          const content = results[i] ?? ''
          next[name] = { content, clean: content }
        })

        // Strip stale personality block from SOUL.md and re-merge from SQLite
        const soulRaw = next['SOUL.md']?.content ?? ''
        try {
          const res = await apiFetch(`/api/personality?agentId=${encodeURIComponent(agentId)}`)
          const data = (await res.json()) as { values: unknown }
          if (data.values && isPersonalityValues(data.values)) {
            const base = stripPersonalityBlock(soulRaw)
            const merged = mergeSoulWithPersonality(base, data.values)
            next['SOUL.md'] = { content: merged, clean: merged }
          }
        } catch {
          // Non-fatal — personality data not merged
        }

        setFiles(next)
        setLoading(false)
      },
    )
  }, [agentId])

  // ─── Refresh SOUL.md when personality sliders save ─────────────────────────

  const soulRefreshKey = useEditorStore((s) => s.soulRefreshKey)

  useEffect(() => {
    if (soulRefreshKey === 0 || loading) return

    void (async () => {
      try {
        const res = await apiFetch(`/api/personality?agentId=${encodeURIComponent(agentId)}`)
        const data = (await res.json()) as { values: unknown }
        if (data.values && isPersonalityValues(data.values)) {
          const currentSoul = filesRef.current['SOUL.md']?.content ?? ''
          const base = stripPersonalityBlock(currentSoul)
          const merged = mergeSoulWithPersonality(base, data.values)

          setFiles((prev) => ({
            ...prev,
            'SOUL.md': { content: merged, clean: merged },
          }))
        }
      } catch {
        // Non-fatal
      }
    })()
  }, [soulRefreshKey, agentId, loading])

  // ─── Save handler ──────────────────────────────────────────────────────────

  const handleSave = useCallback(
    async (tab: AgentFileName) => {
      const fileState = filesRef.current[tab]
      if (!fileState || fileState.content === fileState.clean) return

      setSaving(true)
      try {
        const contentToSave = fileState.content
        await mutationQueue.enqueue(agentId, () => writeAgentFile(agentId, tab, contentToSave))

        setFiles((prev) => ({
          ...prev,
          [tab]: { ...prev[tab], clean: contentToSave },
        }))

        useToastStore.getState().addToast({ message: `Saved ${tab}`, type: 'success' })

        // ONLY AGENTS.md. The graph refresh refetches capabilities + AGENTS.md
        // (useGraphData parses it into `dep-` edges); it never reads TOOLS.md,
        // so firing it there redrew a byte-identical graph and told the user
        // their edit had landed somewhere it had not.
        if (tab === 'AGENTS.md') {
          useGraphStore.getState().triggerRefresh()
        }
      } catch (err) {
        useToastStore.getState().addToast({
          message: `Failed to save ${tab}: ${err instanceof Error ? err.message : 'Unknown error'}`,
          type: 'error',
        })
      } finally {
        setSaving(false)
      }
    },
    [agentId],
  )

  // ─── Save all dirty files ─────────────────────────────────────────────────

  const saveAllDirty = useCallback(async () => {
    const currentFiles = filesRef.current
    const dirtyTabs = ALL_FILE_TABS.filter(
      (name) => currentFiles[name] && currentFiles[name].content !== currentFiles[name].clean,
    )
    if (dirtyTabs.length === 0) return

    for (const tab of dirtyTabs) {
      try {
        const contentToSave = currentFiles[tab].content
        await mutationQueue.enqueue(agentId, () => writeAgentFile(agentId, tab, contentToSave))
      } catch {
        // best-effort on close
      }
    }

    if (dirtyTabs.includes('AGENTS.md')) {
      useGraphStore.getState().triggerRefresh()
    }
  }, [agentId])

  // ─── Update file content (called by CodeMirror updateListener) ────────────

  const updateFileContent = useCallback((tab: AgentFileName, content: string) => {
    setFiles((prev) => ({
      ...prev,
      [tab]: { ...prev[tab], content },
    }))
  }, [])

  // ─── Derived state ────────────────────────────────────────────────────────

  const isDirty = useCallback(
    (tab: AgentFileName) => {
      const f = files[tab]
      return f ? f.content !== f.clean : false
    },
    [files],
  )

  const anyDirty = ALL_FILE_TABS.some((tab) => {
    const f = files[tab]
    return f ? f.content !== f.clean : false
  })

  const fileExists = useCallback(
    (tab: AgentFileName) => {
      const f = files[tab]
      return f ? f.clean.trim().length > 0 : false
    },
    [files],
  )

  return {
    files,
    loading,
    saving,
    isDirty,
    anyDirty,
    fileExists,
    handleSave,
    saveAllDirty,
    updateFileContent,
  }
}
