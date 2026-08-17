import { describe, expect, test } from 'bun:test'
import { SSEBuffer } from './sse'

describe('SSEBuffer', () => {
  test('parses a single complete event', () => {
    const b = new SSEBuffer()
    const events = b.push('data: {"type":"ping"}\n\n')
    expect(events).toEqual([{ type: 'ping' }])
  })

  test('buffers a partial event across pushes', () => {
    const b = new SSEBuffer()
    expect(b.push('data: {"type":"pi')).toEqual([])
    expect(b.push('ng"}\n\n')).toEqual([{ type: 'ping' }])
  })

  test('parses multiple events delivered in one chunk', () => {
    const b = new SSEBuffer()
    const events = b.push('data: {"type":"a"}\n\ndata: {"type":"b"}\n\n')
    expect(events).toEqual([{ type: 'a' }, { type: 'b' }])
  })

  test('ignores event:/id: lines, keeps the data: payload', () => {
    const b = new SSEBuffer()
    const events = b.push('event: message\nid: 1\ndata: {"type":"a"}\n\n')
    expect(events).toEqual([{ type: 'a' }])
  })

  test('drops a malformed event rather than throwing', () => {
    const b = new SSEBuffer()
    const events = b.push('data: {not json}\n\ndata: {"type":"ok"}\n\n')
    expect(events).toEqual([{ type: 'ok' }])
  })

  test('block with no data: line produces no event', () => {
    const b = new SSEBuffer()
    expect(b.push(': keepalive\n\n')).toEqual([])
  })
})
