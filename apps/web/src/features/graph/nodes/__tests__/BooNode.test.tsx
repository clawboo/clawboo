// BooNode — the first tests this component has ever had.
//
// Why it starts here: a real regression shipped through this gap. The thought
// bubble that replaced the running-agent card was mounted with
// `show={isRunning}`, so the instant a run FAILED the bubble unmounted, taking
// `useBooActivity`'s error branch and `WorkingPulse`'s stopped state with it.
// Both were unreachable dead code, and a 3121-test suite said nothing, because
// nothing mounted this node.
//
// ─── What these tests can and cannot see ────────────────────────────────────
//
// jsdom loads NO CSS. `.boo-cast`, `--glow`, `--pulse` and `--sleeping` are
// chained `filter: drop-shadow(...)` rules in globals.css, so none of the glow's
// APPEARANCE is assertable here: a test can prove the right class was chosen and
// nothing more. Whether the glow traces the mascot's silhouette, whether the
// pulse animates, and whether sleeping actually desaturates are screenshot
// questions and are verified that way. Do not let a green file here imply
// otherwise.
//
// ─── Two switches, not one ──────────────────────────────────────────────────
//
// `data.status` drives `showsBubble`, the glow and the status dot. The FLEET
// agent's `status` drives `useBooActivity`'s error branch and the activity verb.
// Seeding only one produces a bubble that renders the wrong line, which reads as
// a pass. Every case below sets both deliberately.

import { cleanup, render, screen } from '@testing-library/react'
import { ReactFlowProvider } from '@xyflow/react'
import type { Node, NodeProps } from '@xyflow/react'
import type { TranscriptEntry } from '@clawboo/protocol'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { useGraphStore } from '@/features/graph/store'
import type { BooNodeData } from '@/features/graph/types'
import { ThemeProvider } from '@/features/theme/ThemeProvider'
import { useApprovalsStore } from '@/stores/approvals'
import { useBooZeroStore } from '@/stores/booZero'
import { useChatStore } from '@/stores/chat'
import { useFleetStore, type AgentState } from '@/stores/fleet'
import { useObsOverlayStore } from '@/stores/obsOverlay'
import { useRunActivityStore } from '@/stores/runActivity'
import { useTeamStore } from '@/stores/team'

import { BooNode } from '../BooNode'

// ─── Fixtures ────────────────────────────────────────────────────────────────

/** `NodeProps` is mostly React Flow bookkeeping; BooNode reads only `data`,
 *  `selected` and `dragging`. The rest satisfies the type. */
function nodeProps(data: Partial<BooNodeData> = {}): NodeProps<Node<BooNodeData, 'boo'>> {
  return {
    id: 'boo-a1',
    type: 'boo',
    data: {
      agentId: 'a1',
      name: 'Scout',
      status: 'idle',
      model: null,
      runtime: null,
      isStreaming: false,
      teamId: null,
      ...data,
    },
    selected: false,
    dragging: false,
    draggable: true,
    selectable: true,
    deletable: true,
    isConnectable: true,
    zIndex: 0,
    positionAbsoluteX: 0,
    positionAbsoluteY: 0,
  }
}

/** `lastSeenAt` stays null on purpose: `formatLastSeen` calls `Date.now()`, and
 *  a wall-clock string in the DOM is a flake waiting for a slow CI box. */
function agent(over: Partial<AgentState> = {}): AgentState {
  return {
    id: 'a1',
    name: 'Scout',
    status: 'idle',
    sessionKey: null,
    model: null,
    createdAt: null,
    streamingText: null,
    runId: null,
    lastSeenAt: null,
    teamId: null,
    ...over,
  } as AgentState
}

function entry(kind: TranscriptEntry['kind'], text: string, i = 1): TranscriptEntry {
  return {
    entryId: `e${i}`,
    role: 'assistant',
    kind,
    text,
    sessionKey: 'agent:a1:main',
    runId: null,
    source: 'runtime-chat',
    timestampMs: 1_000_000 + i,
    sequenceKey: i,
    confirmed: true,
    fingerprint: `fp-${i}`,
  }
}

/** React Flow's `Handle` and `useConnection` throw outside a provider, and
 *  `AgentBooAvatar` -> `useTheme` throws outside `ThemeProvider`. Neither is
 *  mocked: a mock here would stop this file testing the thing that broke. */
function renderNode(props: NodeProps<Node<BooNodeData, 'boo'>>) {
  return render(
    <ReactFlowProvider>
      <ThemeProvider>
        <BooNode {...props} />
      </ThemeProvider>
    </ReactFlowProvider>,
  )
}

/** Put an agent in the fleet AND give the node the same status, which is what
 *  the app does. Optionally seed a chat transcript or a board-run activity line. */
function seed(opts: {
  status: AgentState['status']
  transcript?: TranscriptEntry[]
  obsLine?: string
}) {
  const sessionKey = opts.transcript ? 'agent:a1:main' : null
  useFleetStore.setState({ agents: [agent({ status: opts.status, sessionKey })] })
  if (opts.transcript) {
    useChatStore.setState({ transcripts: new Map([[sessionKey as string, opts.transcript]]) })
  }
  if (opts.obsLine) {
    useRunActivityStore.setState({ byAgent: new Map([['a1', opts.obsLine]]) })
  }
}

beforeEach(() => {
  // Zustand stores are module singletons shared by every test in this file. The
  // last two are transitive through AgentBooAvatar and easy to forget.
  useFleetStore.setState({ agents: [] })
  useChatStore.setState({ transcripts: new Map(), streamingText: new Map() })
  useRunActivityStore.setState({ byAgent: new Map() })
  useObsOverlayStore.setState({ statusByAgent: new Map() })
  useApprovalsStore.setState({ pendingApprovals: new Map() })
  useTeamStore.setState({ teams: [] })
  useBooZeroStore.setState({ booZeroAgentId: null })
  useGraphStore.setState({ hoveredNodeId: null, connectMode: false })
})

afterEach(() => cleanup())

// ─── The regression ──────────────────────────────────────────────────────────

describe('BooNode — an errored agent still says what went wrong', () => {
  it('renders the thought bubble on error, not just while running', () => {
    seed({ status: 'error' })
    renderNode(nodeProps({ status: 'error' }))

    // THE bug. `show={isRunning}` unmounted this the instant a run failed, so a
    // failed agent showed nothing at all and the only signal left was a dot.
    expect(screen.getByText('ran into an error')).toBeInTheDocument()
  })

  it('shows the error LINE rather than whatever the agent last did', () => {
    // A failed run that keeps advertising its last tool call reads as still
    // working. `useBooActivity` short-circuits on status BEFORE picking activity,
    // and this locks that order.
    seed({
      status: 'error',
      transcript: [entry('tool', '[[tool]] read_file')],
      obsLine: 'editing pricing.css',
    })
    renderNode(nodeProps({ status: 'error' }))

    expect(screen.getByText('ran into an error')).toBeInTheDocument()
    expect(screen.queryByText('Using read_file')).not.toBeInTheDocument()
    expect(screen.queryByText('editing pricing.css')).not.toBeInTheDocument()
  })

  it('renders no bubble at all when idle or sleeping', () => {
    // The inverse guard. Widening `showsBubble` to a constant, or to
    // `status !== 'idle'`, passes every assertion above and fails only here.
    for (const status of ['idle', 'sleeping'] as const) {
      seed({ status })
      const { unmount } = renderNode(nodeProps({ status }))
      expect(screen.queryByText('thinking')).not.toBeInTheDocument()
      expect(screen.queryByText('ran into an error')).not.toBeInTheDocument()
      unmount()
    }
  })
})

// ─── What the bubble says ────────────────────────────────────────────────────

describe('BooNode — the thought bubble line', () => {
  it('phrases a tool call as a sentence', () => {
    // The picker hands back a bare identifier; the bubble is what adds the verb,
    // so `read_file` reads as something a person is watching happen.
    seed({ status: 'running', transcript: [entry('tool', '[[tool]] read_file')] })
    renderNode(nodeProps({ status: 'running' }))

    expect(screen.getByText('Using read_file')).toBeInTheDocument()
  })

  it('leaves a board run line alone, because it is already a sentence', () => {
    // `kind: 'obs'` exists precisely so this line does NOT get a verb in front
    // of it. A board run has no chat session, so this is the only path that
    // reaches the bubble for work happening on the board.
    seed({ status: 'running', obsLine: 'editing pricing.css' })
    renderNode(nodeProps({ status: 'running' }))

    expect(screen.getByText('editing pricing.css')).toBeInTheDocument()
    expect(screen.queryByText('Using editing pricing.css')).not.toBeInTheDocument()
  })

  it('shows reasoning, which used to be withheld', () => {
    // Reasoning was skipped as private, which left the bubble empty through the
    // longest stretch of a reasoning-model run. It is model-written text, so it
    // is displayed and never acted on.
    seed({ status: 'running', transcript: [entry('thinking', 'weighing the two approaches')] })
    renderNode(nodeProps({ status: 'running' }))

    expect(screen.getByText('weighing the two approaches')).toBeInTheDocument()
  })

  it('says "thinking" when a run has produced nothing yet', () => {
    // `useBooActivity` returning null is NOT "hide the bubble". Treating it that
    // way is what made the old surface look dead before the first tool call.
    seed({ status: 'running' })
    renderNode(nodeProps({ status: 'running' }))

    expect(screen.getByText('thinking')).toBeInTheDocument()
  })
})

// ─── The status row underneath ───────────────────────────────────────────────

describe('BooNode — the status row stands down without taking the ring counts', () => {
  it('drops the verb while the bubble is up', () => {
    // The verb duplicated the bubble: "Thinking..." printed under a bubble that
    // was already showing the actual thought.
    seed({ status: 'running' })
    const { container } = renderNode(nodeProps({ status: 'running' }))

    expect(container.querySelector('[title="Thinking…"]')).toBeNull()
  })

  it('keeps the ring counts up during a run', () => {
    // The counts are the node's only advertisement that the orbital ring exists,
    // and they duplicate nothing the bubble says. Gating them alongside the verb
    // is the obvious-looking cleanup that must not happen.
    seed({ status: 'running' })
    const { container } = renderNode(
      nodeProps({ status: 'running', ringCounts: { skills: 2, connectors: 1, routes: 0 } }),
    )

    expect(container.textContent).toContain('2 skills')
  })

  it('keeps the verb when the agent is idle', () => {
    seed({ status: 'idle' })
    const { container } = renderNode(nodeProps({ status: 'idle' }))

    expect(container.querySelector('[title]')).not.toBeNull()
  })
})

// ─── Status classes ──────────────────────────────────────────────────────────

describe('BooNode — status drives the cast/glow classes', () => {
  // CLASS PRESENCE ONLY. jsdom loads no CSS, so this proves the right rule was
  // selected and says nothing about what it paints.
  const classesFor = (status: AgentState['status']) => {
    seed({ status })
    const { container, unmount } = renderNode(nodeProps({ status }))
    const cls = container.querySelector('.boo-cast')?.className ?? ''
    unmount()
    return cls
  }

  it('pulses only while running', () => {
    expect(classesFor('running')).toContain('boo-cast--pulse')
    // A stopped run must stop moving. Same rule as the bubble's pulse, expressed
    // in CSS instead of in a component.
    expect(classesFor('error')).not.toContain('boo-cast--pulse')
  })

  it('glows for running and error, and never for sleeping', () => {
    expect(classesFor('running')).toContain('boo-cast--glow')
    expect(classesFor('error')).toContain('boo-cast--glow')
    // A glow ADDS light, so it could only make a dormant agent more prominent
    // than a working one. Sleeping desaturates instead.
    expect(classesFor('sleeping')).not.toContain('boo-cast--glow')
    expect(classesFor('sleeping')).toContain('boo-cast--sleeping')
  })

  it('leaves an idle Boo with the cast shadow alone', () => {
    const cls = classesFor('idle')
    expect(cls).toContain('boo-cast')
    expect(cls).not.toContain('--glow')
    expect(cls).not.toContain('--sleeping')
  })
})

// ─── The live pip ────────────────────────────────────────────────────────────

describe('BooNode — the event-sourced pip', () => {
  it('renders only for actionable states', () => {
    seed({ status: 'idle' })
    useObsOverlayStore.setState({ statusByAgent: new Map([['a1', 'working']]) })
    const { unmount } = renderNode(nodeProps())
    expect(screen.getByTitle('live: working')).toBeInTheDocument()
    unmount()

    // An idle projection must leave the canvas looking exactly as it did. A
    // truthiness-only check here would stipple every agent on the graph.
    useObsOverlayStore.setState({ statusByAgent: new Map([['a1', 'idle']]) })
    renderNode(nodeProps())
    expect(screen.queryByTitle(/^live:/)).not.toBeInTheDocument()
  })
})
