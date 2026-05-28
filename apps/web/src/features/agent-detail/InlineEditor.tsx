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
import { clawbooEditorThemeDark, clawbooEditorThemeLight } from '@/features/editor/editorTheme'
import { useTheme } from '@/features/theme/useTheme'
import { useAgentFiles, CORE_FILE_TABS, ALL_FILE_TABS } from '@/features/editor/useAgentFiles'
import { PersonalitySliders } from '@/features/settings/PersonalitySliders'
import { ExecSettings } from '@/features/settings/ExecSettings'
import { useBooZeroStore } from '@/stores/booZero'
import { useFleetStore } from '@/stores/fleet'
import { DisplayNameEditor } from '@/features/boo-zero/DisplayNameEditor'
import { GlobalBriefEditor } from '@/features/boo-zero/GlobalBriefEditor'

// ─── Tab types ───────────────────────────────────────────────────────────────

// `'brief'` is Boo-Zero-only — gated by `isBooZero` at the tab-list level.
type EditorTab = 'personality' | 'permissions' | 'brief' | AgentFileName

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
  if (tab === 'brief') return 'Brief'
  return FILE_TAB_LABELS[tab] ?? tab.replace('.md', '')
}

/** Type guard: is this tab one of the file-backed CodeMirror tabs? */
function isAgentFileTab(tab: EditorTab): tab is AgentFileName {
  return tab !== 'personality' && tab !== 'permissions' && tab !== 'brief'
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

  const { resolvedTheme } = useTheme()

  // Build dynamic tab list: core file tabs always shown + extras only when non-empty
  const visibleFileTabs = useMemo(() => {
    const coreTabs: AgentFileName[] = [...CORE_FILE_TABS]
    const extras = ALL_FILE_TABS.filter(
      (tab) => !(CORE_FILE_TABS as readonly string[]).includes(tab) && fileExists(tab),
    )
    return [...coreTabs, ...extras]
  }, [fileExists])

  // The Brief tab is Boo-Zero-only — it holds the Display Name override + the
  // Global Brief (Boo Zero's load-bearing identity surface). Other agents
  // don't get the tab at all, so the tab strip stays clean.
  const booZeroAgentId = useBooZeroStore((s) => s.booZeroAgentId)
  const isBooZero = booZeroAgentId !== null && booZeroAgentId === agentId
  // Pull the latest display name from the fleet store so the editor sees
  // whatever override is currently applied (rather than a stale prop).
  const liveAgent = useFleetStore((s) => s.agents.find((a) => a.id === agentId) ?? null)
  const liveAgentName = liveAgent?.name ?? agentName

  const allTabs: EditorTab[] = useMemo(
    () => [
      'personality',
      'permissions',
      ...(isBooZero ? (['brief'] as const) : []),
      ...visibleFileTabs,
    ],
    [visibleFileTabs, isBooZero],
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
              const tab = activeTabRef.current
              if (isAgentFileTab(tab)) {
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
            if (isAgentFileTab(tab)) {
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
  }, [updateFileContent, resolvedTheme])

  // ─── Sync CodeMirror content when tab or loading changes ──────────────────

  useEffect(() => {
    const view = viewRef.current
    if (!view || loading) return

    if (!isAgentFileTab(activeTab)) return

    const fileState = filesRef.current[activeTab]
    if (!fileState) return

    const currentDoc = view.state.doc.toString()
    if (currentDoc !== fileState.content) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: fileState.content },
      })
    }

    view.dispatch({
      effects: placeholderComp.current.reconfigure(placeholder(AGENT_FILE_PLACEHOLDERS[activeTab])),
    })
  }, [activeTab, loading])

  // ─── Active file tab data ─────────────────────────────────────────────────

  const isFileTab = isAgentFileTab(activeTab)
  const isFileDirty = isFileTab && isDirty(activeTab)

  const onSaveClick = useCallback(() => {
    if (isAgentFileTab(activeTab)) {
      void handleSave(activeTab)
    }
  }, [handleSave, activeTab])

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: 0,
        background: 'var(--background)',
      }}
    >
      {/* Tab bar */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 0,
          padding: '0 8px',
          borderBottom: '1px solid rgb(var(--foreground-rgb) / 0.06)',
          background: 'var(--card)',
          flexShrink: 0,
        }}
      >
        {allTabs.map((tab) => {
          const isActive = tab === activeTab
          const dirty = isAgentFileTab(tab) && isDirty(tab)
          return (
            <button
              key={tab}
              type="button"
              onClick={() => setActiveTab(tab)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 5,
                padding: '7px 11px',
                border: 'none',
                borderBottom: isActive ? '2px solid var(--primary)' : '2px solid transparent',
                background: 'transparent',
                color: isActive ? 'var(--foreground)' : 'rgb(var(--foreground-rgb) / 0.45)',
                fontSize: 11,
                fontWeight: isActive ? 600 : 500,
                fontFamily: 'var(--font-mono)',
                letterSpacing: '0.04em',
                textTransform: 'uppercase',
                cursor: 'pointer',
                transition: 'color var(--motion-fast), border-color var(--motion-fast)',
              }}
              onMouseEnter={(e) => {
                if (!isActive) e.currentTarget.style.color = 'rgb(var(--foreground-rgb) / 0.8)'
              }}
              onMouseLeave={(e) => {
                if (!isActive) e.currentTarget.style.color = 'rgb(var(--foreground-rgb) / 0.45)'
              }}
            >
              {getTabLabel(tab)}
              {dirty && (
                <span
                  style={{
                    width: 5,
                    height: 5,
                    borderRadius: '50%',
                    background: 'var(--amber)',
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
              gap: 5,
              padding: '5px 10px',
              borderRadius: 6,
              border: 'none',
              background: isFileDirty ? 'var(--primary)' : 'rgb(var(--foreground-rgb) / 0.06)',
              color: isFileDirty ? '#fff' : 'rgb(var(--foreground-rgb) / 0.4)',
              boxShadow: isFileDirty ? '0 4px 12px rgb(var(--primary-rgb) / 0.25)' : 'none',
              fontSize: 11,
              fontWeight: 500,
              letterSpacing: '0.03em',
              cursor: isFileDirty ? 'pointer' : 'default',
              opacity: saving ? 0.6 : 1,
              transition: 'background var(--motion-fast), box-shadow var(--motion-fast)',
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
              color: 'rgb(var(--foreground-rgb) / 0.4)',
              fontSize: 12,
              zIndex: 1,
              background: 'var(--background)',
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

        {/* Brief tab — Boo Zero only (gated at allTabs construction).
            Holds the Display Name override + the Global Brief — the
            load-bearing identity surface that runs through every Boo
            Zero turn. */}
        {activeTab === 'brief' && isBooZero && (
          <div
            style={{
              height: '100%',
              overflowY: 'auto',
              padding: '12px 16px',
              display: 'flex',
              flexDirection: 'column',
              gap: 18,
            }}
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <h3
                style={{
                  margin: 0,
                  fontSize: 12,
                  fontWeight: 600,
                  color: 'rgb(var(--foreground-rgb) / 0.85)',
                }}
              >
                Display name
              </h3>
              <DisplayNameEditor agentId={agentId} currentName={liveAgentName} />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <h3
                style={{
                  margin: 0,
                  fontSize: 12,
                  fontWeight: 600,
                  color: 'rgb(var(--foreground-rgb) / 0.85)',
                }}
              >
                Global brief
              </h3>
              <GlobalBriefEditor />
            </div>
          </div>
        )}

        {/* CodeMirror container — hidden (not destroyed) when a non-file tab is active */}
        <div
          ref={editorContainerRef}
          style={{
            height: '100%',
            display: isAgentFileTab(activeTab) ? 'block' : 'none',
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
          borderTop: '1px solid rgb(var(--foreground-rgb) / 0.06)',
          background: 'var(--card)',
          fontSize: 10,
          color: 'rgb(var(--foreground-rgb) / 0.35)',
          fontFamily: 'var(--font-mono)',
          flexShrink: 0,
        }}
      >
        <span>
          {activeTab === 'personality'
            ? `${agentName} · Personality`
            : activeTab === 'permissions'
              ? `${agentName} · Permissions`
              : activeTab === 'brief'
                ? `${agentName} · Brief — display name + global brief`
                : AGENT_FILE_META[activeTab].hint}
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
