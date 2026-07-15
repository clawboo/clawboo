// StepIndicator — the native-first spine: Connect → Team → Runtimes → Ready.
// The "Team" beat is real team selection + deployment (the marketplace picker);
// the retired OpenClaw Setup/Deploy beats are gone.

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { NATIVE_STEPS, StepIndicator } from '../StepIndicator'

afterEach(() => cleanup())

describe('StepIndicator', () => {
  it('renders the 4-beat Connect / Team / Runtimes / Ready spine', () => {
    render(<StepIndicator current="team" />)
    expect(screen.getByText('Connect')).toBeInTheDocument()
    expect(screen.getByText('Team')).toBeInTheDocument()
    expect(screen.getByText('Runtimes')).toBeInTheDocument()
    expect(screen.getByText('Ready')).toBeInTheDocument()
  })

  it('no longer shows the retired OpenClaw Setup / Deploy beats', () => {
    render(<StepIndicator current="connect" steps={NATIVE_STEPS} />)
    expect(screen.queryByText('Deploy')).not.toBeInTheDocument()
    expect(screen.queryByText('Setup')).not.toBeInTheDocument()
  })
})
