// What the adapter declares follows the transport its runs use: over ACP Hermes
// streams and takes a steer mid-turn; on the quiet path it does neither.

import { describe, expect, it } from 'vitest'

import { runAdapterContract, type AdapterTestHarness } from '@clawboo/executor/contract'

import { HermesAdapter } from '../adapter'
import { FakeHermesDriver } from '../testing/fakeHermesDriver'
import type { HermesNativeEvent, HermesTransport } from '../types'

const SK = 'agent:a1:team:t1'

const adapterOn = (transport: HermesTransport, driver = new FakeHermesDriver()) =>
  new HermesAdapter(
    () => driver,
    async () => ({ ok: true }),
    { transport: () => transport },
  )

describe('HermesAdapter transports', () => {
  it('over ACP: streaming, with live steering', () => {
    expect(adapterOn('acp').capabilities()).toMatchObject({ streaming: true, steering: 'live' })
  })

  it('quiet, or with no transport given: no streaming, interrupt-resume steering', () => {
    expect(adapterOn('quiet').capabilities()).toMatchObject({
      streaming: false,
      steering: 'interrupt-resume',
    })
    expect(new HermesAdapter(() => new FakeHermesDriver()).capabilities()).toMatchObject({
      streaming: false,
      steering: 'interrupt-resume',
    })
  })

  it('reads the transport on every call, so a fallback shows at once', () => {
    let transport: HermesTransport = 'acp'
    const adapter = new HermesAdapter(
      () => new FakeHermesDriver(),
      async () => ({ ok: true }),
      { transport: () => transport },
    )
    expect(adapter.capabilities().steering).toBe('live')
    transport = 'quiet'
    expect(adapter.capabilities().steering).toBe('interrupt-resume')
  })

  it('over ACP, passes an FYI steer to the run instead of refusing it', async () => {
    const driver = new FakeHermesDriver()
    const adapter = adapterOn('acp', driver)
    const run = await adapter.start({}, { agentId: 'a1', sessionKey: SK, message: 'go' })
    await expect(adapter.steer(run, 'fyi', { passive: true })).resolves.toEqual({
      delivered: true,
      mode: 'live',
    })
    // The quiet path stops a run to take a steer, never worth it for an FYI.
    const quiet = adapterOn('quiet', new FakeHermesDriver())
    const quietRun = await quiet.start({}, { agentId: 'a1', sessionKey: SK, message: 'go' })
    await expect(quiet.steer(quietRun, 'fyi', { passive: true })).resolves.toEqual({
      delivered: false,
      reason: 'unsupported',
    })
  })
})

// The shared adapter contract holds on the ACP transport too.
function acpHarness(): AdapterTestHarness {
  let driver = new FakeHermesDriver()
  return {
    label: 'hermes-acp',
    makeAdapter() {
      driver = new FakeHermesDriver()
      return adapterOn('acp', driver)
    },
    start(adapter) {
      return adapter.start({}, { agentId: 'a1', sessionKey: SK, message: 'hi' })
    },
    emit(frame) {
      driver.emit(frame as HermesNativeEvent)
    },
    frames: {
      delta: (text) => ({ type: 'message', text }),
      toolCall: (name, input) => ({ type: 'tool-call', id: 'tc-1', name, input }),
      final: (summary) => ({ type: 'result', ok: true, summary }),
      aborted: () => ({ type: 'result', ok: false, aborted: true, summary: '' }),
      error: (message) => ({ type: 'result', ok: false, errorMessage: message, summary: '' }),
    },
    recordedCalls() {
      return driver.calls
    },
  }
}

runAdapterContract(acpHarness())
