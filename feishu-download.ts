/** Download a file/image resource attached to a Feishu message. Shared between
 *  server.ts (the `download_attachment` tool, called on demand by Claude) and
 *  router.ts (claude-tmux mode, which has no MCP channel plugin loaded to call
 *  that tool, so it must download attachments itself before injecting them). */
import { mkdirSync, writeFileSync } from 'fs'
import { extname, join } from 'path'

/** Download `fileKey` from `messageId` and write it under `outDir`. Returns the local path. */
export async function downloadFeishuResource(
  apiClient: any, outDir: string, messageId: string, fileKey: string, type: 'file' | 'image', fileName: string,
): Promise<string> {
  const ext = type === 'image' ? '.png' : extname(fileName) || '.bin'
  const base = fileName.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/\.[^.]*$/, '').slice(0, 60)
  const outPath = join(outDir, `${Date.now()}-${base}${ext}`)
  mkdirSync(outDir, { recursive: true })
  const raw = await apiClient.im.messageResource.get({ path: { message_id: messageId, file_key: fileKey }, params: { type } })
  let buf: Buffer
  const data = raw?.data ?? raw
  if (Buffer.isBuffer(data)) buf = data
  else if (data instanceof ArrayBuffer) buf = Buffer.from(data)
  else if (data && typeof data.arrayBuffer === 'function') buf = Buffer.from(await data.arrayBuffer())
  else if (data && typeof data.pipe === 'function') buf = await new Promise<Buffer>((res, rej) => { const c: Buffer[] = []; data.on('data', (d: Buffer) => c.push(d)); data.on('end', () => res(Buffer.concat(c))); data.on('error', rej) })
  else if (data && typeof data.getReadableStream === 'function') {
    const stream = await data.getReadableStream()
    buf = await new Promise<Buffer>((res, rej) => { const c: Buffer[] = []; stream.on('data', (d: Buffer) => c.push(d)); stream.on('end', () => res(Buffer.concat(c))); stream.on('error', rej) })
  }
  else throw new Error(`unexpected download response type: ${typeof raw}, keys: ${raw ? Object.keys(raw).join(',') : 'null'}`)
  writeFileSync(outPath, buf)
  return outPath
}
