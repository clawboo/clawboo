// Native-preservation routing contract. The host branches ONLY on the plan
// `resolveRuntimeIntegration` returns — these tests pin the mapping: omission
// resolves to the conservative one-shot default, each runtimeClass routes to
// its depth, preserve claims are clamped to a persistent home, and no
// declaration can ever opt a runtime into co-running its own scheduler.

import { describe, expect, it } from 'vitest'

import { resolveRuntimeIntegration } from '../integration'
import type { Capabilities } from '../types'

const BASE: Capabilities = {
  streaming: true,
  mcp: true,
  worktrees: true,
  resume: true,
  toolApproval: true,
  models: [],
}

describe('resolveRuntimeIntegration', () => {
  it('an omitted seam resolves to the conservative one-shot default', () => {
    expect(resolveRuntimeIntegration(BASE)).toEqual({
      home: { kind: 'ephemeral' },
      preserveSkills: false,
      preserveMemory: false,
      useGatewayChannels: false,
      coRunScheduler: false,
    })
  })

  it('connected-substrate resolves to a connected home + gateway routing', () => {
    expect(
      resolveRuntimeIntegration({
        ...BASE,
        runtimeClass: 'connected-substrate',
        nativeChannels: 'gateway',
        nativeScheduler: true,
      }),
    ).toEqual({
      home: { kind: 'connected' },
      preserveSkills: false,
      preserveMemory: false,
      useGatewayChannels: true,
      coRunScheduler: false,
    })
  })

  it('connected-substrate without a gateway channel claim does not route channels', () => {
    const plan = resolveRuntimeIntegration({ ...BASE, runtimeClass: 'connected-substrate' })
    expect(plan.home).toEqual({ kind: 'connected' })
    expect(plan.useGatewayChannels).toBe(false)
  })

  it('a per-identity persistent home resolves with the preserve flags (the Hermes shape)', () => {
    expect(
      resolveRuntimeIntegration({
        ...BASE,
        streaming: false,
        runtimeClass: 'wrapped-oneshot',
        nativeHome: { scope: 'per-identity', persist: true },
        nativeSkills: 'preserve',
        nativeMemory: 'preserve',
        nativeChannels: 'none',
        nativeScheduler: true,
      }),
    ).toEqual({
      home: { kind: 'persistent', scope: 'per-identity' },
      preserveSkills: true,
      preserveMemory: true,
      useGatewayChannels: false,
      coRunScheduler: false,
    })
  })

  it('a per-run non-persistent home resolves ephemeral (the Codex shape)', () => {
    const plan = resolveRuntimeIntegration({
      ...BASE,
      runtimeClass: 'wrapped-oneshot',
      nativeHome: { scope: 'per-run', persist: false },
      nativeSkills: 'none',
      nativeMemory: 'none',
    })
    expect(plan.home).toEqual({ kind: 'ephemeral' })
    expect(plan.preserveSkills).toBe(false)
    expect(plan.preserveMemory).toBe(false)
  })

  it('preserve claims WITHOUT a persistent home are clamped off (misdeclaration degrades safe)', () => {
    const noHome = resolveRuntimeIntegration({
      ...BASE,
      nativeSkills: 'preserve',
      nativeMemory: 'preserve',
    })
    expect(noHome).toMatchObject({
      home: { kind: 'ephemeral' },
      preserveSkills: false,
      preserveMemory: false,
    })

    const perRun = resolveRuntimeIntegration({
      ...BASE,
      nativeHome: { scope: 'per-run', persist: true }, // persist without per-identity scope
      nativeSkills: 'preserve',
    })
    expect(perRun).toMatchObject({ home: { kind: 'ephemeral' }, preserveSkills: false })
  })

  it('the native class resolves like wrapped-oneshot (a native runtime declares its own home claim)', () => {
    expect(
      resolveRuntimeIntegration({
        ...BASE,
        runtimeClass: 'native',
        nativeHome: { scope: 'per-identity', persist: true },
        nativeMemory: 'preserve',
      }),
    ).toEqual({
      home: { kind: 'persistent', scope: 'per-identity' },
      preserveSkills: false,
      preserveMemory: true,
      useGatewayChannels: false,
      coRunScheduler: false,
    })
  })

  it('coRunScheduler is false for every class even when nativeScheduler is declared', () => {
    for (const runtimeClass of ['wrapped-oneshot', 'connected-substrate', 'native'] as const) {
      const plan = resolveRuntimeIntegration({ ...BASE, runtimeClass, nativeScheduler: true })
      expect(plan.coRunScheduler).toBe(false)
    }
  })
})
