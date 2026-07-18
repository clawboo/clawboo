import { describe, expect, it } from 'vitest'

import type { RuntimeId } from '@/features/runtimes/runtimeCatalog'
import type { RuntimeStatus } from '@clawboo/control-client'
import {
  agentRuntimeOptions,
  nativeAvailable,
  resolveDefaultRuntime,
  runtimeAvailable,
  suggestedRuntimeFor,
} from '../runtimeSelection'

const status = (id: RuntimeId, over: Partial<RuntimeStatus> = {}): RuntimeStatus => ({
  id,
  ...over,
})

describe('runtimeSelection', () => {
  describe('agentRuntimeOptions', () => {
    it('always offers Native + OpenClaw + the 3 coding runtimes', () => {
      const ids = agentRuntimeOptions([], false).map((o) => o.sourceId)
      expect(ids).toEqual(['clawboo-native', 'openclaw', 'claude-code', 'codex', 'hermes'])
    })

    it('native is always enabled; openclaw gates on the Gateway connection', () => {
      const off = agentRuntimeOptions([], false)
      expect(off.find((o) => o.sourceId === 'clawboo-native')!.enabled).toBe(true)
      const ocOff = off.find((o) => o.sourceId === 'openclaw')!
      expect(ocOff.enabled).toBe(false)
      expect(ocOff.reason).toBeTruthy()

      const on = agentRuntimeOptions([], true)
      expect(on.find((o) => o.sourceId === 'openclaw')!.enabled).toBe(true)
    })

    it('a coding runtime is enabled only when its connect state is ready', () => {
      const opts = agentRuntimeOptions(
        [
          status('claude-code', { connectionState: 'ready' }),
          status('codex', { connectionState: 'needs-login' }),
        ],
        false,
      )
      const byId = Object.fromEntries(opts.map((o) => [o.sourceId, o]))
      expect(byId['claude-code']!.enabled).toBe(true)
      expect(byId['codex']!.enabled).toBe(false)
      // hermes absent from the status list → not ready → disabled with a reason.
      expect(byId['hermes']!.enabled).toBe(false)
      expect(byId['hermes']!.reason).toBeTruthy()
    })
  })

  describe('nativeAvailable', () => {
    it('is true with a credential OR a ready connect state, false otherwise', () => {
      expect(nativeAvailable([status('clawboo-native', { hasCredential: true })])).toBe(true)
      expect(nativeAvailable([status('clawboo-native', { connectionState: 'ready' })])).toBe(true)
      expect(nativeAvailable([status('clawboo-native', {})])).toBe(false)
      expect(nativeAvailable([])).toBe(false)
    })
  })

  describe('runtimeAvailable', () => {
    it('openclaw needs the Gateway; native needs a key; coding needs ready', () => {
      const statuses = [
        status('clawboo-native', { hasCredential: true }),
        status('claude-code', { connectionState: 'ready' }),
        status('codex', { connectionState: 'needs-auth' }),
      ]
      expect(runtimeAvailable('openclaw', { statuses, openclawConnected: true })).toBe(true)
      expect(runtimeAvailable('openclaw', { statuses, openclawConnected: false })).toBe(false)
      expect(runtimeAvailable('clawboo-native', { statuses, openclawConnected: false })).toBe(true)
      expect(runtimeAvailable('claude-code', { statuses, openclawConnected: false })).toBe(true)
      expect(runtimeAvailable('codex', { statuses, openclawConnected: false })).toBe(false)
    })
  })

  describe('suggestedRuntimeFor (precedence)', () => {
    it('marketplace team → openclaw; blank team → native', () => {
      expect(suggestedRuntimeFor({ isMarketplaceTeam: true })).toBe('openclaw')
      expect(suggestedRuntimeFor({ isMarketplaceTeam: false })).toBe('clawboo-native')
    })

    it('a team default overrides the source rule', () => {
      expect(suggestedRuntimeFor({ teamDefault: 'clawboo-native', isMarketplaceTeam: true })).toBe(
        'clawboo-native',
      )
    })

    it('a per-agent suggestion wins over everything', () => {
      expect(
        suggestedRuntimeFor({
          agentSuggested: 'hermes',
          teamDefault: 'clawboo-native',
          isMarketplaceTeam: true,
        }),
      ).toBe('hermes')
    })

    describe('preferNative (onboarding)', () => {
      // The wizard's only guaranteed-connected runtime is the provider key just
      // entered. Before this, a first-run user with a REACHABLE Gateway deployed
      // their whole first team onto OpenClaw (the source rule suggests OpenClaw for a
      // marketplace team, and `resolveDefaultRuntime` only degrades an UNAVAILABLE
      // suggestion) — leaving the team with no native member, so the DEFAULT-NATIVE
      // Boo Zero was never created and the OpenClaw `main` fallback led the team.
      it('outranks the marketplace source rule', () => {
        expect(suggestedRuntimeFor({ isMarketplaceTeam: true, preferNative: true })).toBe(
          'clawboo-native',
        )
      })

      it('outranks the catalog fields too — nothing can pull onboarding off native', () => {
        expect(
          suggestedRuntimeFor({
            agentSuggested: 'hermes',
            teamDefault: 'openclaw',
            isMarketplaceTeam: true,
            preferNative: true,
          }),
        ).toBe('clawboo-native')
      })

      it('is off by default — normal team creation keeps the source rule', () => {
        expect(suggestedRuntimeFor({ isMarketplaceTeam: true, preferNative: false })).toBe(
          'openclaw',
        )
        expect(suggestedRuntimeFor({ isMarketplaceTeam: true })).toBe('openclaw')
      })
    })
  })

  describe('resolveDefaultRuntime (availability degradation)', () => {
    it('keeps an available suggestion, tracking no degradation', () => {
      const a = { statuses: [], openclawConnected: true }
      expect(resolveDefaultRuntime('openclaw', a)).toEqual({
        selected: 'openclaw',
        degradedFrom: null,
      })
    })

    it('degrades an unavailable openclaw suggestion to native, tracking the source', () => {
      const a = { statuses: [], openclawConnected: false }
      expect(resolveDefaultRuntime('openclaw', a)).toEqual({
        selected: 'clawboo-native',
        degradedFrom: 'openclaw',
      })
    })

    it('degrades an unavailable coding suggestion to native', () => {
      const a = {
        statuses: [status('hermes', { connectionState: 'needs-auth' })],
        openclawConnected: false,
      }
      expect(resolveDefaultRuntime('hermes', a)).toEqual({
        selected: 'clawboo-native',
        degradedFrom: 'hermes',
      })
    })
  })
})
