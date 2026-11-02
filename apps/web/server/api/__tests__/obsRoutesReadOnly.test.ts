// The observability routes only read. Every event in the log is written by the
// server itself, so no HTTP route may add one: a write route would let any
// process that can reach the port put events in the log.

import { expect, it } from 'vitest'

import { apiRouter } from '../index'

interface RouteLayer {
  route?: { path: string; methods: Record<string, boolean> }
}

it('serves /api/obs/* with GET only', () => {
  const obsRoutes = (apiRouter.stack as RouteLayer[])
    .map((layer) => layer.route)
    .filter((route): route is NonNullable<RouteLayer['route']> =>
      Boolean(route?.path.startsWith('/api/obs/')),
    )
  expect(obsRoutes.length).toBeGreaterThan(0)
  for (const route of obsRoutes) {
    expect(Object.keys(route.methods), route.path).toEqual(['get'])
  }
})
