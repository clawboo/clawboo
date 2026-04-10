import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Loader2, Save } from 'lucide-react'
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
import { AGENT_FILE_META, AGENT_FILE_PLACEHOLDERS } from '@clawboo/protocol'
import type { AgentFileName } from '@clawboo/protocol'
import { clawbooEditorTheme } from '@/features/editor/editorTheme'
import { useAgentFiles, CORE_FILE_TABS, ALL_FILE_TABS } from '@/features/editor/useAgentFiles'
import { PersonalitySliders } from '@/features/settings/PersonalitySliders'
import { ExecSettings } from '@/features/settings/ExecSettings'

// ─── Tab types ───────────────────────────────────────────────────────────────

type EditorTab = 'personality' | 'permissions' | AgentFileName

const FILE_TAB_LABELS: Record<AgentFileName, string> = {
  'SOUL.md': 'SOUL',
  'IDENTITY.md': 'IDENTITY',
  'TOOLS.md': 'TOOLS',
  'AGENTS.md': 'AGENTS',
  'USER.md': 'USER',
  'HEARTBEAT.md': 'HEARTBEAT',
  'MEMORY.md': 'MEMORY',
}

function getTabLabel(tab: EditorTab): string {
  if (tab === 'personality') return 'Personality'
  if (tab === 'permissions') return 'Permissions'
  return FILE_TAB_LABELS[tab] ?? tab.replace('.md', '')
}

// ─── Component ───────────────────────────────────────────────────────────────

export function InlineEditor({ agentId, agentName }: { agentId: string; agentName: string }) {
  const {
    files,
    loading,
    saving,
    isDirty,
    anyDirty,
    fileExists,
    handleSave,
    saveAllDirty,
    updateFileContent,
  } = useAgentFiles(agentId)

  // Build dynamic tab list: core file tabs always shown + extras only when non-empty
  const visibleFileTabs = useMemo(() => {
    const coreTabs: AgentFileName[] = [...CORE_FILE_TABS]
    const extras = ALL_FILE_TABS.filter(
      (tab) => !(CORE_FILE_TABS as readonly string[]).includes(tab) && fileExists(tab),
    )
    return [...coreTabs, ...extras]
  }, [fileExists])

  const allTabs: EditorTab[] = useMemo(
    () => ['personality', 'permissions', ...visibleFileTabs],
    [visibleFileTabs],
  )

  const [activeTab, setActiveTab] = useState<EditorTab>('personality')

  const editorContainerRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const activeTabRef = useRef(activeTab)
  const filesRef = useRef(files)
  const placeholderComp = useRef(new Compartment())
  const handleSaveRef = useRef(handleSave)

  // Keep refs in sync
  activeTabRef.current = activeTab
  filesRef.current = files
  handleSaveRef.current = handleSave

  // Save all dirty files on unmount (agent switch or view change)
  const saveAllDirtyRef = useRef(saveAllDirty)
  saveAllDirtyRef.current = saveAllDirty
  useEffect(() => {
    return () => {
      void saveAllDirtyRef.current()
    }
  }, [agentId])

  // ─── CodeMirror setup ────────────────────────────────────────────────────

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
              const tab = activeTabRef.current
              if (tab !== 'personality' && tab !== 'permissions') {
                void handleSaveRef.current(tab)
              }
              return true
            },
          },
        ]),
        EditorView.lineWrapping,
        comp.of(placeholder(AGENT_FILE_PLACEHOLDERS['SOUL.md'])),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            const tab = activeTabRef.current
            if (tab !== 'personality' && tab !== 'permissions') {
              updateFileContent(tab, update.state.doc.toString())
            }
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
  }, [updateFileContent])

  // ─── Sync CodeMirror content when tab or loading changes ──────────────────

  useEffect(() => {
    const view = viewRef.current
    if (!view || loading) return

    if (activeTab === 'personality' || activeTab === 'permissions') return

    const fileState = filesRef.current[activeTab]
    if (!fileState) return

    const currentDoc = view.state.doc.toString()
    if (currentDoc !== fileState.content) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: fileState.content },
      })
    }

    view.dispatch({
      effects: placeholderComp.current.reconfigure(
        placeholder(AGENT_FILE_PLACEHOLDERS[activeTab as AgentFileName]),
      ),
    })
  }, [activeTab, loading])

  // ─── Active file tab data ─────────────────────────────────────────────────

  const isFileTab = activeTab !== 'personality' && activeTab !== 'permissions'
  const isFileDirty = isFileTab && isDirty(activeTab as AgentFileName)

  const onSaveClick = useCallback(() => {
    if (isFileTab) {
      void handleSave(activeTab as AgentFileName)
    }
  }, [handleSave, activeTab, isFileTab])

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: 0,
        background: '#0d1117',
      }}
    >
      {/* Tab bar */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 0,
          padding: '0 8px',
          borderBottom: '1px solid rgba(255,255,255,0.06)',
          background: '#111827',
          flexShrink: 0,
        }}
      >
        {allTabs.map((tab) => {
          const isActive = tab === activeTab
          const dirty =
            tab !== 'personality' && tab !== 'permissions' && isDirty(tab as AgentFileName)
          return (
            <button
              key={tab}
              type="button"
              onClick={() => setActiveTab(tab)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                padding: '6px 10px',
                border: 'none',
                borderBottom: isActive ? '2px solid #E94560' : '2px solid transparent',
                background: 'transparent',
                color: isActive ? '#E8E8E8' : 'rgba(232,232,232,0.45)',
                fontSize: 10,
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
              {getTabLabel(tab)}
              {dirty && (
                <span
                  style={{
                    width: 5,
                    height: 5,
                    borderRadius: '50%',
                    background: '#FBBF24',
                    flexShrink: 0,
                  }}
                />
              )}
            </button>
          )
        })}

        {/* Save button — only for file tabs */}
        {isFileTab && (
          <button
            type="button"
            disabled={!isFileDirty || saving}
            onClick={onSaveClick}
            style={{
              marginLeft: 'auto',
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              padding: '4px 8px',
              borderRadius: 4,
              border: 'none',
              background: isFileDirty ? '#E94560' : 'rgba(255,255,255,0.06)',
              color: isFileDirty ? '#fff' : 'rgba(232,232,232,0.4)',
              fontSize: 10,
              fontWeight: 500,
              cursor: isFileDirty ? 'pointer' : 'default',
              opacity: saving ? 0.6 : 1,
              transition: 'all 0.15s',
              fontFamily: 'var(--font-mono)',
            }}
          >
            {saving ? (
              <Loader2 style={{ width: 12, height: 12 }} className="animate-spin" strokeWidth={2} />
            ) : (
              <Save style={{ width: 12, height: 12 }} strokeWidth={2} />
            )}
            Save
          </button>
        )}
      </div>

      {/* Content area */}
      <div style={{ flex: 1, position: 'relative', overflow: 'hidden', minHeight: 0 }}>
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
              fontSize: 12,
              zIndex: 1,
              background: '#0d1117',
            }}
          >
            <Loader2 style={{ width: 14, height: 14 }} className="animate-spin" strokeWidth={2} />
            Loading…
          </div>
        )}

        {/* Personality tab */}
        {activeTab === 'personality' && (
          <div style={{ height: '100%', overflowY: 'auto', padding: '12px 16px' }}>
            <PersonalitySliders agentId={agentId} />
          </div>
        )}

        {/* Permissions tab */}
        {activeTab === 'permissions' && (
          <div style={{ height: '100%', overflowY: 'auto', padding: '12px 16px' }}>
            <ExecSettings agentId={agentId} />
          </div>
        )}

        {/* CodeMirror container — hidden (not destroyed) when personality tab active */}
        <div
          ref={editorContainerRef}
          style={{
            height: '100%',
            display: activeTab === 'personality' || activeTab === 'permissions' ? 'none' : 'block',
          }}
        />
      </div>

      {/* Footer */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '4px 12px',
          borderTop: '1px solid rgba(255,255,255,0.06)',
          background: '#111827',
          fontSize: 10,
          color: 'rgba(232,232,232,0.35)',
          fontFamily: 'var(--font-mono)',
          flexShrink: 0,
        }}
      >
        <span>
          {activeTab === 'personality'
            ? `${agentName} · Personality`
            : activeTab === 'permissions'
              ? `${agentName} · Permissions`
              : AGENT_FILE_META[activeTab as AgentFileName].hint}
        </span>
        <span>
          {anyDirty ? 'Unsaved' : 'Saved'}
          {isFileTab && (
            <>
              {' · '}
              {navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'}+S
            </>
          )}
        </span>
      </div>
    </div>
  )
}
