// Detecting a tool call that failed while reporting HTTP success.

import { describe, expect, it } from 'vitest'

import { brokeredFailureMessage } from '../brokeredFailure'

describe('brokeredFailureMessage', () => {
  it('reads the specific remedy out of a batch envelope, not the summary', () => {
    // The exact payload from a real install. The top-level error says "1 out of 1
    // tools failed", which tells nobody anything; the per-result entry names the
    // fix, and withholding it left the model guessing arguments five times.
    const payload = JSON.stringify({
      data: {
        results: [
          {
            error:
              'Multiple gmail accounts connected. Specify which to use via the \'account\' field:\n- "gmail_awee-gimmer"',
            tool_slug: 'GMAIL_FETCH_EMAILS',
          },
        ],
        error_count: 1,
      },
      error: '1 out of 1 tools failed',
      successful: false,
    })
    const msg = brokeredFailureMessage(payload)
    expect(msg).toContain('Multiple gmail accounts connected')
    expect(msg).not.toBe('1 out of 1 tools failed')
  })

  it('accepts a bare top-level error when there is no per-result detail', () => {
    expect(brokeredFailureMessage('{"error":"rate limited","successful":false}')).toBe(
      'rate limited',
    )
  })

  it('treats successful:false as a failure even with no message', () => {
    expect(brokeredFailureMessage('{"successful":false}')).toContain('did not succeed')
  })

  it('leaves a SUCCESSFUL result completely alone', () => {
    // A false positive turns a working tool into a broken one, which is worse
    // than the silence this replaces.
    expect(brokeredFailureMessage('{"data":{"messages":[]},"successful":true}')).toBeNull()
    expect(brokeredFailureMessage('{"error":null,"successful":true}')).toBeNull()
    expect(brokeredFailureMessage('{"error":"","successful":true}')).toBeNull()
  })

  it('ignores anything that merely mentions an error', () => {
    expect(brokeredFailureMessage('Fetched 3 emails, one titled "error budget review"')).toBeNull()
    expect(brokeredFailureMessage('{"messages":[{"subject":"Re: production error"}]}')).toBeNull()
  })

  it('ignores non-JSON and malformed JSON', () => {
    expect(brokeredFailureMessage('plain text result')).toBeNull()
    expect(brokeredFailureMessage('{"truncated": ')).toBeNull()
    expect(brokeredFailureMessage('[1,2,3]')).toBeNull()
    expect(brokeredFailureMessage('')).toBeNull()
  })
})
