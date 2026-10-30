// InlineApprovalCard: the stock card the chat tray shows, and the board variant
// the calendar's Needs you cell shows. The variant changes the look only: all
// three buttons resolve through the same handleApproval either way.

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ThemeProvider } from '@/features/theme/ThemeProvider'
import type { ApprovalRequest } from '@/stores/approvals'
import { useFleetStore } from '@/stores/fleet'
import { InlineApprovalCard } from '../InlineApprovalCard'

const { handleApproval } = vi.hoisted(() => ({ handleApproval: vi.fn() }))
vi.mock('../useApprovalActions', () => ({ useApprovalActions: () => ({ handleApproval }) }))

const approval: ApprovalRequest = {
  id: 'ex-1',
  agentId: 'a1',
  sessionKey: null,
  command: 'rm -rf build',
  cwd: null,
  host: null,
  security: null,
  ask: null,
  resolvedPath: null,
  createdAtMs: 500,
  expiresAtMs: Date.now() + 60_000,
  resolving: false,
  error: null,
}

function renderCard(variant: 'default' | 'board', overrides: Partial<ApprovalRequest> = {}) {
  // The board variant's agent avatar reads the theme.
  render(
    <ThemeProvider>
      <InlineApprovalCard
        approval={{ ...approval, ...overrides }}
        showAgentName
        variant={variant}
      />
    </ThemeProvider>,
  )
}

const button = (name: string) => screen.getByRole('button', { name })

beforeEach(() => {
  // The card's layout animation restores the scroll position, which jsdom lacks.
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
  handleApproval.mockReset()
  handleApproval.mockResolvedValue(undefined)
  useFleetStore.setState({ agents: [{ id: 'a1', name: 'Coder', teamId: 'team1' }] as never })
})
afterEach(() => cleanup())

describe('InlineApprovalCard', () => {
  it('keeps the stock look by default: the pill, a red Allow Once and a red Deny', () => {
    renderCard('default')
    expect(screen.getByText('Exec Approval')).toBeInTheDocument()
    expect(screen.queryByText('Wants to run a command')).toBeNull()
    expect(screen.getByText('Coder')).toBeInTheDocument()
    expect(button('Allow Once').className).toContain('bg-primary-solid')
    expect(button('Deny').className).toContain('bg-destructive-solid')
  })

  it('reads as amber words with ink and outline buttons on the board', () => {
    renderCard('board')
    expect(screen.getByText('Wants to run a command').closest('.board-reason')).not.toBeNull()
    expect(screen.queryByText('Exec Approval')).toBeNull()
    expect(document.querySelector('.uppercase')).toBeNull()
    expect(screen.getByText('Coder')).toBeInTheDocument()
    expect(screen.getByText('rm -rf build')).toHaveClass('font-mono')

    // One filled emphasis, in ink; the other two outlined; no red anywhere.
    expect(button('Allow Once').className).toContain('bg-foreground')
    for (const name of ['Always', 'Deny']) {
      expect(button(name).className).toContain('border-border-strong')
    }
    for (const name of ['Allow Once', 'Always', 'Deny']) {
      expect(button(name).className).not.toMatch(/primary-solid|destructive/)
    }
  })

  it.each(['default', 'board'] as const)(
    'resolves each decision through the same handler (%s)',
    async (variant) => {
      renderCard(variant)
      await userEvent.click(button('Allow Once'))
      await userEvent.click(button('Always'))
      await userEvent.click(button('Deny'))
      expect(handleApproval.mock.calls).toEqual([
        ['ex-1', 'allow-once'],
        ['ex-1', 'allow-always'],
        ['ex-1', 'deny'],
      ])
    },
  )

  it.each(['default', 'board'] as const)(
    'holds every decision while one is being sent (%s)',
    (variant) => {
      renderCard(variant, { resolving: true })
      for (const name of ['Allow Once', 'Always', 'Deny']) {
        expect(button(name)).toBeDisabled()
      }
    },
  )
})
