// The marker that turns "I would need Linear" into a button.

import { describe, expect, it } from 'vitest'

import { connectorAskBody, extractConnectorAsk, readConnectorAsk } from '../ask'

describe('extractConnectorAsk', () => {
  it('takes the slug and hides the marker from the reader', () => {
    const { body, slugs } = extractConnectorAsk(
      'I can do that once Linear is connected.\n\n[[connect:linear]]',
    )
    expect(slugs).toEqual(['linear'])
    expect(body).toBe('I can do that once Linear is connected.')
    expect(body).not.toContain('[[')
  })

  it('does NOT fire on prose that merely names a product', () => {
    // The reason this is a marker and not a scan. Any text search sensitive
    // enough to catch a real ask also fires on a sentence that mentions the
    // product, and a false connect prompt is worse than none.
    const { slugs, body } = extractConnectorAsk(
      'I read the Notion page you linked and the Linear issue it references.',
    )
    expect(slugs).toEqual([])
    expect(body).toContain('Notion page')
  })

  it('drops a slug the catalog does not have', () => {
    // A model will occasionally invent a plausible name, and a card offering to
    // connect something that does not exist is an affordance that cannot work.
    //
    // The fixture used to be `salesforce`, which stopped being a miss the day
    // the brokered apps landed. A real product name is the wrong shape for this
    // test: any of them can become a connector later and turn it green for a
    // reason that has nothing to do with what it checks.
    const { slugs } = extractConnectorAsk('[[connect:not-a-real-connector]] [[connect:linear]]')
    expect(slugs).toEqual(['linear'])
  })

  it('dedupes and keeps the order the agent named them', () => {
    const { slugs } = extractConnectorAsk(
      '[[connect:notion]]\n[[connect:linear]]\n[[connect:notion]]',
    )
    expect(slugs).toEqual(['notion', 'linear'])
  })

  it('leaves an ordinary reply exactly as it was', () => {
    const text = 'Done. I opened the PR and left a note on the issue.'
    expect(extractConnectorAsk(text)).toEqual({ body: text, slugs: [] })
  })

  it('accepts the capitalised form a model will sometimes emit', () => {
    expect(extractConnectorAsk('[[CONNECT:Linear]]').slugs).toEqual(['linear'])
  })
})

describe('the system line the panel reads', () => {
  it('round-trips the slugs', () => {
    const body = connectorAskBody(['linear', 'notion'])
    expect(readConnectorAsk(body)?.slugs).toEqual(['linear', 'notion'])
  })

  it('still reads as a sentence to a client that does not know the prefix', () => {
    // The failure mode to want: an older or third-party reader shows something
    // useful rather than a routing token.
    expect(connectorAskBody(['linear'])).toContain('Linear would let this agent do that')
    expect(connectorAskBody(['linear'])).toContain('Connectors tab')
  })

  it('returns null for an ordinary system line', () => {
    expect(readConnectorAsk('Task moved to done.')).toBeNull()
    expect(readConnectorAsk('')).toBeNull()
  })
})

describe('connectorAskBody prose', () => {
  it('joins three names with commas and a final "and", not "and and"', () => {
    const body = connectorAskBody(['linear', 'notion', 'figma'])
    expect(body).toContain('Linear, Notion, and Figma would each let this agent do that')
    expect(body).not.toContain('and Notion and')
  })

  it('joins exactly two with a bare "and"', () => {
    expect(connectorAskBody(['linear', 'notion'])).toContain('Linear and Notion would each')
  })
})

describe('extractConnectorAsk leaves ordinary replies alone', () => {
  it('returns a marker-free reply byte-identical, indentation and all', () => {
    // The regression: the whitespace cleanup ran unconditionally, so a reply
    // carrying an indented code block had its runs of spaces collapsed.
    const reply = 'Here is the fix:\n\n    if (x)  {\n        return  y\n    }\n'
    expect(extractConnectorAsk(reply).body).toBe(reply)
  })

  it('preserves indentation in a reply that DID carry a marker', () => {
    const reply = 'Use this:\n\n    const  a = 1\n\n[[connect:linear]]'
    const out = extractConnectorAsk(reply)
    expect(out.slugs).toEqual(['linear'])
    expect(out.body).toContain('    const  a = 1')
    expect(out.body).not.toContain('[[connect:')
  })
})
