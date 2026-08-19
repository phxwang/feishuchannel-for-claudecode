import { describe, expect, test } from 'bun:test'
import { decodeBase64DataUri } from './data-uri'

describe('decodeBase64DataUri', () => {
  test('decodes a base64 data URI', () => {
    const buf = decodeBase64DataUri('data:image/png;base64,aGVsbG8=')
    expect(buf?.toString('utf8')).toBe('hello')
  })

  test('decodes when the mime type is absent', () => {
    const buf = decodeBase64DataUri('data:;base64,aGVsbG8=')
    expect(buf?.toString('utf8')).toBe('hello')
  })

  test('returns null for a plain-text (non-base64) data URI', () => {
    expect(decodeBase64DataUri('data:text/plain,Hello%20World')).toBeNull()
  })

  test('returns null for a non-data URI', () => {
    expect(decodeBase64DataUri('https://example.com/x.png')).toBeNull()
  })

  test('returns null for an empty string', () => {
    expect(decodeBase64DataUri('')).toBeNull()
  })
})
