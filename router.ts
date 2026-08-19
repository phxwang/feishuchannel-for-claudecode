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
import { acquireRouterLock, releaseRouterLock } from './router-lock'
import { markEventProcessed, openDb, PermissionRegistry, pruneProcessedEvents, SqliteBindingStore, wasEventProcessed } from './routing/storage'
import { loadRouterConfig, RouterConfigError } from './routing/config'
import { resolveRoute } from './routing/resolver'
import { conversationKey } from './routing/bindings'
import type { AgentPolicy, RouterConfig } from './routing/types'
import { OpenCodeAdapter } from './adapters/opencode/opencode-adapter'
import type { AgentEvent } from './adapters/agent-adapter'
import { createBinding } from './routing/bindings'
import { chunkText, MAX_CHUNK } from './chunk-text'
import { DegradedTracker } from './routing/degraded'

// ── Config ──────────────────────────────────────────────────────────────────

const STATE_DIR = process.env.FEISHU_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'feishu')
const ACCESS_FILE = join(STATE_DIR, 'access.json')
const ENV_FILE = join(STATE_DIR, '.env')
const DEBUG_LOG = join(STATE_DIR, 'router-debug.log')
const SOCK_PATH = join(STATE_DIR, 'router.sock')
const LOCK_DIR = join(STATE_DIR, 'router.lock')
const DB_PATH = join(STATE_DIR, 'router.db')
const AGENTS_YAML_PATH = join(STATE_DIR, 'agents.yaml')
const AGENTS_ALLOWED_ROOTS = [process.env.FEISHU_PROJECTS_ROOT ?? join(homedir(), 'Projects')]

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

// agents.yaml is the backend/infra config (routing/config.ts RouterConfig) — see
// docs/multi-agent-router-design.md §5. Missing file = legacy Claude-only mode
// (infraConfig stays null, zero behavior change). A *present but invalid* file
// must fail closed: refuse to start rather than run with a partially-valid config.
let infraConfig: RouterConfig | null = null
try {
  infraConfig = loadRouterConfig(AGENTS_YAML_PATH, AGENTS_ALLOWED_ROOTS)
} catch (e) {
  const msg = e instanceof RouterConfigError ? e.message : String(e)
  process.stderr.write(`feishu router: agents.yaml is invalid, refusing to start:\n  ${msg}\n`)
  process.exit(1)
}

const openCodeCfg = infraConfig?.agents.opencode
const openCodeAdapter = openCodeCfg
  ? new OpenCodeAdapter({
      baseUrl: openCodeCfg.baseUrl,
      requestTimeoutSeconds: openCodeCfg.requestTimeoutSeconds,
      taskTimeoutSeconds: openCodeCfg.taskTimeoutSeconds,
      passwordEnv: openCodeCfg.passwordEnv,
    })
  : null

// ── Access control ──────────────────────────────────────────────────────────

type GroupPolicy = { requireMention: boolean; allowFrom: string[]; workdir?: string; agent?: AgentPolicy }
type Access = {
  dmPolicy: 'pairing' | 'allowlist' | 'disabled'
  allowFrom: string[]
  p2pChats: Record<string, string>
  groups: Record<string, GroupPolicy>
  pending: Record<string, unknown>
  mentionPatterns?: string[]
  ackReaction?: string
  defaultWorkdir?: string
  defaultAgent?: AgentPolicy
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
      defaultAgent: p.defaultAgent,
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

/** Fetch the parent message's text so replies keep context when forwarded. */
async function fetchParentQuote(parentId: string): Promise<string> {
  try {
    const r = await (apiClient as any).im.message.get({ path: { message_id: parentId } })
    const items: any[] = r?.items ?? r?.data?.items ?? []
    if (!items.length) return ''
    const m = items[0]
    const raw: string = m.body?.content ?? m.content ?? ''
    let txt = raw
    try { txt = JSON.parse(raw).text ?? raw } catch {}
    const mtype: string = m.msg_type ?? m.message_type ?? ''
    const who: string = m.sender?.id ?? m.sender?.sender_id ?? ''
    const preview = (txt || `[${mtype}]`).replace(/\s+/g, ' ').trim().slice(0, 500)
    return `> [replying to ${who}]: ${preview}\n\n`
  } catch (e) { dbg(`fetchParentQuote failed: ${e}`); return '' }
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

mkdirSync(STATE_DIR, { recursive: true })
const db = openDb(DB_PATH)
const permissionRegistry = new PermissionRegistry(db)
const openCodeBindings = new SqliteBindingStore(db)

type Worker = {
  socket: Socket
  workdir: string
  buf: string
  workerId?: string
  capabilities?: string[]
  protocolVersion?: number
}

const workers = new Map<Socket, Worker>()
/** Workdirs whose Claude Code worker just reported itself rate-limited (see worker-link.ts sendDegraded). */
const degraded = new DegradedTracker()

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
        if (msg.type === 'register' && typeof msg.workdir === 'string') {
          w.workdir = resolve(msg.workdir)
          w.workerId = typeof msg.workerId === 'string' ? msg.workerId : undefined
          w.capabilities = Array.isArray(msg.capabilities) ? msg.capabilities : undefined
          w.protocolVersion = typeof msg.protocolVersion === 'number' ? msg.protocolVersion : undefined
          dbg(`worker registered: ${w.workdir}${w.workerId ? ` (id=${w.workerId}, v${w.protocolVersion ?? '?'})` : ''}`)
        } else if (msg.type === 'callback_registered' && typeof msg.code === 'string' && typeof msg.workdir === 'string') {
          permissionRegistry.register(msg.code, resolve(msg.workdir), typeof msg.taskId === 'string' ? msg.taskId : null, new Date().toISOString())
        } else if (msg.type === 'degraded' && typeof msg.until === 'number') {
          if (w.workdir) {
            degraded.markDegraded(w.workdir, msg.until)
            dbg(`worker degraded: ${w.workdir} until ${new Date(msg.until).toISOString()} (${typeof msg.reason === 'string' ? msg.reason : 'unknown'})`)
          }
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

async function replyText(chatId: string, messageId: string, text: string) {
  try {
    await (apiClient as any).im.message.reply({
      path: { message_id: messageId },
      data: { msg_type: 'text', content: JSON.stringify({ text }), reply_in_thread: false },
    })
  } catch (e) { dbg(`reply failed: ${e}`) }
}

// ── OpenCode task execution ─────────────────────────────────────────────────
// Route-level primary:opencode dispatch, plus the design doc §7 pre-execution
// fallback case: if routeToWorkdir() finds no connected Claude worker at all
// (task never delivered, so no side effect to reconcile), and the route
// declares agent.fallback:'opencode' with agents.yaml's fallback.enabled:true,
// the task is handed to OpenCode instead (see handleInbound below). The richer
// "Claude accepted then failed mid-task" case from the design doc is not
// implemented — that needs real task-state tracking (routing/task-machine.ts
// exists for this but isn't wired in).

// conversationKey -> OpenCode sessionId is persisted in SQLite (openCodeBindings,
// routing/storage.ts SqliteBindingStore) so a session survives a router restart
// instead of living in a bare in-memory Map. `inFlightSessionCreations` is a
// separate, process-local lock: two messages for the same conversation arriving
// close together would otherwise both see no binding yet and both create a
// session, orphaning one — this makes the second one await the first's result.
const inFlightSessionCreations = new Map<string, Promise<string>>()
/** Permission request ids currently awaiting a card response, issued by OpenCode (not a Claude worker). */
const openCodePermissionCodes = new Set<string>()

async function getOrCreateOpenCodeSession(key: string, route: NonNullable<ReturnType<typeof resolveRoute>>): Promise<string> {
  const existing = openCodeBindings.get(key)
  if (existing) return existing.agentSessionId

  const inFlight = inFlightSessionCreations.get(key)
  if (inFlight) return inFlight

  const creation = (async () => {
    const session = await openCodeAdapter!.createSession({ conversationKey: key, projectId: route.project, workdir: route.workdir })
    openCodeBindings.put(createBinding(key, route.project, 'opencode', null, session.sessionId, '1', new Date().toISOString()))
    dbg(`opencode: created session ${session.sessionId} for ${key}`)
    return session.sessionId
  })()
  inFlightSessionCreations.set(key, creation)
  try {
    return await creation
  } finally {
    inFlightSessionCreations.delete(key)
  }
}

function buildOpenCodePermCard(toolName: string, description: string, code: string): string {
  return JSON.stringify({
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: '🔐 OpenCode Permission Request' }, template: 'orange' },
    body: {
      elements: [
        { tag: 'markdown', content: `**Tool:** ${toolName}\n${description}` },
        { tag: 'hr' },
        {
          tag: 'action',
          actions: [
            { tag: 'button', text: { tag: 'plain_text', content: '✅ Allow' }, type: 'primary', value: { code, action: 'perm_allow' } },
            { tag: 'button', text: { tag: 'plain_text', content: '❌ Deny' }, type: 'danger', value: { code, action: 'perm_deny' } },
          ],
        },
      ],
    },
  })
}

async function handleOpenCodePermission(event: Extract<AgentEvent, { type: 'permission.requested' }>, chatId: string) {
  openCodePermissionCodes.add(event.requestId)
  dbg(`opencode: permission requested (${event.toolName}), sending card for ${event.requestId}`)
  try {
    await (apiClient as any).im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: chatId, msg_type: 'interactive', content: buildOpenCodePermCard(event.toolName, event.description, event.requestId) },
    })
  } catch (e) { dbg(`opencode: permission card send failed: ${e}`) }
}

async function handleOpenCodeTask(route: NonNullable<ReturnType<typeof resolveRoute>>, chatId: string, messageId: string, chatType: 'p2p' | 'group', content: string) {
  if (!openCodeAdapter) {
    dbg(`route wants opencode but agents.opencode is not configured, dropping`)
    void replyText(chatId, messageId, '⚠️ OpenCode 未配置，无法处理该消息。')
    return
  }

  const key = conversationKey(
    chatType === 'group' ? { kind: 'group', chatId, projectId: route.project } : { kind: 'p2p', userOpenId: chatId, projectId: route.project },
  )
  let sessionId: string
  try {
    sessionId = await getOrCreateOpenCodeSession(key, route)
  } catch (e) {
    dbg(`opencode: createSession failed: ${e}`)
    void replyText(chatId, messageId, `⚠️ OpenCode 会话创建失败：${e}`)
    return
  }

  const taskId = `oc-${messageId}`
  const controller = new AbortController()
  let finalText = ''
  try {
    for await (const event of openCodeAdapter.send({ taskId, sessionId, prompt: content }, controller.signal)) {
      if (event.type === 'permission.requested') {
        void handleOpenCodePermission(event, chatId)
      } else if (event.type === 'text.completed') {
        finalText = event.text
      } else if (event.type === 'task.failed') {
        dbg(`opencode: task ${taskId} failed: ${event.reason}`)
        // The cached session may no longer be valid (e.g. opencode serve
        // restarted and forgot it) — evict so the next message gets a fresh
        // one instead of repeating the same failure forever.
        openCodeBindings.delete(key)
        void replyText(chatId, messageId, `⚠️ OpenCode 执行失败：${event.reason}`)
        return
      } else if (event.type === 'task.aborted') {
        void replyText(chatId, messageId, `⚠️ OpenCode 任务被中断`)
        return
      }
    }
  } catch (e) {
    dbg(`opencode: send() threw: ${e}`)
    openCodeBindings.delete(key)
    void replyText(chatId, messageId, `⚠️ OpenCode 执行出错：${e}`)
    return
  }

  if (finalText) {
    for (const chunk of chunkText(finalText, MAX_CHUNK)) await replyText(chatId, messageId, chunk)
  } else {
    dbg(`opencode: task ${taskId} completed with no text output`)
  }
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
  // Peek only — recorded as processed further down, once delivery actually succeeds,
  // so a Feishu redelivery of a message that failed to route (no worker connected yet)
  // can still be retried instead of being dropped forever.
  if (wasEventProcessed(db, messageId)) { dbg(`duplicate event ${messageId}, dropping`); return }

  let text = ''
  const postImageKeys: string[] = []
  try {
    const parsed = JSON.parse(contentStr)
    if (msgType === 'post') {
      if (parsed.title) text += parsed.title
      const rows: any[] = Array.isArray(parsed.content) ? parsed.content : []
      for (const row of rows) {
        if (!Array.isArray(row)) continue
        const parts: string[] = []
        for (const seg of row) {
          if (seg?.tag === 'text' && seg.text) parts.push(seg.text)
          else if (seg?.tag === 'a' && seg.text) parts.push(`${seg.text}(${seg.href ?? ''})`)
          else if (seg?.tag === 'at' && (seg.user_name ?? seg.user_id)) parts.push(`@${seg.user_name ?? seg.user_id}`)
          else if (seg?.tag === 'img' && seg.image_key) postImageKeys.push(seg.image_key)
        }
        if (parts.length) text += (text ? '\n' : '') + parts.join(' ')
      }
    } else {
      text = parsed.text ?? ''
    }
  } catch { text = contentStr }

  const access = readAccess()
  const chatKind: 'p2p' | 'group' = chatType === 'group' ? 'group' : 'p2p'

  // Access check
  if (chatKind === 'p2p') {
    if (!access.allowFrom.includes(senderId)) { dbg(`dm from unknown ${senderId}, dropping`); return }
  } else {
    const policy = access.groups[chatId]
    if (!policy) { dbg(`group ${chatId} not configured, dropping`); return }
    if (policy.allowFrom.length > 0 && !policy.allowFrom.includes(senderId)) return
  }

  const route = resolveRoute({ chatType: chatKind, chatId }, infraConfig, access)
  if (!route) { dbg(`no route for ${chatId}, dropping`); return }
  if (route.agentSanitized) dbg(`${chatId}: requested agent was not whitelisted for ${route.workdir}, downgraded to Claude-only`)

  if (chatKind === 'group') {
    const mentioned = checkMention(mentions, text, access.mentionPatterns)
    if (route.requireMention && !mentioned) return
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
  for (const k of postImageKeys) atts.push(`image (image/jpeg, key:${k})`)

  const ts = createTime
    ? new Date(parseInt(createTime) > 1e12 ? parseInt(createTime) : parseInt(createTime) * 1000).toISOString()
    : new Date().toISOString()

  const parentId: string = (message as any).parent_id ?? ''
  const quotePrefix = parentId ? await fetchParentQuote(parentId) : ''
  const body = text || (atts.length ? '(attachment)' : '')
  const content = quotePrefix + body
  if (!content) return

  const workdir = route.workdir
  const ocContent = atts.length ? `${content}\n\n(注意: OpenCode 当前不支持附件，已忽略)` : content

  if (route.agent.primary === 'opencode') {
    dbg(`routing ${chatId} (${chatType}) → ${workdir} via OpenCode`)
    // Mark processed now, at dispatch — not after the task finishes (which can
    // take up to taskTimeoutSeconds). Marking late left a redelivery window
    // where the same Feishu message_id could dispatch a second concurrent
    // OpenCode task before the first one completed.
    markEventProcessed(db, messageId, new Date().toISOString())
    void handleOpenCodeTask(route, chatId, messageId, chatKind, ocContent)
    return
  }

  dbg(`routing ${chatId} (${chatType}) → ${workdir}${parentId ? ' (reply)' : ''}`)
  const rateLimited = degraded.isDegraded(resolve(workdir))
  if (rateLimited) dbg(`${chatId}: ${workdir} is rate-limited, skipping Claude Code attempt`)
  const delivered = !rateLimited && routeToWorkdir(workdir, {
    type: 'channel_message',
    content,
    meta: {
      chat_id: chatId,
      message_id: messageId,
      user: senderId,
      user_id: senderId,
      ts,
      chat_type: chatType,
      ...(parentId ? { parent_id: parentId } : {}),
      ...(atts.length ? { attachment_count: String(atts.length), attachments: atts.join('; ') } : {}),
    },
  })
  if (delivered) {
    markEventProcessed(db, messageId, new Date().toISOString())
  } else if (route.agent.fallback === 'opencode' && infraConfig?.fallback.enabled && openCodeAdapter) {
    // Design doc §7's strictest allowed-fallback case: the task was never
    // delivered to Claude at all — either no worker was connected, or the
    // worker reported itself rate-limited (see worker-link.ts sendDegraded) —
    // so there is provably no side effect and no risk of duplicate execution.
    // Any richer trigger (Claude accepted the task but then failed/hung) is
    // deliberately NOT handled here — that needs real task-state tracking,
    // which isn't wired up yet.
    dbg(`${chatId}: Claude unavailable for ${workdir} (${rateLimited ? 'rate-limited' : 'no worker connected'}), falling back to OpenCode (pre-execution, no side effect)`)
    markEventProcessed(db, messageId, new Date().toISOString())
    void replyText(chatId, messageId, rateLimited
      ? '⚠️ Claude Code 当前已达到使用限额，已切换到 OpenCode 处理本次任务。'
      : '⚠️ Claude Code 当前不可用，已切换到 OpenCode 处理本次任务。')
    void handleOpenCodeTask(route, chatId, messageId, chatKind, ocContent)
  } else {
    const hint = rateLimited
      ? `⚠️ Claude Code hit its usage limit for \`${workdir}\` and hasn't reset yet. Please retry shortly.`
      : `⚠️ No active Claude Code session for \`${workdir}\`. Please run \`claude-feishu\` in that directory, then send your message again.`
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

  // Route precisely by the code the issuing worker registered (routing/storage.ts
  // PermissionRegistry). chat_id lookup is a defensive fallback only for the rare
  // case the registration message was lost in flight — we never broadcast to every
  // connected worker, since that could leak an unrelated project's approval prompt.
  const chatId = data?.open_chat_id ?? ''
  const registered = permissionRegistry.resolve(code)
  const workdir = registered?.workdir ?? (chatId ? resolveWorkdir(chatId, 'group') ?? resolveWorkdir(chatId, 'p2p') : undefined)
  // Only consume the registry entry once delivery actually succeeds — if the worker
  // has gone away, keep it so a retry (or a redelivered click) can still resolve it.
  const consumeIfDelivered = (delivered: boolean) => { if (delivered && registered) permissionRegistry.consume(code) }

  if (action === 'perm_allow' || action === 'perm_deny') {
    const behavior = action === 'perm_deny' ? 'deny' : 'allow'

    // OpenCode permission requests are tracked separately (routed directly to the
    // OpenCode Adapter, not to a Claude worker) — see handleOpenCodePermission.
    if (openCodePermissionCodes.has(code)) {
      // Only remove the code once delivery is confirmed — deleting it first
      // (as the old code did) meant a failed respondPermission call stranded
      // the request: the code was gone from this set, but never registered
      // in permissionRegistry either, so a retry click fell through to the
      // Claude-worker branch below and matched nothing.
      let delivered = true
      try {
        await openCodeAdapter!.respondPermission(code, { requestId: code, behavior })
        openCodePermissionCodes.delete(code)
      } catch (e) {
        delivered = false
        dbg(`opencode respondPermission(${code}) failed: ${e}`)
      }
      const statusText = !delivered ? '⚠️ 发送失败，请重试' : (behavior === 'allow' ? '✅ 已允许' : '❌ 已拒绝')
      return {
        toast: { type: !delivered ? 'warning' : (behavior === 'deny' ? 'info' : 'success'), content: statusText },
        card: {
          type: 'raw',
          data: {
            schema: '2.0', config: { wide_screen_mode: true },
            header: { title: { tag: 'plain_text', content: `🔐 OpenCode Permission — ${statusText}` }, template: !delivered ? 'red' : (behavior === 'deny' ? 'grey' : 'green') },
            body: { elements: [{ tag: 'hr' }, { tag: 'markdown', content: `**${statusText}**` }] },
          },
        },
      }
    }

    const payload = { type: 'permission_response', request_id: code, behavior }
    const delivered = workdir ? routeToWorkdir(workdir, payload) : false
    consumeIfDelivered(delivered)
    if (!delivered) dbg(`callback code ${code} could not be delivered (workdir=${workdir ?? 'unknown'}), not broadcasting`)

    const statusText = !delivered ? '⚠️ 未找到在线实例，请确认对应项目仍在运行后重试' : (behavior === 'allow' ? '✅ 已允许' : '❌ 已拒绝')
    return {
      toast: { type: !delivered ? 'warning' : (behavior === 'deny' ? 'info' : 'success'), content: statusText },
      card: {
        type: 'raw',
        data: {
          schema: '2.0', config: { wide_screen_mode: true },
          header: { title: { tag: 'plain_text', content: `🔐 Permission Request — ${statusText}` }, template: !delivered ? 'red' : (behavior === 'deny' ? 'grey' : 'green') },
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
    const delivered = workdir ? routeToWorkdir(workdir, payload) : false
    consumeIfDelivered(delivered)
    if (!delivered) dbg(`callback code ${code} could not be delivered (workdir=${workdir ?? 'unknown'}), not broadcasting`)

    const statusText = !delivered ? '⚠️ 未找到在线实例，请确认对应项目仍在运行后重试' : (isConfirm ? '✅ 已确认' : '❌ 已取消')
    return {
      toast: { type: !delivered ? 'warning' : (isConfirm ? 'success' : 'info'), content: statusText },
      card: {
        type: 'raw',
        data: {
          schema: '2.0', config: { wide_screen_mode: true },
          header: { title: { tag: 'plain_text', content: `⚡ 操作确认 — ${statusText}` }, template: !delivered ? 'red' : (isConfirm ? 'green' : 'grey') },
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
if (!acquireRouterLock(LOCK_DIR)) {
  dbg('router already owned by another live process; exiting')
  process.exit(0)
}
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
  releaseRouterLock(LOCK_DIR)
  try { (wsClient as any).disconnect?.() } catch {}
  setTimeout(() => process.exit(0), 2000)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
process.on('exit', () => releaseRouterLock(LOCK_DIR))

const access = readAccess()
const groupCount = Object.keys(access.groups).length
dbg(`router ready — ${groupCount} groups, defaultWorkdir=${access.defaultWorkdir ?? '(none)'}`)

// Prune processed_events so a long-running router's SQLite file doesn't grow unbounded.
const PRUNE_INTERVAL_MS = 6 * 3600 * 1000
const PRUNE_RETENTION_MS = 7 * 24 * 3600 * 1000
setInterval(() => {
  const n = pruneProcessedEvents(db, new Date(Date.now() - PRUNE_RETENTION_MS).toISOString())
  if (n) dbg(`pruned ${n} old processed_events rows`)
}, PRUNE_INTERVAL_MS)

// Keep alive
await new Promise(() => {})
