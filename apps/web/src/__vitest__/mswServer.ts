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
export const server = setupServer(
  http.get('https://api.github.com/repos/clawboo/clawboo', () =>
    HttpResponse.json({ stargazers_count: 0 }),
  ),
)
