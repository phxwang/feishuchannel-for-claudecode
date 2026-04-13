#!/usr/bin/env bun
/**
 * Feishu Router — central message hub for multiple Claude Code instances.
 *
 * Maintains the single Feishu WebSocket connection. Workers (server.ts in each
 * Claude Code instance) connect via a Unix socket and register their cwd.
 * Messages are routed by:  chat_id → workdir (access.json) → registered worker.
 *
 * Usage:  bun router.ts
 * Config: ~/.claude/channels/feishu/access.json  (groups.<chatId>.workdir, defaultWorkdir)
 */
import * as lark from '@larksuiteoapi/node-sdk'
import { createServer, type Socket } from 'net'
import {
  readFileSync, appendFileSync, mkdirSync, chmodSync, unlinkSync, existsSync,
} from 'fs'
import { homedir } from 'os'
import { join, resolve } from 'path'

// ── Config ──────────────────────────────────────────────────────────────────

const STATE_DIR = process.env.FEISHU_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'feishu')
const ACCESS_FILE = join(STATE_DIR, 'access.json')
const ENV_FILE = join(STATE_DIR, '.env')
const DEBUG_LOG = join(STATE_DIR, 'router-debug.log')
const SOCK_PATH = join(STATE_DIR, 'router.sock')

function dbg(msg: string) {
  const line = `${new Date().toISOString()} [router] ${msg}\n`
  process.stderr.write(line)
  try { appendFileSync(DEBUG_LOG, line) } catch {}
}

// Load .env
try {
  chmodSync(ENV_FILE, 0o600)
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = line.match(/^(\w+)=(.*)$/)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2]
  }
} catch {}

const APP_ID = process.env.FEISHU_APP_ID
const APP_SECRET = process.env.FEISHU_APP_SECRET
const ENCRYPT_KEY = process.env.FEISHU_ENCRYPT_KEY ?? ''

if (!APP_ID || !APP_SECRET) {
  process.stderr.write(`feishu router: FEISHU_APP_ID and FEISHU_APP_SECRET required\n  set in ${ENV_FILE}\n`)
  process.exit(1)
}

// ── Access control ──────────────────────────────────────────────────────────

type GroupPolicy = { requireMention: boolean; allowFrom: string[]; workdir?: string }
type Access = {
  dmPolicy: 'pairing' | 'allowlist' | 'disabled'
  allowFrom: string[]
  p2pChats: Record<string, string>
  groups: Record<string, GroupPolicy>
  pending: Record<string, unknown>
  mentionPatterns?: string[]
  ackReaction?: string
  defaultWorkdir?: string
}

function readAccess(): Access {
  try {
    const p = JSON.parse(readFileSync(ACCESS_FILE, 'utf8')) as Partial<Access>
    return {
      dmPolicy: p.dmPolicy ?? 'pairing',
      allowFrom: p.allowFrom ?? [],
      p2pChats: p.p2pChats ?? {},
      groups: p.groups ?? {},
      pending: p.pending ?? {},
      mentionPatterns: p.mentionPatterns,
      ackReaction: p.ackReaction ?? 'Get',
      defaultWorkdir: p.defaultWorkdir,
    }
  } catch {
    return { dmPolicy: 'pairing', allowFrom: [], p2pChats: {}, groups: {}, pending: {}, ackReaction: 'Get' }
  }
}

// ── Feishu API ──────────────────────────────────────────────────────────────

const apiClient = new lark.Client({ appId: APP_ID, appSecret: APP_SECRET, loggerLevel: lark.LoggerLevel.warn })
let botOpenId: string | null = null
async function fetchBotOpenId() {
  try {
    const r = await (apiClient as any).bot.botInfo.get()
    botOpenId = r?.bot?.open_id ?? r?.data?.bot?.open_id ?? null
    if (botOpenId) dbg(`bot open_id = ${botOpenId}`)
  } catch (e) { dbg(`could not fetch bot open_id: ${e}`) }
}

function checkMention(mentions: any[], text: string, patterns?: string[]): boolean {
  for (const m of mentions) {
    if (m.mentioned_type === 'bot') return true
    if (botOpenId && m.id?.open_id === botOpenId) return true
  }
  for (const p of patterns ?? []) { try { if (new RegExp(p, 'i').test(text)) return true } catch {} }
  return false
}

// ── Worker registry (Unix socket) ───────────────────────────────────────────

type Worker = { socket: Socket; workdir: string; buf: string }

const workers = new Map<Socket, Worker>()

/** Find worker whose workdir matches the target. */
function findWorker(workdir: string): Worker | undefined {
  const target = resolve(workdir)
  for (const w of workers.values()) {
    if (resolve(w.workdir) === target) return w
  }
  return undefined
}

function sendToWorker(w: Worker, payload: Record<string, unknown>) {
  try { w.socket.write(JSON.stringify(payload) + '\n') } catch (e) { dbg(`send failed: ${e}`) }
}

/** Route a payload to the worker matching the given workdir. Returns true if delivered. */
function routeToWorkdir(workdir: string, payload: Record<string, unknown>): boolean {
  const w = findWorker(workdir)
  if (!w) { dbg(`no worker for workdir ${workdir}`); return false }
  sendToWorker(w, payload)
  return true
}

/** Shut down router if no workers remain after a grace period. */
let idleTimer: ReturnType<typeof setTimeout> | null = null
const IDLE_GRACE_MS = 10_000  // wait 10s before shutting down

function scheduleIdleShutdown() {
  if (idleTimer) clearTimeout(idleTimer)
  if (workers.size > 0) return
  idleTimer = setTimeout(() => {
    if (workers.size === 0) {
      dbg('all workers disconnected, shutting down')
      shutdown()
    }
  }, IDLE_GRACE_MS)
}

const sockServer = createServer((socket) => {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null }
  const w: Worker = { socket, workdir: '', buf: '' }
  workers.set(socket, w)
  dbg(`worker connected (${workers.size} total)`)

  socket.on('data', (chunk) => {
    w.buf += chunk.toString()
    let idx: number
    while ((idx = w.buf.indexOf('\n')) !== -1) {
      const line = w.buf.slice(0, idx)
      w.buf = w.buf.slice(idx + 1)
      if (!line.trim()) continue
      try {
        const msg = JSON.parse(line)
        if (msg.type === 'register' && msg.workdir) {
          w.workdir = resolve(msg.workdir)
          dbg(`worker registered: ${w.workdir}`)
        }
      } catch (e) { dbg(`bad message from worker: ${e}`) }
    }
  })

  socket.on('close', () => {
    workers.delete(socket)
    dbg(`worker disconnected: ${w.workdir} (${workers.size} remaining)`)
    scheduleIdleShutdown()
  })

  socket.on('error', (e) => {
    dbg(`worker socket error: ${e}`)
    workers.delete(socket)
    scheduleIdleShutdown()
  })
})

// ── Message routing ─────────────────────────────────────────────────────────

function resolveWorkdir(chatId: string, chatType: string): string | undefined {
  const access = readAccess()
  if (chatType === 'group') {
    const wd = access.groups[chatId]?.workdir
    if (wd) return wd
  }
  return access.defaultWorkdir
}

async function handleInbound(data: any) {
  const ev = data.event ?? data
  const sender = ev.sender, message = ev.message
  if (!sender || !message) return

  const senderId: string = sender.sender_id?.open_id ?? ''
  const chatId: string = message.chat_id ?? ''
  const chatType: string = message.chat_type ?? 'p2p'
  const messageId: string = message.message_id ?? ''
  const msgType: string = message.message_type ?? (message as any).msg_type ?? 'text'
  const contentStr: string = message.content ?? message.body?.content ?? ''
  const mentions: any[] = message.mentions ?? []
  const createTime: string = message.create_time ?? ''
  if (!senderId || !chatId || !messageId) return

  let text = ''
  try { text = JSON.parse(contentStr).text ?? '' } catch { text = contentStr }

  const access = readAccess()

  // Access check
  if (chatType === 'p2p') {
    if (!access.allowFrom.includes(senderId)) { dbg(`dm from unknown ${senderId}, dropping`); return }
  } else {
    const policy = access.groups[chatId]
    if (!policy) { dbg(`group ${chatId} not configured, dropping`); return }
    if (policy.allowFrom.length > 0 && !policy.allowFrom.includes(senderId)) return
    const mentioned = checkMention(mentions, text, access.mentionPatterns)
    if ((policy.requireMention ?? true) && !mentioned) return
  }

  // Ack reaction
  if (access.ackReaction) {
    void (apiClient as any).im.messageReaction.create({
      path: { message_id: messageId },
      data: { reaction_type: { emoji_type: access.ackReaction } },
    }).catch(() => {})
  }

  // Build attachment info
  const atts: string[] = []
  if (msgType === 'file') { try { const c = JSON.parse(contentStr); atts.push(`${c.file_name ?? 'file'} (file, key:${c.file_key ?? ''})`) } catch {} }
  else if (msgType === 'image') { try { const c = JSON.parse(contentStr); atts.push(`image (image/jpeg, key:${c.image_key ?? ''})`) } catch {} }

  const ts = createTime
    ? new Date(parseInt(createTime) > 1e12 ? parseInt(createTime) : parseInt(createTime) * 1000).toISOString()
    : new Date().toISOString()
  const content = text || (atts.length ? '(attachment)' : '')
  if (!content) return

  const workdir = resolveWorkdir(chatId, chatType)
  if (!workdir) { dbg(`no workdir for ${chatId}, dropping`); return }

  dbg(`routing ${chatId} (${chatType}) → ${workdir}`)
  const delivered = routeToWorkdir(workdir, {
    type: 'channel_message',
    content,
    meta: {
      chat_id: chatId,
      message_id: messageId,
      user: senderId,
      user_id: senderId,
      ts,
      chat_type: chatType,
      ...(atts.length ? { attachment_count: String(atts.length), attachments: atts.join('; ') } : {}),
    },
  })
  if (!delivered) {
    const hint = `⚠️ 该群绑定的项目 \`${workdir}\` 还没有启动 Claude Code 会话。请在该目录下运行 \`claude-feishu\` 后再发消息。`
    void (apiClient as any).im.message.reply({
      path: { message_id: messageId },
      data: { msg_type: 'text', content: JSON.stringify({ text: hint }), reply_in_thread: false },
    }).catch((e: unknown) => dbg(`no-worker hint reply failed: ${e}`))
  }
}

async function handleCardAction(data: any): Promise<Record<string, unknown>> {
  const value = data?.action?.value ?? {}
  const code = value.code as string | undefined
  const action = value.action as string | undefined
  if (!code || !action) return {}

  // Find the worker that sent this card — route by chat_id or broadcast
  const chatId = data?.open_chat_id ?? ''
  const workdir = chatId ? resolveWorkdir(chatId, 'group') ?? resolveWorkdir(chatId, 'p2p') : undefined

  if (action === 'perm_allow' || action === 'perm_deny') {
    const behavior = action === 'perm_deny' ? 'deny' : 'allow'
    const payload = { type: 'permission_response', request_id: code, behavior }
    if (workdir) routeToWorkdir(workdir, payload)
    else for (const w of workers.values()) sendToWorker(w, payload) // broadcast if unknown

    const statusText = behavior === 'allow' ? '✅ 已允许' : '❌ 已拒绝'
    return {
      toast: { type: behavior === 'deny' ? 'info' : 'success', content: statusText },
      card: {
        type: 'raw',
        data: {
          schema: '2.0', config: { wide_screen_mode: true },
          header: { title: { tag: 'plain_text', content: `🔐 Permission Request — ${statusText}` }, template: behavior === 'deny' ? 'grey' : 'green' },
          body: { elements: [{ tag: 'hr' }, { tag: 'markdown', content: `**${statusText}**` }] },
        },
      },
    }
  }

  if (action === 'confirm' || action === 'cancel') {
    const isConfirm = action === 'confirm'
    const payload = {
      type: 'confirm_response',
      content: isConfirm ? `CONFIRMED ${code}` : `CANCELLED ${code}`,
      meta: {
        chat_id: chatId || 'system',
        message_id: `card-${Date.now()}`,
        user: 'system',
        user_id: 'system',
        ts: new Date().toISOString(),
        chat_type: 'p2p',
      },
    }
    if (workdir) routeToWorkdir(workdir, payload)
    else for (const w of workers.values()) sendToWorker(w, payload)

    const statusText = isConfirm ? '✅ 已确认' : '❌ 已取消'
    return {
      toast: { type: isConfirm ? 'success' : 'info', content: statusText },
      card: {
        type: 'raw',
        data: {
          schema: '2.0', config: { wide_screen_mode: true },
          header: { title: { tag: 'plain_text', content: `⚡ 操作确认 — ${statusText}` }, template: isConfirm ? 'green' : 'grey' },
          body: { elements: [{ tag: 'hr' }, { tag: 'markdown', content: `**${statusText}**` }] },
        },
      },
    }
  }

  return {}
}

// ── Startup ─────────────────────────────────────────────────────────────────

dbg('router starting')
mkdirSync(STATE_DIR, { recursive: true })
await fetchBotOpenId()

// Clean up stale socket
if (existsSync(SOCK_PATH)) { try { unlinkSync(SOCK_PATH) } catch {} }

sockServer.listen(SOCK_PATH, () => {
  chmodSync(SOCK_PATH, 0o600)
  dbg(`unix socket listening: ${SOCK_PATH}`)
})

const wsClient = new lark.WSClient({ appId: APP_ID, appSecret: APP_SECRET, loggerLevel: lark.LoggerLevel.warn })
const dispatcher = new lark.EventDispatcher({ encryptKey: ENCRYPT_KEY }).register({
  'im.message.receive_v1': async (data: any) => {
    dbg('im.message.receive_v1 fired')
    return handleInbound(data).catch(e => dbg(`handleInbound failed: ${e}`))
  },
  'card.action.trigger': async (data: any) => {
    dbg('card.action.trigger fired')
    return handleCardAction(data).catch(e => { dbg(`handleCardAction failed: ${e}`); return {} })
  },
})

wsClient.start({ eventDispatcher: dispatcher }).catch(e => dbg(`wsClient error: ${e}`))

// Status on SIGUSR1
process.on('SIGUSR1', () => {
  const lines = [`\n=== Router Status ===`, `workers: ${workers.size}`]
  for (const w of workers.values()) {
    lines.push(`  ${w.workdir}`)
  }
  dbg(lines.join('\n'))
})

let shuttingDown = false
function shutdown() {
  if (shuttingDown) return; shuttingDown = true
  dbg('shutting down')
  sockServer.close()
  try { unlinkSync(SOCK_PATH) } catch {}
  try { (wsClient as any).disconnect?.() } catch {}
  setTimeout(() => process.exit(0), 2000)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

const access = readAccess()
const groupCount = Object.keys(access.groups).length
dbg(`router ready — ${groupCount} groups, defaultWorkdir=${access.defaultWorkdir ?? '(none)'}`)

// Keep alive
await new Promise(() => {})
