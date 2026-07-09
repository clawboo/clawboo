// StepIndicator — the native-first spine: Connect → Runtimes → Ready. The
// retired OpenClaw Setup/Team/Deploy beats are gone.

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { NATIVE_STEPS, StepIndicator } from '../StepIndicator'

afterEach(() => cleanup())

describe('StepIndicator', () => {
  it('renders the 3-beat Connect / Runtimes / Ready spine', () => {
    render(<StepIndicator current="runtimes" />)
    expect(screen.getByText('Connect')).toBeInTheDocument()
    expect(screen.getByText('Runtimes')).toBeInTheDocument()
    expect(screen.getByText('Ready')).toBeInTheDocument()
  })

  it('no longer shows the retired Team / Deploy beats', () => {
    render(<StepIndicator current="connect" steps={NATIVE_STEPS} />)
    expect(screen.queryByText('Team')).not.toBeInTheDocument()
    expect(screen.queryByText('Deploy')).not.toBeInTheDocument()
    expect(screen.queryByText('Setup')).not.toBeInTheDocument()
  })
})
