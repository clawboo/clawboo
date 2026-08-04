// @clawboo/model-catalog — the shared OpenClaw model catalog: the static
// provider/model groups plus the pure helpers that read them.
//
// Imported by BOTH the browser SPA (the model pickers + onboarding) and the
// Express server (`/api/system/models`, which canonicalizes the live CLI's
// lowercase provider ids against this catalog's casing). It lives in a package
// rather than in `apps/web/src` precisely so the server never has to reach into
// SPA source — see the layer-boundary rules in `eslint.config.mjs`.
//
// Pure and browser-safe: static data plus string transforms, zero dependencies.

export {
  MODEL_GROUPS,
  findModelLabel,
  findProviderForModel,
  formatProviderName,
  providerSlug,
} from './catalog'

export type { ModelGroup, ModelOption } from './catalog'
