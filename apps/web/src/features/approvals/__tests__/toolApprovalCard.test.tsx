// The consent surface itself.
//
// These pin the properties an earlier draft of this card got wrong, each of
// which is a way for a card to look tidy while quietly misinforming the person
// it is asking: an "Always" the server will not honour, a recipient hidden
// behind a disclosure, a raw tool name where a sentence belongs, and the agent's
// own unverified words presented as clawboo's description of the request.

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { ToolApprovalCard } from '../ToolApprovalCard'
import type { ToolApproval } from '../usePendingApprovals'

const base: ToolApproval = {
  id: 'tc-1',
  toolName: 'mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL',
  agentId: null,
  argsSummary: JSON.stringify({
    current_step: 'Sending the opt-out reply',
    tools: [
      {
        tool_slug: 'GMAIL_SEND_EMAIL',
        arguments: { recipient_email: 'boss@example.com', subject: 'Resignation' },
      },
    ],
  }),
  reason: '"mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL" has external side effects.',
  createdAt: 1000,
  expiresAt: Date.now() + 60_000,
}

const show = (over: Partial<ToolApproval> = {}) => {
  const onResolve = vi.fn()
  render(<ToolApprovalCard approval={{ ...base, ...over }} onResolve={onResolve} />)
  return onResolve
}

describe('ToolApprovalCard', () => {
  it('asks in plain language and never shows the raw tool name', () => {
    show()
    expect(screen.getByRole('heading')).toHaveTextContent(
      /wants to send something from your Gmail/i,
    )
    expect(screen.queryByText(/COMPOSIO_MULTI_EXECUTE_TOOL/)).not.toBeInTheDocument()
    expect(screen.queryByText(/mcp__/)).not.toBeInTheDocument()
  })

  it('shows the recipient WITHOUT expanding anything', () => {
    // The consent failure this prevents: approving a send whose destination the
    // person never saw because it sat behind a disclosure triangle.
    show()
    expect(screen.getByText('boss@example.com')).toBeInTheDocument()
    expect(screen.getByText('Resignation')).toBeInTheDocument()
  })

  it('hides "Always" when the server could not mint a rule for it', () => {
    // grantId is null on every brokered app call, and resolveApproval refuses to
    // write a standing rule without one, so the control would silently do nothing.
    show({ grantId: null })
    expect(screen.queryByLabelText(/do not ask again/i)).not.toBeInTheDocument()
  })

  it('offers "Always" only when the server can honour it', () => {
    show({ grantId: 'grant-1' })
    expect(screen.getByLabelText(/do not ask again/i)).toBeInTheDocument()
  })

  it('keeps the agent own words behind the fold, quoted and marked unverified', () => {
    show()
    // Not visible until asked for.
    expect(screen.queryByText('Sending the opt-out reply')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /show \d+ more detail/i })).toBeInTheDocument()
  })

  it('reveals the model note attributed, once expanded', async () => {
    show()
    await userEvent.click(screen.getByRole('button', { name: /show \d+ more detail/i }))
    expect(screen.getByText('Sending the opt-out reply')).toBeInTheDocument()
    expect(screen.getByText(/clawboo has not verified it/i)).toBeInTheDocument()
  })

  it('says plainly when it does not know which agent asked', () => {
    show({ agentId: null })
    expect(screen.getByText(/could not tell which agent/i)).toBeInTheDocument()
  })

  it('gives the two choices distinct weight, and does not steal focus', () => {
    // The old card made Allow and Deny both red, which reads as two alarms and
    // marks neither as the safe option. And a card arriving on a 3-second poll
    // must never take focus from the composer it sits above.
    show()
    const allow = screen.getByRole('button', { name: /send it/i })
    const deny = screen.getByRole('button', { name: /don't allow/i })
    expect(allow.className).not.toBe(deny.className)
    expect(document.activeElement).toBe(document.body)
  })

  it('resolves with the decision the button promises', async () => {
    const onResolve = show()
    await userEvent.click(screen.getByRole('button', { name: /don't allow/i }))
    expect(onResolve).toHaveBeenCalledWith('tc-1', 'deny')
  })

  it('upgrades to allow_always only when the box is ticked', async () => {
    const onResolve = show({ grantId: 'grant-1' })
    await userEvent.click(screen.getByLabelText(/do not ask again/i))
    await userEvent.click(screen.getByRole('button', { name: /send it/i }))
    expect(onResolve).toHaveBeenCalledWith('tc-1', 'allow_always')
  })

  it('falls back to the raw truth for a tool it cannot describe', () => {
    show({ toolName: 'mcp__weird__frobnicate', argsSummary: '{"target":"prod"}' })
    expect(screen.getByRole('heading')).toHaveTextContent(/Frobnicate/)
    expect(screen.getByText(/cannot tell what this does/i)).toBeInTheDocument()
    // And no "Always" on something clawboo could not read.
    expect(screen.queryByLabelText(/do not ask again/i)).not.toBeInTheDocument()
  })
})
