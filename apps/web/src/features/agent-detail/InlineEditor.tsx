import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Save } from 'lucide-react'
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
import { ActivityTerminal } from '@/features/obs/ActivityTerminal'
import { Button } from '@/features/shared/Button'
import { Spinner } from '@/features/shared/Spinner'

// ─── Tab types ───────────────────────────────────────────────────────────────

// `'brief'` is Boo-Zero-only — gated by `isBooZero` at the tab-list level.
// `'activity'` is the live obs terminal for this agent.
type EditorTab = 'personality' | 'permissions' | 'activity' | 'brief' | AgentFileName

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
  if (tab === 'activity') return 'Activity'
  if (tab === 'brief') return 'Brief'
  return FILE_TAB_LABELS[tab] ?? tab.replace('.md', '')
}

/** Type guard: is this tab one of the file-backed CodeMirror tabs? */
function isAgentFileTab(tab: EditorTab): tab is AgentFileName {
  return tab !== 'personality' && tab !== 'permissions' && tab !== 'activity' && tab !== 'brief'
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
      'activity',
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
      <div className="flex shrink-0 items-center gap-0.5 border-b border-border bg-card px-2">
        {allTabs.map((tab) => {
          const isActive = tab === activeTab
          const dirty = isAgentFileTab(tab) && isDirty(tab)
          return (
            <button
              key={tab}
              type="button"
              onClick={() => setActiveTab(tab)}
              className={[
                'relative -mb-px inline-flex items-center gap-1.5 px-2.5 pb-2 pt-2.5 font-mono text-[11px] uppercase tracking-[0.14em]',
                'transition-colors duration-150 cursor-pointer',
                isActive
                  ? 'font-semibold text-foreground'
                  : 'font-medium text-foreground/45 hover:text-foreground/75',
              ].join(' ')}
            >
              {getTabLabel(tab)}
              {dirty && (
                <span className="h-[5px] w-[5px] shrink-0 rounded-full bg-amber" />
              )}
              <span
                aria-hidden
                className="absolute inset-x-0 -bottom-px h-0.5 rounded-full transition-opacity duration-150"
                style={{ background: 'var(--primary)', opacity: isActive ? 1 : 0 }}
              />
            </button>
          )
        })}

        {/* Save button — only for file tabs */}
        {isFileTab && (
          <div className="ml-auto py-1">
            <Button
              variant={isFileDirty ? 'primary' : 'secondary'}
              size="sm"
              loading={saving}
              disabled={!isFileDirty || saving}
              onClick={onSaveClick}
            >
              {!saving && <Save size={13} strokeWidth={2} />}
              Save
            </Button>
          </div>
        )}
      </div>

      {/* Content area */}
      <div style={{ flex: 1, position: 'relative', overflow: 'hidden', minHeight: 0 }}>
        {loading && (
          <div
            className="absolute inset-0 z-[1] flex items-center justify-center gap-2 text-[12px] text-foreground/40"
            style={{ background: 'var(--background)' }}
          >
            <Spinner size={14} />
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

        {/* Activity tab — the live obs terminal for this agent. */}
        {activeTab === 'activity' && (
          <div style={{ height: '100%', padding: '12px 16px', minHeight: 0 }}>
            <ActivityTerminal scope={{ agentId }} fill hideHeader />
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
              <h3 className="m-0 font-mono text-[11px] uppercase tracking-[0.14em] text-foreground/45">
                Display name
              </h3>
              <DisplayNameEditor agentId={agentId} currentName={liveAgentName} />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <h3 className="m-0 font-mono text-[11px] uppercase tracking-[0.14em] text-foreground/45">
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
      <div className="flex shrink-0 items-center justify-between border-t border-border bg-card px-3 py-1 font-mono text-[10px] tracking-wide text-foreground/35">
        <span>
          {activeTab === 'personality'
            ? `${agentName} · Personality`
            : activeTab === 'permissions'
              ? `${agentName} · Permissions`
              : activeTab === 'activity'
                ? `${agentName} · Activity — live tool calls, results, errors`
                : activeTab === 'brief'
                  ? `${agentName} · Brief — display name + global brief`
                  : AGENT_FILE_META[activeTab].hint}
        </span>
        <span>
          <span className={anyDirty ? 'text-amber' : 'text-mint'}>
            {anyDirty ? 'Unsaved' : 'Saved'}
          </span>
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
