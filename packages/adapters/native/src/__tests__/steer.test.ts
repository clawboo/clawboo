// `steer()` puts a person's message in front of the run that is working now. The
// adapter declares how (`capabilities().steering`) and hands the message to the
// run's driver; it answers with what became of it and never throws.

import { describe, expect, it } from 'vitest'

import { NativeAdapter } from '../adapter'
import { FakeNativeDriver } from '../testing/fakeNativeDriver'

const SK = 'agent:a1:team:t1'

async function started(): Promise<{
  adapter: NativeAdapter
  driver: FakeNativeDriver
  run: Awaited<ReturnType<NativeAdapter['start']>>
}> {
  const driver = new FakeNativeDriver()
  const adapter = new NativeAdapter(() => driver)
  const run = await adapter.start({}, { agentId: 'a1', sessionKey: SK, message: 'go' })
  return { adapter, driver, run }
}

describe('NativeAdapter.steer', () => {
  it('declares live steering', () => {
    const adapter = new NativeAdapter(() => new FakeNativeDriver())
    expect(adapter.capabilities().steering).toBe('live')
  })

  it('hands the message to the run’s driver and reports it delivered', async () => {
    const { adapter, driver, run } = await started()
    await expect(adapter.steer(run, 'keep it short')).resolves.toEqual({
      delivered: true,
      mode: 'live',
    })
    expect(driver.calls).toContainEqual({ method: 'steer', params: { text: 'keep it short' } })
  })

  it('reports run-ended when the run had already finished', async () => {
    const { adapter, driver, run } = await started()
    driver.steerAnswer = false
    await expect(adapter.steer(run, 'too late')).resolves.toEqual({
      delivered: false,
      reason: 'run-ended',
    })
  })

  it('turns a refusal into a rejected result instead of throwing', async () => {
    const { adapter, driver, run } = await started()
    driver.steerAnswer = new Error('turn is not steerable')
    await expect(adapter.steer(run, 'x')).resolves.toEqual({
      delivered: false,
      reason: 'rejected',
      detail: 'turn is not steerable',
    })
  })

  it('reports no-run for a handle it never started', async () => {
    const adapter = new NativeAdapter(() => new FakeNativeDriver())
    const result = await adapter.steer(
      { adapterId: adapter.id, sessionKey: 'agent:x:main', runId: null },
      'x',
    )
    expect(result).toEqual({ delivered: false, reason: 'no-run' })
  })

  it('passes a passive steer (an ambient FYI) through to the driver as passive', async () => {
    const { adapter, driver, run } = await started()
    await adapter.steer(run, 'FYI', { passive: true })
    expect(driver.calls).toContainEqual({
      method: 'steer',
      params: { text: 'FYI', opts: { passive: true } },
    })
  })
})
