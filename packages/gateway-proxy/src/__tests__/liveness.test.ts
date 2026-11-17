// The liveness probe's matcher, which the access gate and the server's identity
// lane both use to leave the probe open: exactly GET or HEAD /api/system/live,
// every reading of the path, no query.

import type { IncomingMessage } from 'node:http'

import { describe, expect, it } from 'vitest'

import { LIVENESS_PATH, isLivenessRequest } from '../liveness'

function req(url: string, method = 'GET', path?: string): IncomingMessage {
  return { url, method, headers: {}, ...(path !== undefined ? { path } : {}) } as IncomingMessage
}

describe('isLivenessRequest', () => {
  it('is the probe for GET and HEAD on its exact path', () => {
    expect(LIVENESS_PATH).toBe('/api/system/live')
    expect(isLivenessRequest(req('/api/system/live'))).toBe(true)
    expect(isLivenessRequest(req('/api/system/live', 'HEAD'))).toBe(true)
    expect(isLivenessRequest(req('/api/system/live', 'head'))).toBe(true)
    // An empty query is no query.
    expect(isLivenessRequest(req('/api/system/live?'))).toBe(true)
  })

  it('is not the probe for another method, a query, or another spelling', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      expect(isLivenessRequest(req('/api/system/live', method)), method).toBe(false)
    }
    for (const url of [
      '/api/system/live?x=1',
      '/api/system/live?=',
      '/api/system/live/',
      '/api/system/live/x',
      '/API/system/live',
      '/api/system/live/../hold',
      '/api/system/x/../live',
      '/api/system/./live',
      '/api/system/%6cive',
      '/api/system\\live',
      'http://other.example/api/system/live/x',
      '*',
    ]) {
      expect(isLivenessRequest(req(url)), url).toBe(false)
    }
  })

  it('takes the router reading into account: every reading must be the probe', () => {
    expect(isLivenessRequest(req('/api/system/live', 'GET', '/api/system/live'))).toBe(true)
    expect(isLivenessRequest(req('/api/system/live', 'GET', '/api/settings'))).toBe(false)
  })
})
