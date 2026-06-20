import { describe, it, expect } from 'vitest'

import { decideOnboardingView, type OnboardingDecisionInputs } from '../onboardingProgress'

const base: OnboardingDecisionInputs = {
  onboarded: false,
  configured: false,
  statusKnown: true,
  wizardActive: false,
  hasTeam: false,
  hasNative: false,
  hasConnectedRuntime: false,
}
const decide = (o: Partial<OnboardingDecisionInputs>) => decideOnboardingView({ ...base, ...o })

describe('decideOnboardingView', () => {
  // THE regression this locks: a configured returning user with a STALE
  // `wizard.active` marker (a transient not-configured blip armed it + cleared
  // `onboarded`) must NOT be trapped in the wizard.
  it('rescues a configured returning user from a stale wizard.active marker (has a team)', () => {
    expect(decide({ configured: true, wizardActive: true, onboarded: false, hasTeam: true })).toBe(
      'dashboard',
    )
  })

  it('configured + onboarded → dashboard (even with a stale active marker)', () => {
    expect(decide({ configured: true, onboarded: true, wizardActive: true, hasTeam: false })).toBe(
      'dashboard',
    )
  })

  it('keeps a GENUINE mid-onboarding run in the wizard (configured, active, not onboarded, no team)', () => {
    expect(decide({ configured: true, wizardActive: true, onboarded: false, hasTeam: false })).toBe(
      'wizard-resume',
    )
  })

  it('configured with no active run → dashboard', () => {
    expect(decide({ configured: true })).toBe('dashboard')
  })

  it('definitively not configured + no native agent → fresh wizard', () => {
    expect(decide({ configured: false, statusKnown: true, hasNative: false })).toBe('wizard-fresh')
  })

  it('definitively not configured + a native agent → native mode', () => {
    expect(decide({ configured: false, statusKnown: true, hasNative: true })).toBe('native')
  })

  // onboarding-reload-001: a GENUINE mid-onboarding reload on a not-yet-configured path
  // (wizard armed, not onboarded, no native agent yet) must RESUME the wizard at the
  // persisted step — not reset to a fresh wizard (which wipes onboarded + the runtime).
  it('not configured + a wizard run in progress (not onboarded, no native) → resume the wizard', () => {
    expect(
      decide({
        configured: false,
        statusKnown: true,
        wizardActive: true,
        onboarded: false,
        hasNative: false,
      }),
    ).toBe('wizard-resume')
  })

  // ...even with a credential already resolvable mid-flow: `onboarded` is still false,
  // so this is a resume, NOT the completed-coding-agent `native` path. Contrast the
  // `wizardActive: false` case above which correctly falls to a fresh wizard.
  it('not configured + a wizard run in progress + a connected runtime (not onboarded) → resume', () => {
    expect(
      decide({
        configured: false,
        statusKnown: true,
        wizardActive: true,
        onboarded: false,
        hasNative: false,
        hasConnectedRuntime: true,
      }),
    ).toBe('wizard-resume')
  })

  // THE reload-trap regression: a completed coding-agent user (finished the
  // wizard, no OpenClaw, no native agent, BUT a connected non-OpenClaw runtime)
  // must land in the dashboard on reload — not be re-trapped in a fresh wizard.
  it('not configured + onboarded + a connected runtime → native (no reload-trap)', () => {
    expect(
      decide({
        configured: false,
        statusKnown: true,
        hasNative: false,
        onboarded: true,
        hasConnectedRuntime: true,
      }),
    ).toBe('native')
  })

  // The `onboarded &&` guard: a user who merely has a provider env var set
  // (a credential resolves) but never onboarded still runs the wizard.
  it('not configured + a connected runtime but NOT onboarded → fresh wizard', () => {
    expect(
      decide({
        configured: false,
        statusKnown: true,
        hasNative: false,
        onboarded: false,
        hasConnectedRuntime: true,
      }),
    ).toBe('wizard-fresh')
  })

  // Scope boundary: a user who picked a coding agent and SKIPPED connecting set
  // up nothing — no connected runtime — so they correctly re-onboard.
  it('not configured + onboarded but NO connected runtime → fresh wizard', () => {
    expect(
      decide({
        configured: false,
        statusKnown: true,
        hasNative: false,
        onboarded: true,
        hasConnectedRuntime: false,
      }),
    ).toBe('wizard-fresh')
  })

  // Transient status failure: never trap, never nuke flags.
  it('transient + onboarded → dashboard (preserve state)', () => {
    expect(decide({ statusKnown: false, onboarded: true })).toBe('dashboard-transient')
  })

  it('transient + an active run → resume the wizard', () => {
    expect(decide({ statusKnown: false, onboarded: false, wizardActive: true })).toBe(
      'wizard-resume',
    )
  })

  it('transient + nothing known → wizard WITHOUT arming the marker', () => {
    expect(decide({ statusKnown: false, onboarded: false, wizardActive: false })).toBe(
      'wizard-transient',
    )
  })
})
