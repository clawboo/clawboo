// AgentBooAvatar picks between a runtime's locked brand Boo and the generated mascot.
//
// BooVariantAvatar is stubbed: what matters here is the CHOICE and the props behind it (which
// variant, which colour, which surface), and the real component fetches 188KB of locked artwork
// through a dynamic import to prove the same thing. Its own render is covered in @clawboo/ui.

import type { ReactElement } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ThemeProvider } from '@/features/theme/ThemeProvider'
import { pickBooColor } from '@/lib/resolveTeamBooColor'
import { useBooZeroStore } from '@/stores/booZero'
import { useFleetStore } from '@/stores/fleet'
import { useTeamStore } from '@/stores/team'

import { AgentBooAvatar, MASCOT_ASPECT, useAgentBooAspect } from '../AgentBooAvatar'

vi.mock('@clawboo/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@clawboo/ui')>()
  return {
    ...actual,
    BooVariantAvatar: ({
      variantId,
      tint,
      surface,
    }: {
      variantId: string
      tint?: string | null
      surface?: string
    }) => (
      <span
        data-testid="boo-variant"
        data-variant-id={variantId}
        // `null` and `undefined` both mean "keep the variant's own colour", and the component is
        // meant to state that with an explicit null, so the two are distinguishable here.
        data-tint={tint === null ? 'null' : tint === undefined ? 'undefined' : tint}
        data-surface={surface}
      />
    ),
  }
})

// AgentBooAvatar reads theme context for the surface and for the palette's theme adaptation.
const renderAvatar = (ui: ReactElement) => render(<ThemeProvider>{ui}</ThemeProvider>)

const generatedSvg = (container: HTMLElement) => container.querySelector('svg')

afterEach(cleanup)

beforeEach(() => {
  useFleetStore.setState({ agents: [], selectedAgentId: null } as never)
  useBooZeroStore.setState({ booZeroAgentId: null })
  useTeamStore.setState({ teams: [] } as never)
})

describe('AgentBooAvatar variant selection', () => {
  it('draws the Codex variant for a codex-runtime agent', () => {
    useFleetStore.setState({
      agents: [{ id: 'a1', name: 'Codex Boo', teamId: null, runtime: 'codex' }],
    } as never)

    const { container } = renderAvatar(<AgentBooAvatar agentId="a1" />)

    const variant = screen.getByTestId('boo-variant')
    expect(variant.getAttribute('data-variant-id')).toBe('codex')
    expect(variant.getAttribute('data-surface')).toBe('light')
    // The generated mascot is not also drawn: the runtime's artwork replaces it.
    expect(generatedSvg(container)).toBeNull()
  })

  it('keeps the generated mascot for an openclaw agent', () => {
    useFleetStore.setState({
      agents: [{ id: 'a2', name: 'Ops Boo', teamId: null, runtime: 'openclaw' }],
    } as never)

    const { container } = renderAvatar(<AgentBooAvatar agentId="a2" />)

    expect(screen.queryByTestId('boo-variant')).toBeNull()
    expect(generatedSvg(container)?.getAttribute('viewBox')).toBe('0 0 100 92')
  })

  it('keeps the reserved red generated mascot for Boo Zero, even on a codex runtime', () => {
    useFleetStore.setState({
      agents: [{ id: 'zero', name: 'Boo Zero', teamId: null, runtime: 'codex' }],
    } as never)
    useBooZeroStore.setState({ booZeroAgentId: 'zero' })

    const { container } = renderAvatar(<AgentBooAvatar agentId="zero" />)

    expect(screen.queryByTestId('boo-variant')).toBeNull()
    // OpenClaw Red (TINTS[0]) is reserved for Boo Zero and is what the gradient paints with.
    expect(generatedSvg(container)?.outerHTML).toContain('#ff4d4d')
  })

  it("passes a teamed agent's palette colour through to the variant", () => {
    const teamId = 'team-variant-tint'
    const members = ['c1', 'c2', 'c3']
    useTeamStore.setState({
      teams: [{ id: teamId, name: 'Codex crew', colorCollectionId: 'vivid-pop' }],
    } as never)
    useFleetStore.setState({
      agents: members.map((id, i) => ({
        id,
        name: `Codex ${i + 1}`,
        teamId,
        runtime: 'codex',
      })),
    } as never)

    renderAvatar(<AgentBooAvatar agentId="c2" />)

    const expected = pickBooColor('vivid-pop', members, 'c2', 'light', teamId)
    expect(expected).toBeDefined()
    expect(screen.getByTestId('boo-variant').getAttribute('data-tint')?.toLowerCase()).toBe(
      expected!.toLowerCase(),
    )
  })

  it('passes null for a teamless agent, so the variant keeps its own colour', () => {
    useFleetStore.setState({
      agents: [{ id: 'solo', name: 'Solo Boo', teamId: null, runtime: 'claude-code' }],
    } as never)

    renderAvatar(<AgentBooAvatar agentId="solo" />)

    const variant = screen.getByTestId('boo-variant')
    expect(variant.getAttribute('data-variant-id')).toBe('claude')
    expect(variant.getAttribute('data-tint')).toBe('null')
  })
})

describe('useAgentBooAspect', () => {
  // A caller that positions anything under the mark, as the graph does with the agent's name,
  // needs the height the mark will actually draw at. The variants are squarer than the mascot.
  const Probe = ({ agentId }: { agentId: string }) => (
    <span data-testid="aspect">{useAgentBooAspect(agentId)}</span>
  )
  const aspectOf = (agentId: string): string => {
    renderAvatar(<Probe agentId={agentId} />)
    return screen.getByTestId('aspect').textContent ?? ''
  }

  it('reports the square variants and the mascot apart', () => {
    useFleetStore.setState({
      agents: [
        { id: 'cx', name: 'Codex', teamId: null, runtime: 'codex' },
        { id: 'hm', name: 'Hermes', teamId: null, runtime: 'hermes' },
        { id: 'oc', name: 'OpenClaw', teamId: null, runtime: 'openclaw' },
      ],
    } as never)

    expect(aspectOf('cx')).toBe('1')
    cleanup()
    expect(aspectOf('hm')).toBe('1')
    cleanup()
    expect(aspectOf('oc')).toBe(String(MASCOT_ASPECT))
  })

  it('reports the mascot for Boo Zero whatever its runtime', () => {
    useFleetStore.setState({
      agents: [{ id: 'z', name: 'Boo Zero', teamId: null, runtime: 'codex' }],
    } as never)
    useBooZeroStore.setState({ booZeroAgentId: 'z' })

    expect(aspectOf('z')).toBe(String(MASCOT_ASPECT))
  })
})
