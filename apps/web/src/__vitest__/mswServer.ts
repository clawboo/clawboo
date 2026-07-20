// Shared msw (Mock Service Worker) request-mock server for the jsdom component
// tests. One server instance is reused across all `.test.tsx` files: the setup
// file wires its lifecycle (`listen`/`resetHandlers`/`close`) and each test
// registers its own `/api/*` handlers via `server.use(http.get(...))`.
//
// `listen({ onUnhandledRequest: 'error' })` is load-bearing: any `/api/*` call a
// component makes WITHOUT a matching handler fails the test loudly. That turns
// "a flag-off panel makes zero fetches" into a guarantee the component test
// itself encodes — not just something the e2e proves.

import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'

// Default handlers persist across resetHandlers(). The GitHub star count is the
// one cross-origin call the panels make on mount (GitHubStarButton lives in many
// headers); handling it here means panel tests never hit the real network and
// onUnhandledRequest:'error' can stay strict for same-origin /api/* calls.
//
// `/api/tools/approvals` is the one same-origin exception: it's a ubiquitous 3s
// background poll now that the Board's "Needs approval" column + the in-chat tray
// (+ the Governance queue) all render it, so any test that mounts the board or a
// chat would otherwise trip onUnhandledRequest into a flaky unhandled request. A
// benign empty default keeps it silent; a test that asserts on approvals overrides
// it with its own `server.use(http.get('/api/tools/approvals', ...))`.
// `/api/runtimes/openrouter/models` is the other same-origin default: the native
// model pickers (onboarding ConfigureNativeStep, CreateTeamModal, agent-detail
// MiniGraph) fetch the live OpenRouter list on mount, so any test mounting one of
// them would otherwise trip onUnhandledRequest. A benign empty default keeps it
// silent (the components fall back to the small hardcoded list).
export const server = setupServer(
  http.get('https://api.github.com/repos/clawboo/clawboo', () =>
    HttpResponse.json({ stargazers_count: 0 }),
  ),
  http.get('/api/tools/approvals', () => HttpResponse.json({ ok: true, approvals: [] })),
  // ConfigureNativeStep probes the Codex sign-in (Sign in with ChatGPT is the
  // DEFAULT method on the OpenAI card, so merely selecting OpenAI fires this).
  // Empty default = "codex not installed"; ChatGPT-path tests override it.
  http.get('/api/runtimes', () => HttpResponse.json({ runtimes: [] })),
  http.get('/api/runtimes/openrouter/models', () => HttpResponse.json({ models: [] })),
  http.get('/api/providers', () => HttpResponse.json({ providers: [] })),
  // The native model pickers also fetch each provider's LIVE model list (Anthropic /
  // OpenAI via the stored/typed key); the onboarding step POSTs a typed key. Benign
  // empty defaults keep the components on their static fallback list.
  http.get('/api/providers/:id/models', () => HttpResponse.json({ models: [] })),
  http.post('/api/providers/:id/models', () => HttpResponse.json({ models: [] })),
  // ConfigureNativeStep records the chosen leader model (fire-and-forget) on connect.
  http.post('/api/onboarding/native-leader-model', () => HttpResponse.json({ ok: true })),
  http.get('/api/onboarding/native-leader-model', () =>
    HttpResponse.json({ provider: null, model: null }),
  ),
  // The OpenClaw "reachable server-side" signal — CreateTeamModal + the Runtimes panel
  // read registry health so OpenClaw is offered in thin-client mode (browser client null,
  // server operator connection live). A benign disconnected default; a test that needs
  // it connected overrides with its own `server.use(...)`.
  http.get('/api/agents/registry/health', () =>
    HttpResponse.json({ ok: false, connection: 'disconnected', lastSyncedAt: null }),
  ),
  // The OpenClaw runtime row's Manage body now hosts the Gateway process controls
  // (OpenClawGatewaySection → /api/system/status) + the OpenClaw default-model
  // picker (OpenClawDefaultModel → /api/system/openclaw-config), so any test that
  // renders the connected OpenClaw Manage would otherwise trip onUnhandledRequest.
  // Benign defaults (gateway stopped, empty config); a test that asserts on them
  // overrides with its own `server.use(...)`.
  http.get('/api/system/status', () =>
    HttpResponse.json({
      node: { version: 'v22.0.0', major: 22, sufficient: true, path: '' },
      openclaw: {
        installed: false,
        version: null,
        path: null,
        stateDir: '',
        configExists: false,
        envExists: false,
      },
      gateway: { running: false, port: 18789, pid: null, managedByClawboo: false, uptimeMs: null },
    }),
  ),
  // `config: null` is the realistic "OpenClaw not configured" shape (the server
  // returns readOpenclawJson() = null when openclaw.json is absent). Load-bearing:
  // an empty `{}` reads as truthy and would flip RuntimesPanel's `!!cfg.config`
  // "configured" signal to true ("Reconnect" instead of "Set up"). A test that
  // needs a configured OpenClaw overrides with its own `server.use(...)`.
  http.get('/api/system/openclaw-config', () =>
    HttpResponse.json({ config: null, env: {}, version: null }),
  ),
  // The OpenClaw default-model picker (OpenClawDefaultModel → ModelSelector →
  // useModelCatalog) fetches the live OpenClaw model catalog. Empty groups keep
  // the picker on its static fallback list.
  http.get('/api/system/models', () => HttpResponse.json({ groups: [], configuredProviders: [] })),
)
