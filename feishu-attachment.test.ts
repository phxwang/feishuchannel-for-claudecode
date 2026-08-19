import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { sendFeishuFile } from './feishu-attachment'

let dir: string

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'feishu-attachment-test-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function fakeApiClient(overrides: Partial<{ image_key: string; file_key: string; message_id: string }> = {}) {
  const calls: { method: string; args: any }[] = []
  const client = {
    im: {
      image: { create: async (args: any) => { calls.push({ method: 'image.create', args }); return { image_key: overrides.image_key ?? 'img_1' } } },
      file: { create: async (args: any) => { calls.push({ method: 'file.create', args }); return { file_key: overrides.file_key ?? 'file_1' } } },
      message: { create: async (args: any) => { calls.push({ method: 'message.create', args }); return { message_id: overrides.message_id ?? 'msg_1' } } },
    },
  }
  return { client, calls }
}

describe('sendFeishuFile', () => {
  test('uploads a .png as an image message', async () => {
    const fp = join(dir, 'shot.png')
    writeFileSync(fp, 'fake png bytes')
    const { client, calls } = fakeApiClient()
    const id = await sendFeishuFile(client, 'chat_1', fp)
    expect(id).toBe('msg_1')
    expect(calls[0].method).toBe('image.create')
    expect(calls[1].method).toBe('message.create')
    expect(JSON.parse(calls[1].args.data.content)).toEqual({ image_key: 'img_1' })
    expect(calls[1].args.data.msg_type).toBe('image')
  })

  test('uploads a non-image extension as a file message, using its own basename', async () => {
    const fp = join(dir, 'report.pdf')
    writeFileSync(fp, 'fake pdf bytes')
    const { client, calls } = fakeApiClient()
    await sendFeishuFile(client, 'chat_1', fp)
    expect(calls[0].method).toBe('file.create')
    expect(calls[0].args.data.file_type).toBe('pdf')
    expect(calls[0].args.data.file_name).toBe('report.pdf')
    expect(JSON.parse(calls[1].args.data.content)).toEqual({ file_key: 'file_1' })
    expect(calls[1].args.data.msg_type).toBe('file')
  })

  test('unrecognized extensions upload as a generic stream file', async () => {
    const fp = join(dir, 'data.bin')
    writeFileSync(fp, 'fake bytes')
    const { client, calls } = fakeApiClient()
    await sendFeishuFile(client, 'chat_1', fp)
    expect(calls[0].args.data.file_type).toBe('stream')
  })

  test('displayName overrides the file name Feishu shows', async () => {
    const fp = join(dir, 'oc-attach-12345.png')
    writeFileSync(fp, 'fake bytes')
    const { client, calls } = fakeApiClient()
    await sendFeishuFile(client, 'chat_1', fp, 'screenshot.png')
    // .png routes through image.create, which has no file_name field — use a
    // non-image extension to actually observe the override.
    expect(calls[0].method).toBe('image.create')

    const fp2 = join(dir, 'oc-attach-67890.pdf')
    writeFileSync(fp2, 'fake bytes')
    const { client: client2, calls: calls2 } = fakeApiClient()
    await sendFeishuFile(client2, 'chat_1', fp2, 'report.pdf')
    expect(calls2[0].args.data.file_name).toBe('report.pdf')
  })

  test('throws if the image upload response has no image_key', async () => {
    const fp = join(dir, 'shot.png')
    writeFileSync(fp, 'fake bytes')
    const { client } = fakeApiClient({ image_key: '' })
    await expect(sendFeishuFile(client, 'chat_1', fp)).rejects.toThrow('image upload failed')
  })

  test('throws if the file upload response has no file_key', async () => {
    const fp = join(dir, 'report.pdf')
    writeFileSync(fp, 'fake bytes')
    const { client } = fakeApiClient({ file_key: '' })
    await expect(sendFeishuFile(client, 'chat_1', fp)).rejects.toThrow('file upload failed')
  })
})
