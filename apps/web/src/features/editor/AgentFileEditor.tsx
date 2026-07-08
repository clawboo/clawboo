import { readAgentFile, writeAgentFile } from '@clawboo/control-client'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Save, X } from 'lucide-react'
import {
  EditorView,
  keymap,
  highlightActiveLine,
  drawSelection,
  placeholder,
} from '@codemirror/view'
import { EditorState, Compartment } from '@codemirror/state'
import { markdown } from '@codemirror/lang-markdown'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { closeBrackets } from '@codemirror/autocomplete'
import { highlightSelectionMatches } from '@codemirror/search'
import { AgentBooAvatar } from '@/components/AgentBooAvatar'
import { Button, IconButton } from '@/features/shared/Button'
import { Spinner } from '@/features/shared/Spinner'
import { AGENT_FILE_META, AGENT_FILE_PLACEHOLDERS, AGENT_FILE_NAMES } from '@clawboo/protocol'
import type { AgentFileName } from '@clawboo/protocol'
import { useConnectionStore } from '@/stores/connection'
import { useEditorStore } from '@/stores/editor'
import { useToastStore } from '@/stores/toast'
import { useGraphStore } from '@/features/graph/store'
import { mutationQueue } from '@/lib/mutationQueue'
import {
  stripPersonalityBlock,
  mergeSoulWithPersonality,
  isPersonalityValues,
} from '@/lib/soulPersonality'
import { clawbooEditorThemeDark, clawbooEditorThemeLight } from './editorTheme'
import { useTheme } from '@/features/theme/useTheme'

// ─── Constants ────────────────────────────────────────────────────────────────

const ALL_FILE_TABS: readonly AgentFileName[] = [...AGENT_FILE_NAMES]
const CORE_FILE_TABS: readonly AgentFileName[] = ['SOUL.md', 'IDENTITY.md', 'TOOLS.md', 'AGENTS.md']

interface FileState {
  content: string
  clean: string
}

type FilesMap = Record<string, FileState>

// ─── Component ────────────────────────────────────────────────────────────────

interface AgentFileEditorProps {
  agentId: string
  agentName: string
  onClose: () => void
}

export function AgentFileEditor({ agentId, agentName, onClose }: AgentFileEditorProps) {
  const client = useConnectionStore((s) => s.client)
  const { resolvedTheme } = useTheme()
  const editorThemeRef = useRef(resolvedTheme)
  editorThemeRef.current = resolvedTheme

  const [activeTab, setActiveTab] = useState<AgentFileName>('SOUL.md')
  const [files, setFiles] = useState<FilesMap>(() => {
    const init: FilesMap = {}
    for (const name of ALL_FILE_TABS) {
      init[name] = { content: '', clean: '' }
    }
    return init
  })

  // Dynamic visible tabs: core 4 always + extra files only when non-empty
  const visibleTabs = useMemo(() => {
    const extras = ALL_FILE_TABS.filter(
      (tab) => !(CORE_FILE_TABS as readonly string[]).includes(tab) && files[tab]?.clean.trim(),
    )
    return [...CORE_FILE_TABS, ...extras]
  }, [files])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  const editorContainerRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const loadIdRef = useRef(0)
  const activeTabRef = useRef(activeTab)
  const filesRef = useRef(files)
  const placeholderComp = useRef(new Compartment())

  // Keep refs in sync
  activeTabRef.current = activeTab
  filesRef.current = files

  // ─── File loading ─────────────────────────────────────────────────────────

  useEffect(() => {
    if (!client) return

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

        // Always strip any stale personality block from SOUL.md and re-merge
        // from SQLite (the source of truth for slider values). This handles two
        // scenarios: (a) Gateway content has no personality block (never written),
        // (b) Gateway has a stale personality block (old code overwrote the role
        // description, or values are out of date).
        const soulRaw = next['SOUL.md']?.content ?? ''
        try {
          const res = await fetch(`/api/personality?agentId=${encodeURIComponent(agentId)}`)
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
  }, [agentId, client])

  // ─── Refresh SOUL.md when personality sliders save ─────────────────────────

  const soulRefreshKey = useEditorStore((s) => s.soulRefreshKey)

  useEffect(() => {
    // Skip the initial render (key=0) — only react to increments
    if (soulRefreshKey === 0 || loading) return

    // Re-fetch personality from SQLite + re-merge into current SOUL.md
    void (async () => {
      try {
        const res = await fetch(`/api/personality?agentId=${encodeURIComponent(agentId)}`)
        const data = (await res.json()) as { values: unknown }
        if (data.values && isPersonalityValues(data.values)) {
          const currentSoul = filesRef.current['SOUL.md']?.content ?? ''
          const base = stripPersonalityBlock(currentSoul)
          const merged = mergeSoulWithPersonality(base, data.values)

          setFiles((prev) => ({
            ...prev,
            'SOUL.md': { content: merged, clean: merged },
          }))

          // Update CodeMirror if SOUL tab is active
          const view = viewRef.current
          if (view && activeTabRef.current === 'SOUL.md') {
            const currentDoc = view.state.doc.toString()
            if (currentDoc !== merged) {
              view.dispatch({
                changes: { from: 0, to: view.state.doc.length, insert: merged },
              })
            }
          }
        }
      } catch {
        // Non-fatal
      }
    })()
  }, [soulRefreshKey, agentId, loading])

  // ─── Save handler ─────────────────────────────────────────────────────────

  const handleSave = useCallback(async () => {
    if (!client) return

    const tab = activeTabRef.current
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

      if (tab === 'TOOLS.md' || tab === 'AGENTS.md') {
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
  }, [agentId, client])

  // ─── Save all dirty files (for close) ─────────────────────────────────────

  const saveAllDirty = useCallback(async () => {
    if (!client) return

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

    const hasGraphFiles = dirtyTabs.includes('TOOLS.md') || dirtyTabs.includes('AGENTS.md')
    if (hasGraphFiles) {
      useGraphStore.getState().triggerRefresh()
    }
  }, [agentId, client])

  // ─── Close handler ────────────────────────────────────────────────────────

  const handleClose = useCallback(async () => {
    await saveAllDirty()
    onClose()
  }, [saveAllDirty, onClose])

  // ─── CodeMirror setup ─────────────────────────────────────────────────────

  const handleSaveRef = useRef(handleSave)
  handleSaveRef.current = handleSave

  useEffect(() => {
    if (!editorContainerRef.current) return

    const comp = placeholderComp.current

    const state = EditorState.create({
      doc: '',
      extensions: [
        ...(resolvedTheme === 'light' ? clawbooEditorThemeLight : clawbooEditorThemeDark),
        markdown(),
        history(),
        highlightActiveLine(),
        drawSelection(),
        closeBrackets(),
        highlightSelectionMatches(),
        keymap.of([
          ...defaultKeymap,
          ...historyKeymap,
          {
            key: 'Mod-s',
            run: () => {
              void handleSaveRef.current()
              return true
            },
          },
        ]),
        EditorView.lineWrapping,
        comp.of(placeholder(AGENT_FILE_PLACEHOLDERS['SOUL.md'])),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            const newContent = update.state.doc.toString()
            const tab = activeTabRef.current
            setFiles((prev) => ({
              ...prev,
              [tab]: { ...prev[tab], content: newContent },
            }))
          }
        }),
      ],
    })

    const view = new EditorView({ state, parent: editorContainerRef.current })
    viewRef.current = view

    return () => {
      view.destroy()
      viewRef.current = null
    }
    // Recreate the editor instance when the resolved theme flips so the new
    // theme extensions take effect. Cheap — the editor unmount/remount stays
    // local and the active doc is restored by the tab-sync effect below.
  }, [resolvedTheme])

  // ─── Sync content when tab changes or loading finishes ──────────────────────
  // NOTE: files intentionally excluded from deps to avoid render loops.
  // The updateListener calls setFiles on every keystroke; including files
  // here would re-trigger this effect, dispatching into CodeMirror again.

  useEffect(() => {
    const view = viewRef.current
    if (!view || loading) return

    const fileState = filesRef.current[activeTab]
    if (!fileState) return

    const currentDoc = view.state.doc.toString()
    if (currentDoc !== fileState.content) {
      view.dispatch({
        changes: {
          from: 0,
          to: view.state.doc.length,
          insert: fileState.content,
        },
      })
    }

    // Update placeholder for this tab
    view.dispatch({
      effects: placeholderComp.current.reconfigure(placeholder(AGENT_FILE_PLACEHOLDERS[activeTab])),
    })
  }, [activeTab, loading])

  // ─── Escape key to close ──────────────────────────────────────────────────

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') void handleClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [handleClose])

  // ─── Derived state ────────────────────────────────────────────────────────

  const isDirty = (tab: AgentFileName) => {
    const f = files[tab]
    return f ? f.content !== f.clean : false
  }

  const anyDirty = ALL_FILE_TABS.some(isDirty)

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <div
      className="fixed inset-y-0 right-0 z-40 flex flex-col bg-background"
      style={{ left: 268 }}
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border bg-surface px-4 py-2.5">
        <div className="flex items-center gap-2.5">
          <AgentBooAvatar agentId={agentId} size={24} />
          <span className="text-[13px] font-semibold text-foreground" style={{ letterSpacing: '-0.01em' }}>
            {agentName}
          </span>
          <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-foreground/45">
            Edit Files
          </span>
        </div>

        <div className="flex items-center gap-2">
          {/* Save button */}
          <Button
            variant="primary"
            size="sm"
            disabled={!isDirty(activeTab)}
            loading={saving}
            onClick={() => void handleSave()}
          >
            {!saving && <Save size={14} strokeWidth={2} />}
            Save
          </Button>

          {/* Close button */}
          <IconButton size="sm" label="Close editor" onClick={() => void handleClose()}>
            <X size={16} strokeWidth={2} />
          </IconButton>
        </div>
      </div>

      {/* Tab bar */}
      <div className="flex items-center gap-1 border-b border-border bg-surface px-3">
        {visibleTabs.map((tab) => {
          const isActive = tab === activeTab
          const dirty = isDirty(tab)
          return (
            <button
              key={tab}
              type="button"
              onClick={() => setActiveTab(tab)}
              className={[
                'relative -mb-px inline-flex cursor-pointer items-center gap-1.5 px-3 pb-2.5 pt-2.5 font-mono text-[11px] uppercase tracking-[0.14em]',
                'transition-colors duration-150',
                isActive
                  ? 'font-semibold text-foreground'
                  : 'text-foreground/45 hover:text-foreground/75',
              ].join(' ')}
            >
              {tab.replace('.md', '')}
              {dirty && (
                <span
                  className="inline-block h-1.5 w-1.5 rounded-full"
                  style={{ background: 'var(--amber)' }}
                />
              )}
              <span
                aria-hidden
                className="absolute inset-x-0 -bottom-px h-0.5 rounded-full transition-opacity duration-150"
                style={{ background: 'var(--primary)', opacity: isActive ? 1 : 0 }}
              />
            </button>
          )
        })}
      </div>

      {/* Editor area — container always rendered so CodeMirror can mount */}
      <div className="relative flex-1 overflow-hidden">
        {loading && (
          <div className="absolute inset-0 z-[1] flex items-center justify-center gap-2 bg-background text-[13px] text-foreground/40">
            <Spinner size={16} />
            Loading files…
          </div>
        )}
        <div ref={editorContainerRef} style={{ height: '100%' }} />
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between border-t border-border bg-surface px-4 py-1.5 font-mono text-[11px] text-foreground/40">
        <span>{AGENT_FILE_META[activeTab].hint}</span>
        <span className="font-data">
          {anyDirty ? 'Unsaved changes' : 'All saved'}
          {' · '}
          {navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'}+S to save
        </span>
      </div>
    </div>
  )
}
