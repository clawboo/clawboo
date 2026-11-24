// The reader key's list, matched alone: every reading of the path must be the
// read's, and the query must be exactly its shape both as the URL says and as
// the route's handler reads it (Express's `req.query`).

import type { IncomingMessage } from 'node:http'

import { describe, expect, it } from 'vitest'

import { READER_EVENT_KINDS, READER_ROUTE_KEYS, readerMayRead } from '../readerRoutes'

function req(
  url: string,
  over: { method?: string; path?: string; query?: unknown; headers?: Record<string, string> } = {},
): IncomingMessage {
  return {
    url,
    method: over.method ?? 'GET',
    headers: over.headers ?? {},
    ...(over.path !== undefined ? { path: over.path } : {}),
    ...(over.query !== undefined ? { query: over.query } : {}),
  } as unknown as IncomingMessage
}

describe('readerMayRead', () => {
  it('lists the eight reads', () => {
    expect(READER_ROUTE_KEYS).toEqual([
      'GET /api/system/live',
      'GET /api/system/self-version',
      'GET /api/runtimes',
      'GET /api/teams',
      'GET /api/agents',
      'GET /api/tools/approvals',
      'GET /api/obs/stream',
      'GET /api/obs/events',
    ])
    expect(READER_EVENT_KINDS).toBe('approval_requested,approval_resolved')
  })

  it('takes GET and HEAD only', () => {
    expect(readerMayRead(req('/api/teams'))).toBe(true)
    expect(readerMayRead(req('/api/teams', { method: 'HEAD' }))).toBe(true)
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      expect(readerMayRead(req('/api/teams', { method })), method).toBe(false)
    }
  })

  it('takes the event stream with GET only, never HEAD', () => {
    const stream = `/api/obs/stream?kinds=${READER_EVENT_KINDS}&afterSeq=0`
    expect(readerMayRead(req(stream))).toBe(true)
    expect(readerMayRead(req(stream, { method: 'HEAD' }))).toBe(false)
    // The rest of the list still takes HEAD.
    expect(
      readerMayRead(req(`/api/obs/events?kinds=${READER_EVENT_KINDS}&limit=1`, { method: 'HEAD' })),
    ).toBe(true)
  })

  it('needs the router to read the same path', () => {
    expect(readerMayRead(req('/api/teams', { path: '/api/teams' }))).toBe(true)
    expect(readerMayRead(req('/api/teams', { path: '/api/settings' }))).toBe(false)
  })

  it("needs the handler's own reading of the query to be the shape too", () => {
    // The URL's query is right, but the handler would read another one.
    expect(readerMayRead(req('/api/teams', { query: {} }))).toBe(true)
    expect(readerMayRead(req('/api/teams', { query: { teamId: 'T' } }))).toBe(false)
    expect(
      readerMayRead(req('/api/tools/approvals?status=pending', { query: { status: ['pending'] } })),
    ).toBe(false)
    expect(
      readerMayRead(
        req(`/api/obs/events?kinds=${READER_EVENT_KINDS}&limit=1`, {
          query: { kinds: 'error', limit: '1' },
        }),
      ),
    ).toBe(false)
    expect(readerMayRead(req('/api/teams', { query: 'teamId=T' }))).toBe(false)
  })

  it('refuses a repeated key, and a key it does not know', () => {
    expect(readerMayRead(req('/api/system/self-version?local=1&local=1'))).toBe(false)
    expect(readerMayRead(req('/api/system/self-version?local=1&x='))).toBe(false)
  })
})
