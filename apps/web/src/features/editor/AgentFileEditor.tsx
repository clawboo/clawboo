'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, Save, X } from 'lucide-react'
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
import { BooAvatar } from '@clawboo/ui'
import { AGENT_FILE_META, AGENT_FILE_PLACEHOLDERS } from '@clawboo/protocol'
import type { AgentFileName } from '@clawboo/protocol'
import { useConnectionStore } from '@/stores/connection'
import { useToastStore } from '@/stores/toast'
import { useGraphStore } from '@/features/graph/store'
import { mutationQueue } from '@/lib/mutationQueue'
import { clawbooEditorTheme } from './editorTheme'

// ─── Constants ────────────────────────────────────────────────────────────────

const EDITOR_TABS: AgentFileName[] = ['SOUL.md', 'IDENTITY.md', 'TOOLS.md', 'AGENTS.md']

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

  const [activeTab, setActiveTab] = useState<AgentFileName>('SOUL.md')
  const [files, setFiles] = useState<FilesMap>(() => {
    const init: FilesMap = {}
    for (const name of EDITOR_TABS) {
      init[name] = { content: '', clean: '' }
    }
    return init
  })
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

    Promise.all(
      EDITOR_TABS.map((name) => client.agents.files.read(agentId, name).catch(() => '')),
    ).then((results) => {
      if (loadId !== loadIdRef.current) return // stale

      const next: FilesMap = {}
      EDITOR_TABS.forEach((name, i) => {
        const content = results[i] ?? ''
        next[name] = { content, clean: content }
      })
      setFiles(next)
      setLoading(false)
    })
  }, [agentId, client])

  // ─── Save handler ─────────────────────────────────────────────────────────

  const handleSave = useCallback(async () => {
    if (!client) return

    const tab = activeTabRef.current
    const fileState = filesRef.current[tab]
    if (!fileState || fileState.content === fileState.clean) return

    setSaving(true)
    try {
      const contentToSave = fileState.content
      await mutationQueue.enqueue(agentId, () =>
        client.agents.files.set(agentId, tab, contentToSave),
      )

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
    const dirtyTabs = EDITOR_TABS.filter(
      (name) => currentFiles[name] && currentFiles[name].content !== currentFiles[name].clean,
    )
    if (dirtyTabs.length === 0) return

    for (const tab of dirtyTabs) {
      try {
        const contentToSave = currentFiles[tab].content
        await mutationQueue.enqueue(agentId, () =>
          client.agents.files.set(agentId, tab, contentToSave),
        )
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
        ...clawbooEditorTheme,
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
  }, [])

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

  const anyDirty = EDITOR_TABS.some(isDirty)

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        right: 0,
        bottom: 0,
        left: 256,
        zIndex: 40,
        background: '#0d1117',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '10px 16px',
          borderBottom: '1px solid rgba(255,255,255,0.06)',
          background: '#111827',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <BooAvatar seed={agentId} size={24} />
          <span
            style={{
              fontSize: 13,
              fontWeight: 600,
              color: '#E8E8E8',
              fontFamily: 'var(--font-body)',
            }}
          >
            {agentName}
          </span>
          <span
            style={{
              fontSize: 11,
              color: 'rgba(107,114,128,0.7)',
              fontFamily: 'var(--font-mono)',
            }}
          >
            Edit Files
          </span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {/* Save button */}
          <button
            type="button"
            disabled={!isDirty(activeTab) || saving}
            onClick={() => void handleSave()}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '5px 12px',
              borderRadius: 6,
              border: 'none',
              background: isDirty(activeTab) ? '#E94560' : 'rgba(255,255,255,0.06)',
              color: isDirty(activeTab) ? '#fff' : 'rgba(232,232,232,0.4)',
              fontSize: 12,
              fontWeight: 500,
              cursor: isDirty(activeTab) ? 'pointer' : 'default',
              opacity: saving ? 0.6 : 1,
              transition: 'all 0.15s',
              fontFamily: 'var(--font-mono)',
            }}
          >
            {saving ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2} />
            ) : (
              <Save className="h-3.5 w-3.5" strokeWidth={2} />
            )}
            Save
          </button>

          {/* Close button */}
          <button
            type="button"
            onClick={() => void handleClose()}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 28,
              height: 28,
              borderRadius: 6,
              border: 'none',
              background: 'transparent',
              color: 'rgba(232,232,232,0.5)',
              cursor: 'pointer',
              transition: 'all 0.15s',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'rgba(255,255,255,0.06)'
              e.currentTarget.style.color = '#E8E8E8'
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'transparent'
              e.currentTarget.style.color = 'rgba(232,232,232,0.5)'
            }}
          >
            <X className="h-4 w-4" strokeWidth={2} />
          </button>
        </div>
      </div>

      {/* Tab bar */}
      <div
        style={{
          display: 'flex',
          gap: 2,
          padding: '0 12px',
          borderBottom: '1px solid rgba(255,255,255,0.06)',
          background: '#111827',
        }}
      >
        {EDITOR_TABS.map((tab) => {
          const isActive = tab === activeTab
          const dirty = isDirty(tab)
          return (
            <button
              key={tab}
              type="button"
              onClick={() => setActiveTab(tab)}
              style={{
                position: 'relative',
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '8px 14px',
                border: 'none',
                borderBottom: isActive ? '2px solid #E94560' : '2px solid transparent',
                background: 'transparent',
                color: isActive ? '#E8E8E8' : 'rgba(232,232,232,0.45)',
                fontSize: 11,
                fontWeight: isActive ? 600 : 400,
                fontFamily: 'var(--font-mono)',
                cursor: 'pointer',
                transition: 'all 0.15s',
              }}
              onMouseEnter={(e) => {
                if (!isActive) e.currentTarget.style.color = 'rgba(232,232,232,0.7)'
              }}
              onMouseLeave={(e) => {
                if (!isActive) e.currentTarget.style.color = 'rgba(232,232,232,0.45)'
              }}
            >
              {tab.replace('.md', '')}
              {dirty && (
                <span
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: '50%',
                    background: '#FBBF24',
                  }}
                />
              )}
            </button>
          )
        })}
      </div>

      {/* Editor area */}
      {/* Editor area — container always rendered so CodeMirror can mount */}
      <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
        {loading && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
              color: 'rgba(232,232,232,0.4)',
              fontSize: 13,
              zIndex: 1,
              background: '#0d1117',
            }}
          >
            <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} />
            Loading files…
          </div>
        )}
        <div ref={editorContainerRef} style={{ height: '100%' }} />
      </div>

      {/* Footer */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '6px 16px',
          borderTop: '1px solid rgba(255,255,255,0.06)',
          background: '#111827',
          fontSize: 11,
          color: 'rgba(232,232,232,0.4)',
          fontFamily: 'var(--font-mono)',
        }}
      >
        <span>{AGENT_FILE_META[activeTab].hint}</span>
        <span>
          {anyDirty ? 'Unsaved changes' : 'All saved'}
          {' · '}
          {navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'}+S to save
        </span>
      </div>
    </div>
  )
}
