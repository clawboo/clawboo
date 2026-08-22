import { afterEach, describe, expect, it } from 'vitest'

import { getApiBase, resetControlClient, setApiBase } from '../index'

afterEach(() => {
  resetControlClient()
})

describe('setApiBase trailing-slash stripping', () => {
  it('leaves a slashless origin untouched', () => {
    setApiBase('https://host.example.com')
    expect(getApiBase()).toBe('https://host.example.com')
  })

  it('strips a whole run of trailing slashes, not just one', () => {
    setApiBase('https://host.example.com////')
    expect(getApiBase()).toBe('https://host.example.com')
  })

  it('keeps interior slashes and strips only the trailing run', () => {
    setApiBase('https://host.example.com/base/path///')
    expect(getApiBase()).toBe('https://host.example.com/base/path')
  })

  it('reduces an all-slash value (even a huge one) to the same-origin default', () => {
    setApiBase('/'.repeat(100_000))
    expect(getApiBase()).toBe('')
  })

  it('leaves the empty string as the same-origin default', () => {
    setApiBase('')
    expect(getApiBase()).toBe('')
  })
})
