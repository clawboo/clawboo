// An agent host served in this test process, joined to a real client by two
// in-memory pipes. Same protocol, same code on both ends; only the uid switch is
// missing, which the container test covers.

import { PassThrough } from 'node:stream'

import { serveConnection, type HostConnection } from '../../../agentHost/host'
import { AgentHostClient, type HostTransport } from '../client'

export interface InProcessHost {
  client: AgentHostClient
  host: HostConnection
  /** Frames the server sent, for tests that inspect them. */
  toHost: PassThrough
  /** Frames the host sent; tests may write forged ones here. */
  toServer: PassThrough
}

export function startInProcessHost(): InProcessHost {
  const toHost = new PassThrough()
  const toServer = new PassThrough()
  const host = serveConnection(toHost, toServer)
  const transport: HostTransport = {
    input: toServer,
    output: toHost,
    close: () => toHost.end(),
  }
  return { client: new AgentHostClient(transport), host, toHost, toServer }
}

/** A client whose "host" is whatever the test writes. */
export function startFakeHost(): {
  client: AgentHostClient
  toServer: PassThrough
  toHost: PassThrough
} {
  const toHost = new PassThrough()
  const toServer = new PassThrough()
  const client = new AgentHostClient({ input: toServer, output: toHost, close: () => toHost.end() })
  return { client, toServer, toHost }
}

/** Collect a readable stream to a string. */
export function collect(stream: NodeJS.ReadableStream | null): Promise<string> {
  return new Promise((resolve) => {
    if (!stream) return resolve('')
    let out = ''
    stream.on('data', (d: Buffer | string) => {
      out += d.toString()
    })
    stream.on('end', () => resolve(out))
  })
}

/** Wait for a process's 'close', returning its code and signal. */
export function closed(
  p: NodeJS.EventEmitter,
): Promise<{ code: number | null; signal: string | null }> {
  return new Promise((resolve) => {
    p.once('close', (code: number | null, signal: string | null) => resolve({ code, signal }))
  })
}
