// A screenshot has to survive the whole path or the tool is theatre: an agent
// that can take one and not look at it is worse off than one that cannot take
// one at all, because it believes it has seen the page.
//
// The two halves tested here are the two places the bytes used to die:
// `extractImages` (the connector client dropped everything but text) and
// `mediaResult` (the tools server flattened every result to a single text
// block, so even a carried image had no way onto the wire).

import { describe, expect, it } from 'vitest'

import { extractImages, flattenContent, MAX_IMAGES_PER_CALL, MAX_IMAGE_B64_BYTES } from '../client'
import { mediaResult, textResult } from '../../shared'

const png = (data = 'aGVsbG8=') => ({ type: 'image', data, mimeType: 'image/png' })

describe('extractImages', () => {
  it('keeps the bytes of an image block', () => {
    expect(extractImages([png()])).toEqual([{ data: 'aGVsbG8=', mimeType: 'image/png' }])
  })

  it('keeps images that arrive beside text', () => {
    const out = extractImages([{ type: 'text', text: 'Took a screenshot' }, png()])
    expect(out).toHaveLength(1)
  })

  it('leaves the text rendering alone — the placeholder is still the fallback', () => {
    // A consumer that cannot carry pixels must still learn a picture exists.
    expect(flattenContent([png()])).toContain('[image: image/png, not rendered]')
  })

  it('bounds how many images one call can return', () => {
    const many = Array.from({ length: MAX_IMAGES_PER_CALL + 3 }, () => png())
    expect(extractImages(many)).toHaveLength(MAX_IMAGES_PER_CALL)
  })

  it('drops an image too large to ride a context window', () => {
    // Truncating base64 would produce a corrupt image rather than a smaller
    // one, so the whole block goes and the placeholder text stands.
    expect(extractImages([png('a'.repeat(MAX_IMAGE_B64_BYTES + 1))])).toEqual([])
  })

  it('ignores malformed blocks rather than throwing', () => {
    const junk = [
      null,
      'nope',
      { type: 'image' },
      { type: 'image', data: 123, mimeType: 'image/png' },
      { type: 'image', data: 'ok', mimeType: 7 },
      { type: 'image', data: '', mimeType: 'image/png' },
      { type: 'audio', data: 'x', mimeType: 'audio/wav' },
    ]
    expect(extractImages(junk)).toEqual([])
    expect(extractImages(undefined)).toEqual([])
  })
})

describe('mediaResult', () => {
  it('puts text first and the images after it', () => {
    const r = mediaResult('saw the page', [{ data: 'aGk=', mimeType: 'image/png' }])
    expect(r.content[0]).toEqual({ type: 'text', text: 'saw the page' })
    expect(r.content[1]).toEqual({ type: 'image', data: 'aGk=', mimeType: 'image/png' })
  })

  it('is byte-identical to textResult when there are no images', () => {
    // Every builtin tool goes through this call. If the empty case changed
    // shape, this change would have altered the wire format for all of them.
    expect(mediaResult('hello', [])).toEqual(textResult('hello'))
    expect(mediaResult('bad', [], true, 'policy:denied')).toEqual(
      textResult('bad', true, 'policy:denied'),
    )
  })

  it('still carries a denial reason alongside images', () => {
    const r = mediaResult('x', [{ data: 'a', mimeType: 'image/png' }], true, 'policy:denied')
    expect(r._meta).toEqual({ denied: 'policy:denied' })
    expect(r.isError).toBe(true)
  })
})
