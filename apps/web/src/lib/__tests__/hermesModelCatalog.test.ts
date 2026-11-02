import { describe, expect, it } from 'vitest'

import {
  HERMES_CODEX_GROUP,
  HERMES_CODEX_MODELS,
  HERMES_MODEL_GROUPS,
  HERMES_OPENROUTER_GROUP_NAME,
  hermesModelExec,
  hermesModelSave,
  hermesPlanModelNote,
  hermesStoredProvider,
} from '../hermesModelCatalog'

describe('hermesModelCatalog', () => {
  it('maps every picked model id to the openrouter provider (Hermes routes all models via OpenRouter)', () => {
    expect(hermesModelExec('openai/gpt-4o-mini')).toEqual({
      provider: 'openrouter',
      model: 'openai/gpt-4o-mini',
    })
    expect(hermesModelExec('anthropic/claude-3.5-sonnet')).toEqual({
      provider: 'openrouter',
      model: 'anthropic/claude-3.5-sonnet',
    })
    // A live / unlisted OpenRouter id still routes via openrouter.
    expect(hermesModelExec('mistralai/mixtral-8x7b')).toEqual({
      provider: 'openrouter',
      model: 'mistralai/mixtral-8x7b',
    })
  })

  it('returns null for an empty id (caller keeps the key-derived default)', () => {
    expect(hermesModelExec('')).toBeNull()
  })

  it('exposes a single OpenRouter fallback group of vendor/model slugs that all resolve', () => {
    expect(HERMES_MODEL_GROUPS).toHaveLength(1)
    expect(HERMES_MODEL_GROUPS[0]!.provider).toBe(HERMES_OPENROUTER_GROUP_NAME)
    expect(HERMES_MODEL_GROUPS[0]!.models.length).toBeGreaterThan(0)
    for (const m of HERMES_MODEL_GROUPS[0]!.models) {
      expect(m.id).toContain('/') // OpenRouter vendor/model slug
      expect(hermesModelExec(m.id)).toEqual({ provider: 'openrouter', model: m.id })
    }
  })

  // ── ChatGPT subscription (openai-codex) ────────────────────────────────────
  it('routes ONLY the openai-codex/ routing prefix to the subscription provider (prefix stripped)', () => {
    expect(hermesModelExec('openai-codex/gpt-5.5')).toEqual({
      provider: 'openai-codex',
      model: 'gpt-5.5',
    })
    // The load-bearing discriminator: `openai/…` is an OpenRouter VENDOR slug,
    // not the subscription prefix — a generic first-slash split would misroute it.
    expect(hermesModelExec('openai/gpt-4o-mini')).toEqual({
      provider: 'openrouter',
      model: 'openai/gpt-4o-mini',
    })
  })

  it('every subscription-group id carries the routing prefix and resolves to a bare backend id', () => {
    expect(HERMES_CODEX_GROUP.models).toBe(HERMES_CODEX_MODELS)
    expect(HERMES_CODEX_MODELS.length).toBeGreaterThan(0)
    for (const m of HERMES_CODEX_MODELS) {
      const exec = hermesModelExec(m.id)
      expect(exec).toEqual({ provider: 'openai-codex', model: m.id.slice('openai-codex/'.length) })
      expect(exec!.model).not.toContain('/') // bare backend id, prefix stripped
    }
  })

  it('the subscription group is NOT in the static fallback (it is offered only when auth is detected)', () => {
    expect(HERMES_MODEL_GROUPS.some((g) => g.provider === HERMES_CODEX_GROUP.provider)).toBe(false)
  })

  // ── The agent page's model control ────────────────────────────────────────
  // A ChatGPT-subscription agent stores { provider: 'openai-codex', model } with a
  // bare model id. A model change keeps that provider unless the pick comes from
  // another provider's group.
  it('a pick from the subscription group saves with the openai-codex provider', () => {
    expect(hermesModelSave('openai-codex/plan-model-b', true)).toEqual({
      provider: 'openai-codex',
      model: 'plan-model-b',
    })
  })

  it('a pick from the OpenRouter group saves with the openrouter provider', () => {
    expect(hermesModelSave('openai/gpt-4o-mini', true)).toEqual({
      provider: 'openrouter',
      model: 'openai/gpt-4o-mini',
    })
  })

  it('a typed custom id names no provider, so the agent keeps its own', () => {
    expect(hermesModelSave('vendor/custom-model', false)).toEqual({ model: 'vendor/custom-model' })
    // Typed with the subscription prefix, it still pins the subscription.
    expect(hermesModelSave('openai-codex/plan-model-c', false)).toEqual({
      provider: 'openai-codex',
      model: 'plan-model-c',
    })
    expect(hermesModelSave('', false)).toBeNull()
  })

  it('a subscription agent gets a note with its stored model, never a model list', () => {
    expect(
      hermesPlanModelNote({ provider: 'openai-codex', model: 'plan-model-a' }, 'plan-model-a'),
    ).toMatchObject({ pill: 'plan-model-a · ChatGPT plan' })
    expect(
      hermesPlanModelNote({ provider: 'openai-codex' }, 'openai-codex/plan-model-a')?.pill,
    ).toBe('plan-model-a · ChatGPT plan')
    expect(hermesPlanModelNote({ provider: 'openai-codex' }, null)?.pill).toBe('ChatGPT plan')
    // An OpenRouter agent keeps its model switch.
    expect(hermesPlanModelNote({ provider: 'openrouter', model: 'x' }, 'x')).toBeNull()
    expect(hermesPlanModelNote(null, 'x')).toBeNull()
  })

  it('reads the stored provider from an execConfig', () => {
    expect(hermesStoredProvider({ provider: 'openai-codex', model: 'm' })).toBe('openai-codex')
    expect(hermesStoredProvider({ model: 'm' })).toBeNull()
    expect(hermesStoredProvider(null)).toBeNull()
  })
})
