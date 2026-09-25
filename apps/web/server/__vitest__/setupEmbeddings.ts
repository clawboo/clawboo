// Embeddings are off for every server suite unless a suite opts back in.
//
// The shared embedding cache (server/lib/memoryEmbedding.ts) probes the real
// localhost:11434 and reads the real clawboo vault, and when it finds a working
// provider it starts a background backfill. Any suite that reaches it without
// pinning (anything that runs memory recall or attaches the Memory MCP) would
// then embed its fixtures through the developer's own Ollama or OpenAI key, in a
// task nothing awaits, against whatever database getDb() resolves to by then,
// which for a suite that never sandboxes HOME is their real one. CI has neither,
// so this also makes a dev box run the same branch CI does.
//
// Suites that test resolution itself delete this variable in their beforeEach
// and stub fetch (memoryEmbedding.test.ts).
process.env['CLAWBOO_DISABLE_EMBEDDINGS'] ??= '1'
