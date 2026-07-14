import { cleanup, render, screen } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { server } from '../../../__vitest__/mswServer'
import { AgentModelControl } from '../AgentModelControl'

afterEach(() => cleanup())

const base = { currentModel: null, defaultModel: 'claude-sonnet-4-5', onModelChange: vi.fn() }

describe('AgentModelControl', () => {
  it('shows the runtime icon + an editable model dropdown for an OpenClaw agent (null runtime)', () => {
    server.use(
      http.get('/api/system/models', () =>
        HttpResponse.json({ groups: [], configuredProviders: [] }),
      ),
    )
    render(<AgentModelControl runtime={null} {...base} />)
    expect(screen.getByLabelText('Runtime: OpenClaw')).toBeInTheDocument()
    // Editable → an interactive dropdown trigger (button), NOT a static note.
    expect(screen.getByRole('button')).toBeInTheDocument()
  })

  it('replaces the dropdown with a framed runtime-managed NOTE for Codex', () => {
    render(<AgentModelControl runtime="codex" {...base} />)
    expect(screen.getByLabelText('Runtime: Codex')).toBeInTheDocument()
    expect(screen.getByText('Codex default')).toBeInTheDocument()
    // No editable dropdown for a runtime-managed model.
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('makes Hermes editable (an OpenRouter dropdown, not a note)', () => {
    server.use(
      http.get('/api/system/models', () =>
        HttpResponse.json({ groups: [], configuredProviders: [] }),
      ),
    )
    render(<AgentModelControl runtime="hermes" {...base} />)
    expect(screen.getByLabelText('Runtime: Hermes')).toBeInTheDocument()
    expect(screen.getByRole('button')).toBeInTheDocument() // editable dropdown, not a note
    expect(screen.queryByText('Team-set model')).not.toBeInTheDocument()
  })

  it('keeps the Claude Code note (SDK default, not editable)', () => {
    render(<AgentModelControl runtime="claude-code" {...base} />)
    expect(screen.getByText('Claude Code default')).toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })
})
