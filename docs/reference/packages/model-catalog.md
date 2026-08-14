---
title: '@clawboo/model-catalog'
description: 'The shared OpenClaw model catalog: static provider/model groups plus the provider-name normalization both the browser SPA and the Express server read.'
---

- **Version** `0.1.0`
- **Purity** pure zero-dep (browser-safe; no workspace or external deps, no `node:*`)
- **Purpose** Hold the static OpenClaw provider/model catalog and the pure helpers that read it, in one place both `apps/web/src` (the model pickers) and `apps/web/server` (the `/api/system/models` route) can import.
- **Workspace deps** none
- **External deps** none

Model ids use the OpenClaw **routing** shape, `provider/model-id`, because OpenClaw splits on the first `/`. That is deliberately distinct from the native harness's catalog (`apps/web/src/lib/nativeModelCatalog.ts`), which uses provider-native ids because it passes the model straight to a provider SDK.

This package exists to keep a layer boundary honest. The catalog previously lived at `apps/web/src/lib/modelCatalog.ts` and the Express server reached into SPA source to read it, the only such import in the tree. Extracting it means the server imports a package like any other, and the `no-restricted-imports` boundary rules in `eslint.config.mjs` can forbid `apps/web/server` from importing `apps/web/src` outright. `apps/web/src/lib/modelCatalog.ts` remains as a one-line re-export shim so the existing SPA call sites are unchanged.

## Public API

### Functions

| Signature                                          | Contract                                                                                                                                                                                                                                   |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `providerSlug(name: string): string`               | The ONE comparison key for provider identity: lowercase, then strip every non-alphanumeric character. Makes display names (`'Hugging Face'`, `'OpenAI Codex'`) and live CLI ids (`'huggingface'`, `'openai-codex'`) land on the same key.  |
| `findModelLabel(id: string): string \| null`       | Look up a model's display label by its routing id. Returns `null` for a model not in the catalog.                                                                                                                                          |
| `findProviderForModel(id: string): string \| null` | Find the provider group that owns a model id. Falls back to the id's prefix before the first `/` for unknown models, and returns `null` when there is no prefix.                                                                           |
| `formatProviderName(provider: string): string`     | Normalize a provider name to the catalog's canonical display casing, matched through `providerSlug`. Unknown providers are title-cased with all-caps tokens (`AI`) left intact, so a dropdown never mixes bare-lowercase and display-case. |

### Types & interfaces

| Name          | Shape / contract                                                                                          |
| ------------- | --------------------------------------------------------------------------------------------------------- |
| `ModelOption` | `{ id: string; label: string }`, one selectable model. `id` is the OpenClaw routing id.                   |
| `ModelGroup`  | `{ provider: string; models: ModelOption[] }`, one provider's group. `provider` is the display-case name. |

### Classes

None; this package exports only functions, types, and constants.

### Constants

| Name           | Value / contract                                                                                                                                                                                                                                                                                      |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MODEL_GROUPS` | `ModelGroup[]`, the static catalog: 22 provider groups covering 76 models, from hosted APIs (Anthropic, OpenAI, Google, OpenRouter) through the keyless `openai-codex` ChatGPT-subscription provider to local runners (Ollama, vLLM, SGLang). The single source of truth for provider display casing. |

<Info>
The catalog is the source of truth for **casing**, not for availability. The live `/api/system/models` groups come from the OpenClaw CLI, which emits lowercase provider ids; the server canonicalizes those against `MODEL_GROUPS` through `providerSlug` and only falls back to the static catalog when the CLI is unavailable. Comparing with a bare `.toLowerCase()` instead of `providerSlug` mismatches on spaces and hyphens, which is what silently dropped Hugging Face before the slug was extracted.
</Info>

## Used by

- **`apps/web` (server)**; `api/system.ts` builds its canonical-name map from `MODEL_GROUPS` keyed by `providerSlug`, rewrites each live CLI group onto the catalog's casing, supplements missing known providers from the catalog, and serves the full filtered catalog when the CLI is unavailable.
- **`apps/web` (SPA)**; the model pickers and onboarding read it through the `@/lib/modelCatalog` shim: `features/teams/CreateTeamModal.tsx`, `features/teams/MemberModelSelect.tsx`, `features/onboarding/steps/ConfigureStep.tsx`, `features/agent-detail/AgentModelSelector.tsx`, `features/maintenance/ModelSelector.tsx`, plus the `lib/useModelCatalog.ts` / `lib/useProviderModels.ts` / `lib/useOpenRouterModels.ts` hooks and `lib/modelProvider.ts`.

## Source

Barrel: [`packages/model-catalog/src/index.ts`](https://github.com/clawboo/clawboo/blob/main/packages/model-catalog/src/index.ts) (re-exports `./catalog`).

## See also

- [Monorepo & build](/internals/monorepo-and-build), the layer boundaries this package exists to keep
- [System REST API](/reference/rest-api/system), the `/api/system/models` route that reads the catalog
- [Package overview](/reference/packages/index)
