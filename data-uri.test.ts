import { describe, expect, test } from 'bun:test'
import { decodeBase64DataUri } from './data-uri'

describe('decodeBase64DataUri', () => {
  test('decodes a base64 data URI', () => {
    const r = decodeBase64DataUri('data:image/png;base64,aGVsbG8=')
    expect(r.ok && r.buf.toString('utf8')).toBe('hello')
  })

  test('decodes when the mime type is absent', () => {
    const r = decodeBase64DataUri('data:;base64,aGVsbG8=')
    expect(r.ok && r.buf.toString('utf8')).toBe('hello')
  })

  test('decodes when extra params precede the base64 marker', () => {
    const r = decodeBase64DataUri('data:image/png;name=shot.png;base64,aGVsbG8=')
    expect(r.ok && r.buf.toString('utf8')).toBe('hello')
  })

  test('rejects a plain-text (non-base64) data URI', () => {
    expect(decodeBase64DataUri('data:text/plain,Hello%20World')).toEqual({ ok: false, reason: 'not_base64' })
  })

  test('rejects a non-data URI', () => {
    expect(decodeBase64DataUri('https://example.com/x.png')).toEqual({ ok: false, reason: 'not_base64' })
  })

  test('rejects an empty string', () => {
    expect(decodeBase64DataUri('')).toEqual({ ok: false, reason: 'not_base64' })
  })

  test('accepts data within maxBytes', () => {
    const r = decodeBase64DataUri('data:image/png;base64,aGVsbG8=', 5)
    expect(r.ok && r.buf.toString('utf8')).toBe('hello')
  })

  test('rejects data over maxBytes without decoding it', () => {
    expect(decodeBase64DataUri('data:image/png;base64,aGVsbG8=', 4)).toEqual({ ok: false, reason: 'too_large' })
  })
})
