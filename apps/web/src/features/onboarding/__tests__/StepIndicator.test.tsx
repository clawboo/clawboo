// StepIndicator — the default OpenClaw path shows Setup/Team/Deploy; the native
// path passes NATIVE_STEPS so it never promises Team/Deploy beats it can't reach.

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { NATIVE_STEPS, StepIndicator } from '../StepIndicator'

afterEach(() => cleanup())

describe('StepIndicator', () => {
  it('default renders the 3-beat Setup / Team / Deploy flow', () => {
    render(<StepIndicator current="setup" />)
    expect(screen.getByText('Setup')).toBeInTheDocument()
    expect(screen.getByText('Team')).toBeInTheDocument()
    expect(screen.getByText('Deploy')).toBeInTheDocument()
  })

  it('the native variant shows a 2-beat Connect / Ready flow, not Team/Deploy', () => {
    render(<StepIndicator current="connect" steps={NATIVE_STEPS} />)
    expect(screen.getByText('Connect')).toBeInTheDocument()
    expect(screen.getByText('Ready')).toBeInTheDocument()
    expect(screen.queryByText('Team')).not.toBeInTheDocument()
    expect(screen.queryByText('Deploy')).not.toBeInTheDocument()
  })
})
