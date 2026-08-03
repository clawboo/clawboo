// The Claude Agent SDK is a DOCUMENTED OPTIONAL dependency: the published
// `clawboo` tarball does not ship it (its per-platform optional dependency is a
// ~210 MB `claude` binary), so a packaged install hits the resolver error first.
// `isAgentSdkMissing` decides whether that error becomes the "install it
// alongside clawboo" remediation — it must fire for our specifier and stay
// quiet for everything else, so an unrelated failure is never mislabeled.

import { describe, expect, it } from 'vitest'

import { isAgentSdkMissing } from '../claudeCodeDriver'

function resolverError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

describe('isAgentSdkMissing', () => {
  it('recognizes the ESM resolver miss for the agent SDK', () => {
    expect(
      isAgentSdkMissing(
        resolverError(
          'ERR_MODULE_NOT_FOUND',
          "Cannot find package '@anthropic-ai/claude-agent-sdk' imported from /app/dist/server.js",
        ),
      ),
    ).toBe(true)
  })

  it('recognizes the CJS resolver miss for the agent SDK', () => {
    expect(
      isAgentSdkMissing(
        resolverError('MODULE_NOT_FOUND', "Cannot find module '@anthropic-ai/claude-agent-sdk'"),
      ),
    ).toBe(true)
  })

  it('does not claim a DIFFERENT missing module is the agent SDK', () => {
    expect(
      isAgentSdkMissing(
        resolverError('ERR_MODULE_NOT_FOUND', "Cannot find package 'some-transitive-dep'"),
      ),
    ).toBe(false)
  })

  it('does not treat a non-resolver failure as a missing SDK', () => {
    expect(
      isAgentSdkMissing(resolverError('ERR_INVALID_ARG_TYPE', '@anthropic-ai/claude-agent-sdk')),
    ).toBe(false)
    expect(isAgentSdkMissing(new Error('@anthropic-ai/claude-agent-sdk blew up at runtime'))).toBe(
      false,
    )
    expect(isAgentSdkMissing(null)).toBe(false)
    expect(isAgentSdkMissing('@anthropic-ai/claude-agent-sdk')).toBe(false)
  })
})
