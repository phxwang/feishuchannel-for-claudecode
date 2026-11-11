import { describe, expect, test } from 'bun:test'
import { buildHtml } from './pane-screenshot'

describe('buildHtml', () => {
  test('embeds the ANSI-converted text inside a <pre> block', () => {
    const html = buildHtml('plain text')
    expect(html).toContain('<pre>')
    expect(html).toContain('plain text')
    expect(html).toContain('</pre>')
  })

  test('converts SGR color codes to styled spans rather than leaving raw escape bytes', () => {
    const html = buildHtml('\x1b[36mhello\x1b[0m')
    expect(html).not.toContain('\x1b')
    expect(html).toContain('hello')
  })

  test('escapes HTML-significant characters in the pane text', () => {
    const html = buildHtml('<script>alert(1)</script>')
    expect(html).not.toContain('<script>alert(1)</script>')
  })

  test('sets a monospace font and dark background matching a terminal', () => {
    const html = buildHtml('x')
    expect(html).toContain('monospace')
    expect(html).toContain('#1e1e1e')
  })
})
