// Re-export shim. The shared model catalog now lives in @clawboo/model-catalog
// so the Express server can import it without reaching into SPA source (see the
// layer-boundary rules in eslint.config.mjs). This shim keeps every existing
// `@/lib/modelCatalog` / `./modelCatalog` import working unchanged.
export * from '@clawboo/model-catalog'
