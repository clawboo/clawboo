// The slim top bar, for an app that shows the dashboard in its own window with
// the system title bar hidden. Drawn only while <html> carries
// `data-clawboo-embed-titlebar` (see features/embedder/embedTitlebar.ts), in the
// band `--clawboo-titlebar-inset` already keeps free above the columns, on the
// frame colour the team rail uses.
//
// Left, after `--clawboo-titlebar-left` (the window buttons' width): the sidebar
// toggle, then back and forward through the dashboard's own views. Middle: the
// team the page belongs to, with its icon, or the page's name. Right: Needs
// you, and help.
//
// The bar is the window's drag area and every control in it is not (the
// `clawboo-titlebar` classes in app/globals.css). It handles no double-click,
// so a double-click on its empty space stays the window's.

import { useEffect } from 'react'
import { ArrowLeft, ArrowRight, CircleAlert, CircleHelp } from 'lucide-react'

import { hasOpenLayer } from '@/features/shared/useDismissableLayer'
import { NAV_VIEW_LABELS } from '@/lib/navLabels'
import { useEditorStore } from '@/stores/editor'
import { useFleetStore, type AgentState } from '@/stores/fleet'
import { useSettingsModalStore } from '@/stores/settingsModal'
import { useTeamStore, type Team } from '@/stores/team'
import { useViewStore, type ViewMode } from '@/stores/view'

import { usePhoneLayout } from './phoneLayout'
import { closePeek, openPeek, schedulePeekHide } from './sidebarPeek'
import { SidebarToggle } from './SidebarToggle'
import { goBack, goForward, useViewHistoryState } from './viewHistory'

export const DOCS_URL = 'https://docs.claw.boo'

export interface TitlebarTitle {
  label: string
  /** The team the page belongs to, drawn as its icon before the label. */
  team: Pick<Team, 'icon' | 'color'> | null
}

/** What the middle of the bar says for `viewMode`. */
export function titlebarTitle(
  viewMode: ViewMode,
  teams: readonly Team[],
  agents: readonly Pick<AgentState, 'id' | 'name' | 'teamId'>[],
): TitlebarTitle {
  const liveTeam = (id: string | null | undefined) =>
    id ? (teams.find((t) => t.id === id && !t.isArchived) ?? null) : null
  const asTeam = (team: Team): TitlebarTitle => ({ label: team.name, team })
  switch (viewMode.type) {
    case 'teamspace':
    case 'groupChat': {
      const team = liveTeam(viewMode.teamId)
      return team ? asTeam(team) : { label: 'Clawboo', team: null }
    }
    case 'agent': {
      const agent = agents.find((a) => a.id === viewMode.agentId)
      const team = liveTeam(agent?.teamId)
      if (team) return asTeam(team)
      return { label: agent?.name ?? 'Agent', team: null }
    }
    case 'nav':
      return { label: NAV_VIEW_LABELS[viewMode.view], team: null }
    case 'booZero':
      return { label: 'Boo Zero', team: null }
    case 'welcome':
      return { label: 'Clawboo', team: null }
  }
}

function useTitlebarTitle(): TitlebarTitle {
  const viewMode = useViewStore((s) => s.viewMode)
  const teams = useTeamStore((s) => s.teams)
  // Only an agent page needs the fleet, and then only that agent's name and team.
  const agent = useFleetStore((s) =>
    viewMode.type === 'agent' ? s.agents.find((a) => a.id === viewMode.agentId) : undefined,
  )
  return titlebarTitle(viewMode, teams, agent ? [agent] : [])
}

/** True while focus is somewhere ⌘[ and ⌘] mean something else: a text field
 *  (or the code editor, where they indent), or a layer over the content. */
function shortcutsStandDown(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  const tag = el?.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (el?.isContentEditable || el?.closest?.('.cm-editor')) return true
  return hasOpenLayer() || useSettingsModalStore.getState().open || useEditorStore.getState().isOpen
}

/** ⌘[ and ⌘] (Ctrl on Windows and Linux) go back and forward. Only while the
 *  bar shows: in a browser tab those keys are the browser's own. */
function useHistoryShortcuts(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return
      if (e.key !== '[' && e.key !== ']') return
      if (shortcutsStandDown(e.target)) return
      e.preventDefault()
      if (e.key === '[') goBack()
      else goForward()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}

const CONTROL =
  'clawboo-titlebar-control flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-foreground/60 transition-colors duration-150 hover:bg-foreground/[0.06] hover:text-foreground'

const STEP = `${CONTROL} disabled:cursor-default disabled:text-foreground/25 disabled:hover:bg-transparent`

/** The sidebar toggle, first in the bar: it collapses the docked sidebar and
 *  expands it again (Cmd/Ctrl+\ still does both). Collapsed, hovering it lays
 *  the sidebar over the page below the bar, as the header toggle does without
 *  the bar. At phone width the sidebar is a drawer opened from each view's
 *  header, so the bar shows none. */
function BarSidebarToggle() {
  const collapsed = useViewStore((s) => s.columnCollapsed)
  const phone = usePhoneLayout()
  if (phone) return null
  return (
    <SidebarToggle
      compact
      collapsed={collapsed}
      className="clawboo-titlebar-control"
      onClick={() => {
        closePeek()
        useViewStore.getState().setColumnCollapsed(!collapsed)
      }}
      onMouseEnter={collapsed ? openPeek : undefined}
      onMouseLeave={collapsed ? schedulePeekHide : undefined}
    />
  )
}

export function EmbedTitlebar() {
  const { canGoBack, canGoForward } = useViewHistoryState()
  const title = useTitlebarTitle()
  useHistoryShortcuts()

  return (
    <div
      data-testid="embed-titlebar"
      data-embed-titlebar=""
      className="clawboo-titlebar fixed inset-x-0 top-0 z-30 flex items-center bg-frame"
      style={{ height: 'var(--clawboo-titlebar-inset, 0px)' }}
    >
      <div
        data-testid="titlebar-left"
        className="flex items-center gap-0.5 pl-2"
        style={{ marginLeft: 'var(--clawboo-titlebar-left, 0px)' }}
      >
        <BarSidebarToggle />
        <div role="group" aria-label="History" className="flex items-center gap-0.5">
          <button
            type="button"
            data-testid="titlebar-back"
            aria-label="Back"
            title="Back (⌘[)"
            disabled={!canGoBack}
            onClick={goBack}
            className={STEP}
          >
            <ArrowLeft size={16} strokeWidth={2} aria-hidden />
          </button>
          <button
            type="button"
            data-testid="titlebar-forward"
            aria-label="Forward"
            title="Forward (⌘])"
            disabled={!canGoForward}
            onClick={goForward}
            className={STEP}
          >
            <ArrowRight size={16} strokeWidth={2} aria-hidden />
          </button>
        </div>
      </div>

      {/* Centred on the window, kept clear of the left group (and the same
          width on the right), and part of the drag area. */}
      <div
        data-testid="titlebar-title"
        className="absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 items-center gap-2 text-[13px] font-semibold text-foreground"
        style={{ maxWidth: 'calc(100% - 2 * (var(--clawboo-titlebar-left, 0px) + 96px))' }}
      >
        {title.team && (
          <span
            aria-hidden
            data-testid="titlebar-team-icon"
            className="flex size-5 shrink-0 items-center justify-center rounded-md text-[12px] leading-none"
            style={{ background: title.team.color || 'rgb(var(--foreground-rgb) / 0.06)' }}
          >
            {title.team.icon}
          </span>
        )}
        <span className="truncate">{title.label}</span>
      </div>

      <div className="ml-auto flex items-center gap-0.5 pr-2">
        <button
          type="button"
          data-testid="titlebar-needs-you"
          aria-label="Needs you"
          title="Needs you"
          onClick={() => useViewStore.getState().openBoardNeedsYou()}
          className={CONTROL}
        >
          <CircleAlert size={16} strokeWidth={2} aria-hidden />
        </button>
        <a
          data-testid="titlebar-help"
          href={DOCS_URL}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Help: the Clawboo docs, in a new tab"
          title="Help"
          className={CONTROL}
        >
          <CircleHelp size={16} strokeWidth={2} aria-hidden />
        </a>
      </div>
    </div>
  )
}
