import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { downloadFeishuResource } from './feishu-download'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'feishu-download-test-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function fakeClient(data: unknown) {
  return { im: { messageResource: { get: async () => data } } }
}

describe('downloadFeishuResource', () => {
  test('writes a raw Buffer response to disk', async () => {
    const client = fakeClient(Buffer.from('hello buffer'))
    const path = await downloadFeishuResource(client, dir, 'msg_1', 'key_1', 'file', 'note.txt')
    expect(readFileSync(path, 'utf8')).toBe('hello buffer')
  })

  test('handles a {data: Buffer} wrapper', async () => {
    const client = fakeClient({ data: Buffer.from('wrapped') })
    const path = await downloadFeishuResource(client, dir, 'msg_1', 'key_1', 'file', 'note.txt')
    expect(readFileSync(path, 'utf8')).toBe('wrapped')
  })

  test('handles an ArrayBuffer response', async () => {
    const buf = new TextEncoder().encode('array buffer bytes').buffer
    const client = fakeClient(buf)
    const path = await downloadFeishuResource(client, dir, 'msg_1', 'key_1', 'file', 'note.txt')
    expect(readFileSync(path, 'utf8')).toBe('array buffer bytes')
  })

  test('image type always writes a .png regardless of fileName extension', async () => {
    const client = fakeClient(Buffer.from('png bytes'))
    const path = await downloadFeishuResource(client, dir, 'msg_1', 'key_1', 'image', 'whatever.jpg')
    expect(path.endsWith('.png')).toBe(true)
  })

  test('file type keeps the extension from fileName', async () => {
    const client = fakeClient(Buffer.from('pdf bytes'))
    const path = await downloadFeishuResource(client, dir, 'msg_1', 'key_1', 'file', 'report.pdf')
    expect(path.endsWith('.pdf')).toBe(true)
  })

  test('throws on an unrecognized response shape', async () => {
    const client = fakeClient({ unexpected: true })
    await expect(downloadFeishuResource(client, dir, 'msg_1', 'key_1', 'file', 'note.txt')).rejects.toThrow('unexpected download response type')
  })
})
