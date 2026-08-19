/** Upload a local file to Feishu and send it as an image or file message. Shared
 *  between server.ts (Claude's `reply` tool, attachments the model chose to send)
 *  and router.ts (OpenCode tool-generated attachments, e.g. screenshots). */
import { createReadStream } from 'fs'
import { basename, extname } from 'path'

export const MAX_ATTACHMENT_BYTES = 30 * 1024 * 1024

export const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'])
export const FEISHU_FTYPES: Record<string, string> = {
  '.pdf': 'pdf', '.doc': 'doc', '.docx': 'doc', '.xls': 'xls', '.xlsx': 'xls',
  '.ppt': 'ppt', '.pptx': 'ppt', '.mp4': 'mp4', '.opus': 'opus',
}

/** Upload `filePath` and send it as an image/file message to `chatId`. `displayName`
 *  overrides the file name Feishu shows (defaults to filePath's own basename) —
 *  useful when filePath is a temp file whose name isn't meant to be user-facing.
 *  Returns the sent message's id, if Feishu returned one. */
export async function sendFeishuFile(apiClient: any, chatId: string, filePath: string, displayName?: string): Promise<string> {
  const ext = extname(filePath).toLowerCase()
  let r: any, msgType: string, content: Record<string, string>
  if (IMAGE_EXTS.has(ext)) {
    r = await apiClient.im.image.create({ data: { image_type: 'message', image: createReadStream(filePath) } })
    const key = r?.image_key ?? r?.data?.image_key
    if (!key) throw new Error(`image upload failed: ${filePath}`)
    msgType = 'image'; content = { image_key: key }
  } else {
    r = await apiClient.im.file.create({ data: { file_type: FEISHU_FTYPES[ext] ?? 'stream', file_name: displayName ?? basename(filePath), file: createReadStream(filePath) } })
    const key = r?.file_key ?? r?.data?.file_key
    if (!key) throw new Error(`file upload failed: ${filePath}`)
    msgType = 'file'; content = { file_key: key }
  }
  const r2 = await apiClient.im.message.create({ params: { receive_id_type: 'chat_id' }, data: { receive_id: chatId, msg_type: msgType, content: JSON.stringify(content) } })
  return r2?.message_id ?? r2?.data?.message_id ?? ''
}
