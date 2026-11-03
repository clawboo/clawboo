import { describe, expect, it } from 'vitest'

import {
  HERMES_CODEX_GROUP_NAME,
  HERMES_CODEX_PLAN_DEFAULT_ID,
  HERMES_MODEL_GROUPS,
  HERMES_OPENROUTER_GROUP_NAME,
  hermesCodexGroup,
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
    expect(hermesModelExec('openai-codex/gpt-6-sol')).toEqual({
      provider: 'openai-codex',
      model: 'gpt-6-sol',
    })
    // The load-bearing discriminator: `openai/…` is an OpenRouter VENDOR slug,
    // not the subscription prefix — a generic first-slash split would misroute it.
    expect(hermesModelExec('openai/gpt-4o-mini')).toEqual({
      provider: 'openrouter',
      model: 'openai/gpt-4o-mini',
    })
  })

  it('the subscription group is the plan default, then the live models behind the routing prefix', () => {
    const group = hermesCodexGroup([
      { id: 'gpt-6-astra', label: 'GPT-6-Astra' },
      { id: 'gpt-5.6-luna', label: 'GPT-5.6-Luna' },
    ])
    expect(group.provider).toBe(HERMES_CODEX_GROUP_NAME)
    expect(group.models).toEqual([
      { id: HERMES_CODEX_PLAN_DEFAULT_ID, label: 'Plan default' },
      { id: 'openai-codex/gpt-6-astra', label: 'GPT-6-Astra' },
      { id: 'openai-codex/gpt-5.6-luna', label: 'GPT-5.6-Luna' },
    ])
    for (const m of group.models.slice(1)) {
      const exec = hermesModelExec(m.id)
      expect(exec).toEqual({ provider: 'openai-codex', model: m.id.slice('openai-codex/'.length) })
      expect(exec!.model).not.toContain('/') // bare backend id, prefix stripped
    }
  })

  it('with the live list unknown the group still offers the plan default, and names no model', () => {
    expect(hermesCodexGroup([]).models).toEqual([
      { id: HERMES_CODEX_PLAN_DEFAULT_ID, label: 'Plan default' },
    ])
    // The plan default pins the provider and leaves the model to Hermes.
    expect(hermesModelExec(HERMES_CODEX_PLAN_DEFAULT_ID)).toEqual({ provider: 'openai-codex' })
  })

  it('the subscription group is NOT in the static fallback (it is offered only when auth is detected)', () => {
    expect(HERMES_MODEL_GROUPS.some((g) => g.provider === HERMES_CODEX_GROUP_NAME)).toBe(false)
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
    // The plan default names no model, so there is nothing for the model route to save.
    expect(hermesModelSave(HERMES_CODEX_PLAN_DEFAULT_ID, true)).toBeNull()
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
