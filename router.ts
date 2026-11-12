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
import { randomBytes } from 'crypto'
import {
  readFileSync, writeFileSync, appendFileSync, mkdirSync, chmodSync, unlinkSync, existsSync, readdirSync, statSync,
} from 'fs'
import { homedir, tmpdir } from 'os'
import { join, resolve } from 'path'
import { acquireRouterLock, releaseRouterLock } from './router-lock'
import {
  deleteTmuxSessionId, getTmuxSessionId, markEventProcessed, openDb, PermissionRegistry,
  pruneProcessedEvents, setTmuxSessionId, SqliteBindingStore, wasEventProcessed,
} from './routing/storage'
import { loadRouterConfig, RouterConfigError } from './routing/config'
import { resolveRoute } from './routing/resolver'
import { conversationKey } from './routing/bindings'
import type { AgentPolicy, RouterConfig } from './routing/types'
import { OpenCodeAdapter } from './adapters/opencode/opencode-adapter'
import type { AgentEvent } from './adapters/agent-adapter'
import { createBinding } from './routing/bindings'
import { chunkText, MAX_CHUNK } from './chunk-text'
import { DegradedTracker } from './routing/degraded'
import { MAX_ATTACHMENT_BYTES, sendFeishuFile } from './feishu-attachment'
import { downloadFeishuResource } from './feishu-download'
import { renderPaneScreenshot } from './pane-screenshot'
import { decodeBase64DataUri } from './data-uri'
import { TmuxClaudeManager, DIALOG_ESCAPE_CHOICE, DIALOG_TIMED_OUT_CHOICE, type Dialog, type ProgressEvent } from './claude-tmux-worker'

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

/** Axios (used by the Feishu SDK) hides the actual API error body behind `e.message`, which is just "Request failed with status code 400". Surfaces `e.response.data` too so a failed Feishu API call is debuggable from the log instead of needing to be reproduced by hand. */
function describeApiError(e: unknown): string {
  const data = (e as any)?.response?.data
  return data ? `${e} — ${JSON.stringify(data)}` : String(e)
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
      onWarn: dbg,
    })
  : null

// ── SQLite state (opened early: tmuxClaude below needs it for session-id persistence) ──
mkdirSync(STATE_DIR, { recursive: true })
const db = openDb(DB_PATH)
const permissionRegistry = new PermissionRegistry(db)
const openCodeBindings = new SqliteBindingStore(db)

/**
 * workdir -> tmux --session-id, persisted so a router restart can reattach
 * to an already-running tmux session's exact transcript file instead of
 * guessing by "most recently modified .jsonl in this workdir" (ambiguous if
 * the user ever has another Claude Code session open in the same
 * directory outside this tmux session). The tmux session itself survives a
 * router restart untouched — tmux is a separate daemon — only this
 * router-side bookkeeping is lost from memory, which is what this
 * persists.
 */
const tmuxSessionStore = {
  get: (workdir: string) => getTmuxSessionId(db, workdir),
  set: (workdir: string, sessionId: string) => setTmuxSessionId(db, workdir, sessionId, new Date().toISOString()),
  delete: (workdir: string) => deleteTmuxSessionId(db, workdir),
}
const tmuxClaude = new TmuxClaudeManager({ dbg, persistence: tmuxSessionStore })

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

// Extension used for the temp file we write before handing it to sendFeishuFile
// (which branches image-vs-file by extension, via feishu-attachment.ts's
// IMAGE_EXTS/FEISHU_FTYPES) — only needs to cover mime types OpenCode tools
// actually produce; falls back to the mime subtype for anything else.
const MIME_EXT: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'application/pdf': 'pdf',
}

/** Decode a tool-produced `data:` attachment (e.g. a screenshot) and send it to Feishu as an image or file message. */
async function sendOpenCodeAttachment(chatId: string, mime: string, dataUrl: string, filename: string | undefined, dbgTag: string) {
  const decoded = decodeBase64DataUri(dataUrl, MAX_ATTACHMENT_BYTES)
  if (!decoded.ok) {
    dbg(decoded.reason === 'too_large'
      ? `${dbgTag}: attachment exceeds ${MAX_ATTACHMENT_BYTES} bytes, skipping`
      : `${dbgTag}: attachment data URI isn't base64-encoded, skipping (unsupported for now)`)
    return
  }
  const ext = MIME_EXT[mime] ?? mime.split('/')[1]?.replace(/[^a-z0-9]/gi, '') ?? 'bin'
  const tmpPath = join(tmpdir(), `oc-attach-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`)
  try {
    writeFileSync(tmpPath, decoded.buf)
    await sendFeishuFile(apiClient, chatId, tmpPath, filename)
  } catch (e) {
    dbg(`${dbgTag}: attachment upload failed: ${e}`)
  } finally {
    try { unlinkSync(tmpPath) } catch (e) { dbg(`${dbgTag}: failed to clean up temp attachment file ${tmpPath}: ${e}`) }
  }
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
  const attachments: Extract<AgentEvent, { type: 'attachment.completed' }>[] = []
  // A tool can produce an attachment (e.g. a screenshot) in an earlier step of the
  // same turn that later fails/aborts — that capture is still real and worth
  // sending, so every early-return path flushes whatever was collected so far
  // instead of silently dropping it.
  const flushAttachments = () => Promise.all(
    attachments.map(att => sendOpenCodeAttachment(chatId, att.mime, att.dataUrl, att.filename, `opencode: task ${taskId}`)),
  )
  try {
    for await (const event of openCodeAdapter.send({ taskId, sessionId, prompt: content }, controller.signal)) {
      if (event.type === 'permission.requested') {
        void handleOpenCodePermission(event, chatId)
      } else if (event.type === 'text.completed') {
        finalText = event.text
      } else if (event.type === 'attachment.completed') {
        attachments.push(event)
      } else if (event.type === 'task.failed') {
        dbg(`opencode: task ${taskId} failed: ${event.reason}`)
        // The cached session may no longer be valid (e.g. opencode serve
        // restarted and forgot it) — evict so the next message gets a fresh
        // one instead of repeating the same failure forever.
        openCodeBindings.delete(key)
        void replyText(chatId, messageId, `⚠️ OpenCode 执行失败：${event.reason}`)
        await flushAttachments()
        return
      } else if (event.type === 'task.aborted') {
        void replyText(chatId, messageId, `⚠️ OpenCode 任务被中断`)
        await flushAttachments()
        return
      }
    }
  } catch (e) {
    dbg(`opencode: send() threw: ${e}`)
    openCodeBindings.delete(key)
    void replyText(chatId, messageId, `⚠️ OpenCode 执行出错：${e}`)
    await flushAttachments()
    return
  }

  if (finalText) {
    for (const chunk of chunkText(finalText, MAX_CHUNK)) await replyText(chatId, messageId, chunk)
  } else if (attachments.length === 0) {
    dbg(`opencode: task ${taskId} completed with no text output`)
  }
  await flushAttachments()
}

const TMUX_ATTACHMENT_DIR = join(tmpdir(), 'feishu-claude-tmux-attachments')
const TMUX_ATTACHMENT_RETENTION_MS = 24 * 3600 * 1000

/** Downloaded attachments are kept (the CLI may Read one well after the task that received it finishes), so without this they'd accumulate here forever. */
function pruneOldTmuxAttachments() {
  if (!existsSync(TMUX_ATTACHMENT_DIR)) return
  const cutoffMs = Date.now() - TMUX_ATTACHMENT_RETENTION_MS
  let pruned = 0
  for (const name of readdirSync(TMUX_ATTACHMENT_DIR)) {
    const path = join(TMUX_ATTACHMENT_DIR, name)
    try {
      if (statSync(path).mtimeMs < cutoffMs) { unlinkSync(path); pruned++ }
    } catch (e) { dbg(`claude-tmux: failed to prune attachment ${path}: ${e}`) }
  }
  if (pruned) dbg(`claude-tmux: pruned ${pruned} old attachment file(s)`)
}

/**
 * `number: -2` is the "explicitly cancelled" sentinel for cancelPendingTmuxDialogs
 * (used by `/esc`/`/restart`, which have already dealt with the session their
 * own way) — distinct from claude-tmux-worker.ts's own DIALOG_TIMED_OUT_CHOICE
 * (-1, used below when a card's own timer fires with no click at all) so it
 * can tell the two apart and only send an automatic Escape for a genuine
 * timeout, not a redundant one on top of what /esc/`/restart` already did.
 */
const TMUX_DIALOG_CANCELLED = -2
const TMUX_DIALOG_TIMEOUT_MS = 30 * 60 * 1000
const TMUX_PENDING_DIALOGS = new Map<string, { workdir: string; resolve: (choice: number) => void }>()

/** Cancel any dialog(s) still awaiting a Feishu click for this workdir — e.g. before `/restart` kills the session the eventual click would otherwise hit, or `/esc` dismisses the CLI's own menu directly instead. Without this, the stale sendAndAwaitReply call for the old dialog would sit in its per-workdir queue forever, blocking every later message to this workdir. */
function cancelPendingTmuxDialogs(workdir: string) {
  for (const [code, entry] of TMUX_PENDING_DIALOGS) {
    if (entry.workdir !== workdir) continue
    TMUX_PENDING_DIALOGS.delete(code)
    entry.resolve(TMUX_DIALOG_CANCELLED)
  }
}

/** True while a permission/tab-switch dialog card is still awaiting a click for this workdir — the "thinking…" status card must not patch itself while one of those is up, both because the CLI isn't actually making progress (it's blocked on the user) and to avoid two unrelated cards fighting for the chat's attention at once. */
function hasPendingDialogFor(workdir: string): boolean {
  for (const entry of TMUX_PENDING_DIALOGS.values()) {
    if (entry.workdir === workdir) return true
  }
  return false
}

function buildTmuxDialogCard(dialog: Dialog, code: string): string {
  return JSON.stringify({
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: '❓ Claude 需要你选择' }, template: 'orange' },
    body: {
      elements: [
        { tag: 'markdown', content: dialog.question },
        { tag: 'hr' },
        // Schema 2.0 dropped the old `tag: 'action'` button-row wrapper
        // (confirmed live: Feishu returns a 400 "unsupported tag action" for
        // it) — each button is now its own full-width column_set row, which
        // also stacks cleanly regardless of how many options there are.
        //
        // A fixed "just press Escape instead" row follows the real options,
        // since this is a best-effort scrape of a terminal UI — always leave
        // a safe way out even if none of the parsed options are what the
        // user wants.
        // For a 'tabs' dialog, dialog.currentNumber marks the tab believed
        // to be focused right now (see claude-tmux-worker.ts) — highlight
        // that one instead of always the first option, and label it so the
        // card itself shows which tab a repeat click will start switching
        // from.
        ...[...dialog.options.map(o => {
          const isCurrent = dialog.kind === 'tabs' ? o.number === dialog.currentNumber : o.number === '1'
          return { number: o.number, label: `${o.number}. ${o.label}${isCurrent ? ' 📍当前' : ''}`, type: isCurrent ? 'primary' : 'default' }
        }), { number: String(DIALOG_ESCAPE_CHOICE), label: '🚪 Esc', type: 'danger' }].map(({ number, label, type }) => ({
          tag: 'column_set',
          columns: [{
            tag: 'column',
            width: 'weighted',
            weight: 1,
            elements: [{
              tag: 'button',
              text: { tag: 'plain_text', content: label },
              type,
              value: { code, action: 'tmux_dialog_choice', number },
              width: 'fill',
            }],
          }],
        })),
      ],
    },
  })
}

/**
 * Builds the onDialog callback TmuxClaudeManager calls when a session is
 * stuck on an interactive menu (permission prompt, etc.) — sends a Feishu
 * card with one button per option and resolves once handleCardAction routes
 * a click back here via TMUX_PENDING_DIALOGS. The resulting keypress is sent
 * by claude-tmux-worker.ts itself; this only has to supply the choice.
 *
 * Bounded by TMUX_DIALOG_TIMEOUT_MS: an unanswered card would otherwise
 * leave sendAndAwaitReply's per-workdir queue stuck forever (every later
 * message to this workdir piles up behind it) and leak this Map entry for
 * the life of the process.
 */
function makeTmuxDialogHandler(workdir: string, chatId: string, messageId: string) {
  return async (dialog: Dialog): Promise<number> => {
    const code = randomBytes(5).toString('hex')
    dbg(`claude-tmux: dialog detected ("${dialog.question}"), sending choice card ${code}`)
    try {
      await (apiClient as any).im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: chatId, msg_type: 'interactive', content: buildTmuxDialogCard(dialog, code) },
      })
    } catch (e) { dbg(`claude-tmux: dialog card send failed: ${describeApiError(e)}`) }
    return new Promise<number>(resolve => {
      const timer = setTimeout(() => {
        if (!TMUX_PENDING_DIALOGS.delete(code)) return  // already resolved by a real click
        dbg(`claude-tmux: dialog ${code} for ${workdir} timed out waiting for a Feishu click`)
        void replyText(chatId, messageId, '⚠️ 等待选择超时，已取消本次操作，可以重新发送消息。')
        resolve(DIALOG_TIMED_OUT_CHOICE)
      }, TMUX_DIALOG_TIMEOUT_MS)
      TMUX_PENDING_DIALOGS.set(code, {
        workdir,
        resolve: (choice) => { clearTimeout(timer); resolve(choice) },
      })
    })
  }
}

/**
 * Builds the onStuckPane callback: renders the ANSI pane capture to a PNG
 * (pane-screenshot.ts) and sends it as an image — for a stuck state
 * parseDialogOptions can't turn into a card (a `/status`-style tab panel,
 * for instance, whose "currently selected" state is color-only and whose
 * tabs cycle circularly with no numbered jump target, so there's no way to
 * compute "click this button to land on that tab" from plain text alone).
 * Silently does nothing if no cached Chromium build is available on this
 * machine (see renderPaneScreenshot) — this is a nice-to-have, not core
 * functionality worth erroring the whole task over.
 */
/** Shared by onStuckPane and onTabSwitched — both just need "render this pane capture and send it as an image", differing only in when claude-tmux-worker.ts decides to call them. */
async function sendPaneScreenshot(chatId: string, paneAnsiText: string, dbgTag: string): Promise<void> {
  const png = await renderPaneScreenshot(paneAnsiText)
  if (!png) { dbg(`${dbgTag}: screenshot unavailable (no cached Chromium build)`); return }
  const pngPath = join(tmpdir(), `claude-tmux-pane-${Date.now()}-${Math.random().toString(36).slice(2)}.png`)
  try {
    writeFileSync(pngPath, png)
    await sendFeishuFile(apiClient, chatId, pngPath, 'claude-session.png')
  } finally {
    try { unlinkSync(pngPath) } catch (e) { dbg(`${dbgTag}: failed to clean up pane screenshot ${pngPath}: ${e}`) }
  }
}

function makeStuckPaneHandler(chatId: string) {
  return (paneAnsiText: string) => sendPaneScreenshot(chatId, paneAnsiText, 'claude-tmux: stuck-pane')
}

/**
 * Builds the onTabSwitched callback: after claude-tmux-worker.ts presses
 * Right the approximated number of times for a tab choice, sends a
 * screenshot of wherever that actually landed — since parseTabBar can't
 * confirm which tab is now focused from plain text alone (see its "assumed
 * leftmost tab" caveat), this is the only way for the user to see whether
 * the switch landed where they expected. A fresh choice card for the same
 * tabs follows automatically once the still-visible tab bar is re-detected
 * on claude-tmux-worker.ts's next poll — no action needed here for that.
 */
function makeTabSwitchedHandler(chatId: string) {
  return (paneAnsiText: string) => sendPaneScreenshot(chatId, paneAnsiText, 'claude-tmux: tab-switched')
}

/** Must carry `config.update_multi: true` — without it, `im.message.patch` below rejects the update entirely (that flag is the opt-in that allows a card already delivered to a chat to be edited in place at all). */
function buildStatusCard(line: string): string {
  return JSON.stringify({
    schema: '2.0',
    config: { update_multi: true },
    header: { title: { tag: 'plain_text', content: 'Claude' }, template: 'blue' },
    body: { elements: [{ tag: 'markdown', content: line }] },
  })
}

async function patchStatusCard(messageId: string, line: string, dbgTag: string): Promise<void> {
  try {
    await (apiClient as any).im.message.patch({
      path: { message_id: messageId },
      data: { content: buildStatusCard(line) },
    })
  } catch (e) { dbg(`${dbgTag}: status card patch failed: ${describeApiError(e)}`) }
}

const STATUS_CARD_PATCH_COOLDOWN_MS = 1_500

/**
 * How often the status card re-patches itself with an elapsed-time tick even
 * when no new tool_use event has arrived. A single long-running tool call
 * (a multi-minute bash/pytest run, say) produces exactly one progress event
 * at its start and nothing else until it finishes — without this, the card
 * would sit on that one line, unchanged, for the whole duration, which reads
 * as "stuck" even though the CLI is still working.
 */
const STATUS_CARD_HEARTBEAT_MS = 15_000

function formatElapsed(startMs: number): string {
  const s = Math.floor((Date.now() - startMs) / 1000)
  if (s < 60) return `${s}秒`
  return `${Math.floor(s / 60)}分${s % 60}秒`
}

/**
 * Creates a "🤔 思考中…" card for one claude-tmux task and returns a
 * controller claude-tmux-worker.ts's `onProgress` feeds tool_use events
 * into, plus `finalize()` to call once the task is done.
 *
 * Patches are throttled to at most one every STATUS_CARD_PATCH_COOLDOWN_MS:
 * onProgress can fire on every ~400ms transcript poll, far more often than
 * Feishu needs to see (patch is rate-limited server-side too) — each patch
 * always carries the *latest* known line, never a queued backlog, since
 * only the current state is worth showing.
 *
 * Paused entirely while a permission/tab-switch dialog card is pending for
 * this workdir (see hasPendingDialogFor): the CLI isn't making progress
 * then, it's blocked on the user, and that dialog card is already the
 * thing asking for their attention — two unrelated cards fighting for the
 * same chat's focus would be worse than just staying quiet.
 */
function makeStatusCardController(chatId: string, workdir: string) {
  let messageId: string | null = null
  let latestLine = '🤔 思考中…'
  let lastPatchMs = 0
  let pendingTimer: ReturnType<typeof setTimeout> | null = null
  let finalized = false
  const startMs = Date.now()

  const ready: Promise<string | null> = (async () => {
    try {
      const r = await (apiClient as any).im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: chatId, msg_type: 'interactive', content: buildStatusCard(latestLine) },
      })
      return r?.data?.message_id ?? r?.message_id ?? null
    } catch (e) {
      dbg(`claude-tmux: status card create failed: ${describeApiError(e)}`)
      return null
    }
  })().then(id => { messageId = id; return id })

  async function flush() {
    if (finalized) return
    await ready
    if (!messageId || hasPendingDialogFor(workdir)) return
    lastPatchMs = Date.now()
    await patchStatusCard(messageId, `${latestLine} ⏱ ${formatElapsed(startMs)}`, 'claude-tmux: status card')
  }

  function scheduleFlush() {
    if (pendingTimer || finalized) return
    const wait = Math.max(0, lastPatchMs + STATUS_CARD_PATCH_COOLDOWN_MS - Date.now())
    pendingTimer = setTimeout(() => { pendingTimer = null; void flush() }, wait)
  }

  // Ticks the card even without any new progress event — see
  // STATUS_CARD_HEARTBEAT_MS's doc comment. Cleared in finalize(), so a
  // short-lived task (well under one heartbeat interval) never triggers an
  // extra patch at all.
  const heartbeatTimer: ReturnType<typeof setInterval> = setInterval(() => void flush(), STATUS_CARD_HEARTBEAT_MS)

  return {
    onProgress(events: ProgressEvent[]) {
      if (finalized || !events.length || hasPendingDialogFor(workdir)) return
      const last = events[events.length - 1]
      latestLine = last.summary ? `🔧 ${last.tool}: ${last.summary}` : `🔧 ${last.tool}`
      if (Date.now() - lastPatchMs >= STATUS_CARD_PATCH_COOLDOWN_MS) void flush()
      else scheduleFlush()
    },
    async finalize(line: string) {
      finalized = true
      if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null }
      clearInterval(heartbeatTimer)
      const id = await ready
      if (!id) return
      await patchStatusCard(id, line, 'claude-tmux: status card')
    },
  }
}

/**
 * Claude via tmux (agent.mode: 'tmux') — delivers the message as literal
 * terminal keystrokes to a persistent `claude` CLI session instead of the
 * socket-worker protocol. See claude-tmux-worker.ts's header comment for
 * the known gaps (heuristic turn-completion, etc.) before relying on this
 * in a group.
 *
 * Attachments: unlike the socket-worker path, there's no MCP channel plugin
 * loaded for the tmux CLI to call download_attachment with, so the router
 * downloads them itself and embeds the local path in the message text —
 * the CLI reads them with its own Read tool. Files are left in place (not
 * cleaned up after the task) since the CLI may read them later in the
 * conversation, not necessarily during this exact turn.
 *
 * `/esc` and `/restart` are intercepted here as session-management
 * commands rather than sent into the CLI as chat text — see their own
 * comments below.
 *
 * `tmuxClaude.sendAndAwaitReply` throwing is, by contract (see its own
 * doc comment in claude-tmux-worker.ts), always a *pre-delivery* failure —
 * the message never reached the CLI (tmux new-session or send-keys/
 * paste-buffer itself failed) — so it's provably safe to fall back to
 * OpenCode here, the same "no side effect" guarantee the socket-worker
 * path requires before falling back (see handleInbound's own fallback
 * branch below). A failure *after* delivery is swallowed inside
 * sendAndAwaitReply itself and never reaches this catch.
 */
async function handleClaudeTmuxTask(
  route: NonNullable<ReturnType<typeof resolveRoute>>, chatId: string, messageId: string, chatType: 'p2p' | 'group',
  content: string, ocContent: string,
  attDownloads: { fileKey: string; type: 'file' | 'image'; fileName: string }[],
) {
  const workdir = route.workdir
  const model = route.agent.model
  dbg(`routing ${chatId} → ${workdir} via Claude-tmux`)

  const trimmed = content.trim()
  const selectMatch = trimmed.match(/^\/select\s+(\d+)$/)
  if (trimmed === '/esc' || trimmed === '/restart' || selectMatch) {
    // Cancel any dialog this workdir is still awaiting a Feishu click for
    // *before* acting — otherwise a click that arrives after /restart hits
    // a brand-new, unrelated session under the same name (sessionNameFor is
    // deterministic), and after /esc or /select the old sendAndAwaitReply
    // call would sit forever waiting for a click answering a menu that's
    // already been dismissed/answered directly, blocking every later
    // message to this workdir.
    cancelPendingTmuxDialogs(workdir)
  }
  if (trimmed === '/esc') {
    // Manual recovery: a session stuck on a modal (e.g. /status, or any
    // dialog this code failed to detect) ignores all normal input, so this
    // bypasses sendAndAwaitReply entirely and sends a bare Escape directly.
    await tmuxClaude.sendEscape(workdir)
    void replyText(chatId, messageId, '✅ 已发送 Esc')
    return
  }
  if (trimmed === '/restart') {
    await tmuxClaude.restartSession(workdir, model)
    void replyText(chatId, messageId, '✅ Claude Code (tmux) 已重启')
    return
  }
  if (selectMatch) {
    // Manual fallback for a dialog whose layout parseDialogOptions/
    // parseTabBar doesn't recognize yet, so no Feishu card ever got sent —
    // types the option number and presses Enter directly, same as clicking
    // option N on a card would have.
    const sent = await tmuxClaude.selectOption(workdir, selectMatch[1])
    void replyText(chatId, messageId, sent ? `✅ 已选择选项 ${selectMatch[1]}` : '⚠️ 没有存活的会话，未发送')
    return
  }

  let effectiveContent = content
  if (attDownloads.length > 0) {
    const notes: string[] = []
    for (const att of attDownloads) {
      try {
        const path = await downloadFeishuResource(apiClient, TMUX_ATTACHMENT_DIR, messageId, att.fileKey, att.type, att.fileName)
        notes.push(`[附件已保存: ${path}]`)
      } catch (e) {
        dbg(`claude-tmux: attachment download failed (${att.fileKey}): ${e}`)
        notes.push(`[附件下载失败: ${att.fileName}]`)
      }
    }
    effectiveContent = `${content}\n\n${notes.join('\n')}`
  }
  // A message that's about to be absorbed into an already-in-flight reply
  // (see sendAndAwaitReply's doc comment) doesn't get its own "thinking"
  // card at all — that card would just flash up and immediately flip to
  // "已并入", a second card the chat didn't need. isBusy() is advisory (the
  // in-flight call can settle in the gap before sendAndAwaitReply's own
  // check), so the rare race still gets a real card below once we learn the
  // call wasn't actually absorbed after all.
  let statusCard = tmuxClaude.isBusy(workdir) ? null : makeStatusCardController(chatId, workdir)
  // Lazily backfills statusCard for the rare isBusy() miss — called from
  // both the "turned out not absorbed" and the catch branch below, since
  // either can be the first to discover the call was never absorbed.
  function ensureStatusCard() {
    if (!statusCard) statusCard = makeStatusCardController(chatId, workdir)
    return statusCard
  }
  let absorbed = false
  try {
    const reply = await tmuxClaude.sendAndAwaitReply(workdir, effectiveContent, {
      model,
      onDialog: makeTmuxDialogHandler(workdir, chatId, messageId),
      onStuckPane: makeStuckPaneHandler(chatId),
      onTabSwitched: makeTabSwitchedHandler(chatId),
      onProgress: (events) => statusCard?.onProgress(events),
      // This message arrived while a reply for the same workdir was still
      // in flight — Claude Code absorbs it into that turn itself (see
      // sendAndAwaitReply's doc comment), so the in-flight call's result
      // already answers this message too; don't send it again as a
      // separate reply here.
      onAbsorbed: () => { absorbed = true },
    })
    if (absorbed) {
      if (statusCard) await statusCard.finalize('↪️ 已并入上一条消息的回复')
      else void replyText(chatId, messageId, '↪️ 已并入上一条消息的回复')
      return
    }
    // isBusy() guessed this would absorb but it didn't (the in-flight call
    // settled first) — there's no card yet for what turned out to be a real
    // standalone turn. Every progress tick during the call above was
    // silently dropped (onProgress found statusCard still null), so the
    // card created here goes straight to its final state with no ticks to
    // show for it.
    statusCard = ensureStatusCard()
    if (reply) {
      await statusCard.finalize('✅ 已回复')
      for (const chunk of chunkText(reply, MAX_CHUNK)) await replyText(chatId, messageId, chunk)
    } else {
      await statusCard.finalize('⚠️ 未产生文本回复')
      dbg(`claude-tmux: ${workdir} produced no text reply for ${messageId}`)
    }
  } catch (e) {
    // This message was absorbed into the in-flight call (onAbsorbed already
    // fired above) and that same call is what just threw — the primary
    // message's own catch handles the failure (error reply, OpenCode
    // fallback, etc). Without this check we'd duplicate all of that here
    // too, for a message that was never its own turn.
    if (absorbed) {
      if (statusCard) await statusCard.finalize('↪️ 已并入上一条消息的回复')
      else void replyText(chatId, messageId, '↪️ 已并入上一条消息的回复')
      return
    }
    statusCard = ensureStatusCard()
    if (route.agent.fallback === 'opencode' && infraConfig?.fallback.enabled && openCodeAdapter) {
      // Don't finalize as "failed" here — OpenCode is about to take over and
      // may well deliver a working reply right after, which would otherwise
      // leave a contradictory "执行失败" card sitting next to a real answer.
      await statusCard.finalize('⚠️ 已切换到 OpenCode 处理')
      dbg(`claude-tmux: ${workdir} unavailable (${e}), falling back to OpenCode (pre-delivery, no side effect)`)
      void replyText(chatId, messageId, '⚠️ Claude Code (tmux) 当前不可用，已切换到 OpenCode 处理本次任务。')
      void handleOpenCodeTask(route, chatId, messageId, chatType, ocContent)
      return
    }
    await statusCard.finalize('⚠️ 执行失败')
    dbg(`claude-tmux: task for ${workdir} failed: ${e}`)
    void replyText(chatId, messageId, `⚠️ Claude (tmux) 执行失败：${e}`)
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

  // Build attachment info. attDownloads mirrors atts but keeps the structured
  // (fileKey/type/fileName) shape claude-tmux mode needs to actually fetch
  // the file itself — unlike the socket-worker path, there's no MCP channel
  // plugin loaded in a tmux session for the CLI to call download_attachment with.
  const atts: string[] = []
  const attDownloads: { fileKey: string; type: 'file' | 'image'; fileName: string }[] = []
  if (msgType === 'file') {
    try {
      const c = JSON.parse(contentStr)
      atts.push(`${c.file_name ?? 'file'} (file, key:${c.file_key ?? ''})`)
      if (c.file_key) attDownloads.push({ fileKey: c.file_key, type: 'file', fileName: c.file_name ?? 'file' })
    } catch {}
  } else if (msgType === 'image') {
    try {
      const c = JSON.parse(contentStr)
      atts.push(`image (image/jpeg, key:${c.image_key ?? ''})`)
      if (c.image_key) attDownloads.push({ fileKey: c.image_key, type: 'image', fileName: 'image.png' })
    } catch {}
  }
  for (const k of postImageKeys) {
    atts.push(`image (image/jpeg, key:${k})`)
    attDownloads.push({ fileKey: k, type: 'image', fileName: 'image.png' })
  }

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

  if (route.agent.mode === 'tmux') {
    markEventProcessed(db, messageId, new Date().toISOString())
    void handleClaudeTmuxTask(route, chatId, messageId, chatKind, content, ocContent, attDownloads)
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

  if (action === 'tmux_dialog_choice') {
    const entry = TMUX_PENDING_DIALOGS.get(code)
    const number = Number(value.number)
    if (!entry || !Number.isFinite(number)) {
      return { toast: { type: 'warning', content: '⚠️ 该选择已失效或已处理' } }
    }
    TMUX_PENDING_DIALOGS.delete(code)
    entry.resolve(number)
    const label = number === DIALOG_ESCAPE_CHOICE ? '已发送 Esc' : `已选择第 ${value.number} 项`
    return {
      toast: { type: 'success', content: label },
      card: {
        type: 'raw',
        data: {
          schema: '2.0', config: { wide_screen_mode: true },
          header: { title: { tag: 'plain_text', content: `❓ Claude 需要你选择 — ${label}` }, template: 'green' },
          body: { elements: [{ tag: 'hr' }, { tag: 'markdown', content: `**${label}**` }] },
        },
      },
    }
  }

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

// Unlike a socket worker (whose Claude Code process exits and takes the
// connection down with it), a tmux Claude session just sits there forever
// with nothing to notice it's unused — sweep for idle ones periodically.
const TMUX_IDLE_MS = 60 * 60 * 1000
const TMUX_IDLE_SWEEP_MS = 10 * 60 * 1000
setInterval(() => { void tmuxClaude.killIdleSessions(TMUX_IDLE_MS) }, TMUX_IDLE_SWEEP_MS)
setInterval(pruneOldTmuxAttachments, TMUX_IDLE_SWEEP_MS)

// Keep alive
await new Promise(() => {})
